#include "legacy_import.hpp"
#include "file_platform.hpp"
#ifdef _WIN32
#include <windows.h>
#endif
#include <algorithm>
#include <chrono>
#include <map>
#include <limits>
#include <memory>
#include <set>

namespace media::legacy {
namespace {
void check(sqlite3* db, int code) {
    if (code != SQLITE_OK && code != SQLITE_ROW && code != SQLITE_DONE)
        throw std::runtime_error(sqlite3_errmsg(db));
}
void sql(sqlite3* db, const std::string& text) { check(db, sqlite3_exec(db,text.c_str(),nullptr,nullptr,nullptr)); }
std::string quote(const std::string& name) {
    std::string result = "\"";
    for (char ch: name) { result += ch; if (ch == '"') result += '"'; }
    return result + '"';
}
class Statement {
    sqlite3* db_;
public:
    sqlite3_stmt* value = nullptr;
    Statement(sqlite3* db, const std::string& text): db_(db) { check(db,sqlite3_prepare_v2(db,text.c_str(),-1,&value,nullptr)); }
    ~Statement() { sqlite3_finalize(value); }
    Statement(const Statement&) = delete;
    bool next() { const int code = sqlite3_step(value); check(db_,code); return code == SQLITE_ROW; }
    void bind(int n, const Json& item) {
        if (item.is_null()) check(db_,sqlite3_bind_null(value,n));
        else if (item.is_number_integer()) check(db_,sqlite3_bind_int64(value,n,item.get<int64_t>()));
        else if (item.is_number()) check(db_,sqlite3_bind_double(value,n,item.get<double>()));
        else if (item.is_binary()) {
            const auto& bytes = item.get_binary();
            check(db_,sqlite3_bind_blob(value,n,bytes.empty() ? "" : static_cast<const void*>(bytes.data()),static_cast<int>(bytes.size()),SQLITE_TRANSIENT));
        } else { const auto text = item.get<std::string>(); check(db_,sqlite3_bind_text(value,n,text.data(),static_cast<int>(text.size()),SQLITE_TRANSIENT)); }
    }
    Json row() const {
        Json result = Json::object();
        for (int i=0;i<sqlite3_column_count(value);++i) {
            auto& item = result[sqlite3_column_name(value,i)];
            switch (sqlite3_column_type(value,i)) {
            case SQLITE_INTEGER: item=sqlite3_column_int64(value,i); break;
            case SQLITE_FLOAT: item=sqlite3_column_double(value,i); break;
            case SQLITE_TEXT: item=std::string(reinterpret_cast<const char*>(sqlite3_column_text(value,i)),sqlite3_column_bytes(value,i)); break;
            case SQLITE_BLOB: {
                const auto* bytes=static_cast<const uint8_t*>(sqlite3_column_blob(value,i));
                const int size=sqlite3_column_bytes(value,i);
                item=Json::binary(size ? std::vector<uint8_t>(bytes,bytes+size) : std::vector<uint8_t>{}); break;
            }
            default: item=nullptr;
            }
        }
        return result;
    }
};
Json rows(sqlite3* db, const std::string& text) { Statement q(db,text); Json out=Json::array(); while(q.next()) out.push_back(q.row()); return out; }
Json one(sqlite3* db, const std::string& text, const Json& args=Json::array()) {
    Statement q(db,text); for(size_t i=0;i<args.size();++i) q.bind(static_cast<int>(i+1),args[i]);
    return q.next() ? q.row() : Json(nullptr);
}
void run(sqlite3* db, const std::string& text, const Json& args=Json::array()) { (void)one(db,text,args); }
class Connection {
public:
    sqlite3* value=nullptr;
    Connection(const fs::path& path,int flags) {
        const int code=sqlite3_open_v2(pathText(path).c_str(),&value,flags,nullptr);
        if(code!=SQLITE_OK) { const std::string error=value ? sqlite3_errmsg(value) : "无法打开数据库"; if(value) sqlite3_close(value); throw std::runtime_error(error); }
        sqlite3_busy_timeout(value,1000);
        sqlite3_db_config(value,SQLITE_DBCONFIG_TRUSTED_SCHEMA,0,nullptr);
    }
    ~Connection() { sqlite3_close(value); }
    Connection(const Connection&)=delete;
};
struct SourceGuard {
#ifdef _WIN32
    HANDLE value=INVALID_HANDLE_VALUE;
    explicit SourceGuard(const fs::path& path) {
        if(reparse(path) || reparse(path.parent_path())) throw std::runtime_error("旧数据库路径不能是符号链接或目录联接");
        // 拒绝已有写入者，并在整个导入期间阻止旧程序重新打开数据库写入。
        value=CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ | FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(value==INVALID_HANDLE_VALUE) throw std::runtime_error("旧数据库正在使用或无法读取，请退出旧版 JAVM 后重试");
    }
    ~SourceGuard() { if(value!=INVALID_HANDLE_VALUE) CloseHandle(value); }
    bool stillAt(const fs::path& path) const {
        const HANDLE current=CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ | FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(current==INVALID_HANDLE_VALUE) return false;
        BY_HANDLE_FILE_INFORMATION original{},now{};
        const bool same=GetFileInformationByHandle(value,&original) && GetFileInformationByHandle(current,&now) &&
            original.dwVolumeSerialNumber==now.dwVolumeSerialNumber && original.nFileIndexHigh==now.nFileIndexHigh && original.nFileIndexLow==now.nFileIndexLow;
        CloseHandle(current);
        return same;
    }
#else
    explicit SourceGuard(const fs::path& path) {
        if (reparse(path) || reparse(path.parent_path())) throw std::runtime_error("旧数据库路径不能是符号链接");
    }
    // POSIX 没有 Win32 共享写入禁止语义。通过 SQLite 备份获得一致快照，保留源库和侧车。
    bool stillAt(const fs::path&) const { return false; }
#endif
};
struct TemporaryDatabase {
    fs::path path;
    ~TemporaryDatabase() {
        std::error_code error;
        for(const auto* suffix:{"","-wal","-shm","-journal"}) fs::remove(withSuffix(path,suffix),error);
    }
};
void stopIfCancelled(const std::atomic_bool& cancelled) { if(cancelled) throw std::runtime_error("导入已取消，原数据库已保留"); }
struct Interruptible {
    sqlite3* db;
    Interruptible(sqlite3* connection,const std::atomic_bool& cancelled):db(connection) {
        sqlite3_progress_handler(db,1000,[](void* value) { return static_cast<const std::atomic_bool*>(value)->load() ? 1 : 0; },const_cast<std::atomic_bool*>(&cancelled));
    }
    ~Interruptible() { sqlite3_progress_handler(db,0,nullptr,nullptr); }
};
void copy(sqlite3* source,const fs::path& destination,const std::atomic_bool& cancelled,const Progress& progress) {
    const auto partial=withSuffix(destination,".partial");
    TemporaryDatabase cleanup{partial};
    {
    Connection out(partial,SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
    Interruptible interrupt(out.value,cancelled);
    auto* backup=sqlite3_backup_init(out.value,"main",source,"main");
    if(!backup) throw std::runtime_error("无法创建导入前备份");
    int code=SQLITE_OK;
    try {
        while(code==SQLITE_OK) {
            stopIfCancelled(cancelled);
            code=sqlite3_backup_step(backup,128);
            progress("backingUp",sqlite3_backup_pagecount(backup)-sqlite3_backup_remaining(backup),sqlite3_backup_pagecount(backup));
        }
    } catch(...) { sqlite3_backup_finish(backup); throw; }
    const int finished=sqlite3_backup_finish(backup);
    if(code!=SQLITE_DONE || finished!=SQLITE_OK) throw std::runtime_error("数据库备份失败，请退出旧程序并检查可用磁盘空间后重试");
    if(one(out.value,"PRAGMA quick_check")["quick_check"]!="ok") throw std::runtime_error("数据库备份完整性检查失败");
    }
    syncFile(partial);
    moveFile(partial,destination);
}
}
fs::path sourcePath(const fs::path& target) { return target.parent_path().parent_path()/"com.ddmoyu.javm"/"javm.db"; }
Json inspect(const fs::path& target) {
    // 启动探测只读文件及完成记录，不依赖当前片库成功升级，也不创建新库。
    if(!fs::is_regular_file(sourcePath(target)) || !fs::exists(target)) return candidate(nullptr,target);
    try {
        Connection current(target,SQLITE_OPEN_READONLY);
        return candidate(current.value,target);
    } catch(const std::exception& error) {
        throw std::runtime_error("当前片库读取失败，无法确认旧数据是否已导入："+std::string(error.what()));
    }
}
Json candidate(sqlite3* db,const fs::path& target) {
    const auto source=sourcePath(target);
    const bool hasReceipt=db && !one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='javm_legacy_imports'").is_null();
    const bool imported=hasReceipt && !one(db,"SELECT source_path FROM javm_legacy_imports WHERE source_path=?",Json::array({pathKey(source)})).is_null();
    const bool found=!imported && fs::is_regular_file(source);
    const bool hasVideos=db && !one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='works'").is_null();
    return {{"state",found ? "available" : "none"},{"sourcePath",pathText(source)},{"targetPath",pathText(target)},
            {"bytes",found ? fs::file_size(source) : 0},{"currentVideos",hasVideos ? one(db,"SELECT COUNT(*) AS n FROM works")["n"] : Json(0)}};
}
Json importDatabase(sqlite3* db,const fs::path& target,const std::atomic_bool& cancelled,const Progress& progress,const std::function<int64_t(sqlite3*)>& importRows) {
    const auto source=sourcePath(target);
    if(candidate(db,target)["state"]!="available") throw std::runtime_error("未发现需要导入的旧数据库");
    if(fs::equivalent(source,target)) throw std::runtime_error("新旧数据库指向同一文件，不能导入");
    SourceGuard guard(source);
    const auto folder=target.parent_path()/"backups"/("legacy-"+uuid());
    fs::create_directories(folder);
    const auto before=folder/"new-before-import.db", backup=folder/"legacy-original.db";
    bool committed=false;
    try {
        progress("backingUp",0,0);
        {
            Connection old(source,SQLITE_OPEN_READONLY);
            const auto version=one(old.value,"PRAGMA user_version")["user_version"];
            if(version!=2) throw std::runtime_error("仅支持JAVM 0.5.3 的 v2 数据结构，原数据库已保留");
            copy(old.value,backup,cancelled,progress);
        }
        copy(db,before,cancelled,progress);
        progress("preparing",0,0); stopIfCancelled(cancelled);
        Connection imported(backup,SQLITE_OPEN_READONLY);
        Interruptible interrupt(db,cancelled), sourceInterrupt(imported.value,cancelled);
        if(!one(imported.value,"PRAGMA foreign_key_check").is_null()) throw std::runtime_error("旧版关联记录缺失，已保留原数据库和备份");
        sql(db,"BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;");
        int64_t count=0;
        try {
            count=importRows(imported.value);
            progress("checking",0,0);
            if(one(db,"PRAGMA quick_check")["quick_check"]!="ok" || !one(db,"PRAGMA foreign_key_check").is_null()) throw std::runtime_error("导入后的数据校验失败，已回滚");
            run(db,"INSERT INTO javm_legacy_imports(source_path,backup_path,imported_rows) VALUES(?,?,?)",Json::array({pathKey(source),pathText(backup),count}));
            stopIfCancelled(cancelled);
            sql(db,"COMMIT;"); committed=true;
        } catch(...) { sqlite3_progress_handler(db,0,nullptr,nullptr); sqlite3_exec(db,"ROLLBACK",nullptr,nullptr,nullptr); throw; }
        progress("cleaningUp",0,0);
        std::string warning;
        std::error_code ec;
        // 先移除主文件，再清理其配套文件；不触碰图片、配置或整个旧目录。
        if(!guard.stillAt(source) || !fs::remove(source,ec) || ec) warning="旧数据已导入，原数据库及配套文件已保留。完成记录已保存，下次启动不会重复提醒。";
        else for(const auto* suffix:{"-wal","-shm","-journal"}) { fs::remove(withSuffix(source,suffix),ec); if(ec) warning="旧数据库已移除，部分配套文件未能清理；不会重复导入。"; }
        return {{"state","completed"},{"sourcePath",pathText(source)},{"backupPath",pathText(backup)},
                {"targetBackupPath",pathText(before)},{"importedRows",count},{"warning",warning}};
    } catch(...) {
        if(!committed) { sqlite3_exec(db,"DROP TABLE IF EXISTS temp.javm_import_ids; DROP TABLE IF EXISTS temp.javm_import_paths;",nullptr,nullptr,nullptr); }
        throw;
    }
}
}
