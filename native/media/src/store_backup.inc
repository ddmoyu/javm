namespace library_backup {
struct Connection {
    sqlite3* value = nullptr;
    Connection(const fs::path& path, int flags) {
        const int code=sqlite3_open_v2(pathText(path).c_str(),&value,flags|SQLITE_OPEN_FULLMUTEX,nullptr);
        if(code!=SQLITE_OK) { const std::string error=value ? sqlite3_errmsg(value) : "无法打开备份"; sqlite3_close(value); value=nullptr; throw std::runtime_error(error); }
        sqlite3_busy_timeout(value,100);
        exec(value,"PRAGMA trusted_schema=OFF;");
    }
    ~Connection() { if(value) sqlite3_close(value); }
    Connection(const Connection&)=delete;
    Connection& operator=(const Connection&)=delete;
};
void cancelled(const std::atomic_bool& value) { if(value) throw std::runtime_error("操作已取消，原片库保留。"); }
fs::path safePath(const std::string& text, bool directory) {
    if(text.empty() || text.size()>32768 || text.find('\0')!=std::string::npos) throw std::runtime_error("请选择有效路径。");
    fs::path path(pathFromText(text));
    if(!path.is_absolute() || hasAlternateStream(path)) throw std::runtime_error("请选择绝对路径，不支持附加数据流。");
    path=path.lexically_normal();
    for(auto part=path;!part.empty();part=part.parent_path()) {
        if(fs::exists(part) && reparse(part)) throw std::runtime_error("备份恢复不支持符号链接或目录联接。");
        if(part==part.parent_path()) break;
    }
    if(directory ? !fs::is_directory(path) : !fs::is_regular_file(path)) throw std::runtime_error("路径不存在或磁盘不可访问。");
    return fs::canonical(path);
}
struct SqlCancellation {
    sqlite3* db;
    SqlCancellation(sqlite3* value,const std::atomic_bool& flag):db(value) {
        sqlite3_progress_handler(db,1000,[](void* context) {return static_cast<const std::atomic_bool*>(context)->load() ? 1 : 0;},const_cast<std::atomic_bool*>(&flag));
    }
    ~SqlCancellation() {sqlite3_progress_handler(db,0,nullptr,nullptr);}
};
Json validate(sqlite3* db,const std::atomic_bool& cancel) {
    cancelled(cancel);
    SqlCancellation interrupt(db,cancel);
    if(rows(db,"PRAGMA application_id")[0]["application_id"]!=1245793585 || rows(db,"PRAGMA user_version")[0]["user_version"]!=1)
        throw std::runtime_error("请选择 JAVM 1.0 片库备份，旧版数据库请使用迁移入口。");
    if(!rows(db,"SELECT name FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1").empty())
        throw std::runtime_error("备份包含非标准数据库对象，已拒绝恢复。");
    Connection expected(fs::path(":memory:"),SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE);
    exec(expected.value,
#include "library_schema.inc"
    );
    exec(expected.value,
#include "library_features_schema.inc"
    );
    for(const auto& table:rows(expected.value,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
        const std::string name=table.at("name");
        const auto sql="PRAGMA table_info(\""+name+"\")";
        if(rows(db,sql)!=rows(expected.value,sql)) throw std::runtime_error("备份的片库结构不完整或不兼容。");
    }
    const auto integrity=rows(db,"PRAGMA quick_check");
    if(integrity.size()!=1 || integrity[0]["quick_check"]!="ok" || !rows(db,"PRAGMA foreign_key_check").empty())
        throw std::runtime_error("备份完整性或关联校验失败，当前片库未修改。");
    if(!rows(db,"SELECT id FROM file_operations WHERE state IN ('copying','ready','committed') LIMIT 1").empty()) throw std::runtime_error("备份中含未完成的文件整理，请先在原片库恢复或取消整理。");
    return {{"works",rows(db,"SELECT count(*) AS n FROM works")[0]["n"]},{"resources",rows(db,"SELECT count(*) AS n FROM media_files")[0]["n"]},
        {"favorites",rows(db,"SELECT count(*) AS n FROM works WHERE favorite<>0")[0]["n"]}};
}
void copy(sqlite3* from,sqlite3* to,const std::atomic_bool& cancel,const legacy::Progress& progress,const std::string& phase) {
    auto* task=sqlite3_backup_init(to,"main",from,"main");
    if(!task) throw std::runtime_error("无法开始数据库复制，请确认没有其他程序占用片库。");
    int code=SQLITE_OK;
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::minutes(30);
    auto blockedSince=std::chrono::steady_clock::now();
    try {
        do {
            cancelled(cancel);
            if(std::chrono::steady_clock::now()>deadline) throw std::runtime_error("数据库复制超过时限，原片库保留。");
            code=sqlite3_backup_step(task,128);
            progress(phase,sqlite3_backup_pagecount(task)-sqlite3_backup_remaining(task),sqlite3_backup_pagecount(task));
            if(code==SQLITE_BUSY || code==SQLITE_LOCKED) {
                if(std::chrono::steady_clock::now()-blockedSince>std::chrono::seconds(5)) throw std::runtime_error("数据库持续被占用，请关闭其他使用片库的程序后重试。");
                sqlite3_sleep(20);
            } else blockedSince=std::chrono::steady_clock::now();
        } while(code==SQLITE_OK || code==SQLITE_BUSY || code==SQLITE_LOCKED);
    } catch(...) {sqlite3_backup_finish(task);throw;}
    const auto result=sqlite3_backup_finish(task);
    if(code!=SQLITE_DONE || result!=SQLITE_OK) throw std::runtime_error("数据库复制失败，请检查磁盘空间和访问权限。原片库保留。");
}
Json snapshot(sqlite3* from,const fs::path& target,const std::atomic_bool& cancel,const legacy::Progress& progress,const std::string& phase) {
    auto partial=withSuffix(target,".partial");
    if(fs::exists(target) || fs::exists(partial)) throw std::runtime_error("备份目标已存在，请重新选择位置。");
    createExclusiveFile(partial);
    try {
        Json info;
        {
            Connection output(partial,SQLITE_OPEN_READWRITE);
            copy(from,output.value,cancel,progress,phase);
            progress("validating",0,0);
            info=validate(output.value,cancel);
            exec(output.value,"PRAGMA journal_mode=DELETE;");
        }
        cancelled(cancel);
        syncFile(partial);
        moveFile(partial,target);
        info["path"]=pathText(target);
        return info;
    } catch(...) {std::error_code ec;fs::remove(partial,ec);fs::remove(withSuffix(partial,"-journal"),ec);throw;}
}
}

Json Store::backup(const std::string& operation,const Json& params,const std::atomic_bool& cancelled,const legacy::Progress& progress) {
    std::lock_guard lock(mutex_);
    using namespace library_backup;
    if(db_ && !rows(db_,"SELECT id FROM file_operations WHERE state IN ('copying','ready','committed') LIMIT 1").empty()) throw std::runtime_error("请先恢复或取消文件整理任务。");
    if(operation=="create") {
        if(!db_) throw std::runtime_error("损坏片库无法创建有效备份。请先选择独立备份恢复，原始损坏文件会自动留存。");
        const auto directory=safePath(params.at("directory"),true);
        return snapshot(db_,directory/pathFromText("javm-library-"+uuid()+".sqlite3"),cancelled,progress,"backingUp");
    }
    const auto source=safePath(params.at("path"),false);
    if(fs::exists(path_) && fs::equivalent(source,path_)) throw std::runtime_error("不能选择正在使用的片库，请选择独立备份。");
    Connection input(source,SQLITE_OPEN_READONLY);
    if(operation=="inspect") {
        progress("validating",0,0);
        auto info=validate(input.value,cancelled);
        info["path"]=pathText(source);
        return info;
    }
    if(operation!="restore") throw std::runtime_error("未知备份操作。");
    const auto directory=path_.parent_path()/"backups"/pathFromText("recovery-"+uuid());
    fs::create_directories(directory);
    safePath(pathText(directory),true);
    // Take an immutable SQLite snapshot, then validate it again. Inspection is not authorization to trust a changed file.
    const auto staged=directory/"restore-source.sqlite3";
    snapshot(input.value,staged,cancelled,progress,"reading");
    if(!db_) {
        // Preserve every original byte and sidecar. A pending marker prevents a crash between
        // renames from silently creating an empty library on the next launch.
        struct Original {
            fs::path path,saved;
            std::unique_ptr<ArchiveFileLock> lock;
        };
        std::vector<std::unique_ptr<Original>> originals;
        for(const auto* suffix:{"","-wal","-shm","-journal"}) {
            auto file=std::make_unique<Original>();file->path=withSuffix(path_,suffix);
            if(!fs::exists(file->path)) continue;
            safePath(pathText(file->path),false);
            file->saved=directory/file->path.filename();
            file->lock=std::make_unique<ArchiveFileLock>(file->path);
            originals.push_back(std::move(file));
        }
        {
            Connection clean(staged,SQLITE_OPEN_READWRITE);
            exec(clean.value,"DELETE FROM app_launches; UPDATE directories SET state='interrupted',error='备份恢复后请重新扫描目录' WHERE state='scanning';");
        }
        const auto marker=withSuffix(path_,".restore-pending");
        if(fs::exists(marker)) {safePath(pathText(marker),false);fs::copy_file(marker,directory/"previous-recovery.txt");}
        library_backup::cancelled(cancelled);
        {
            durableWrite(marker,pathText(directory));
        }
        // The short rename phase is not cancellable; no original files are deleted.
        progress("restoring",0,0);
        for(const auto& file:originals) moveFile(file->path,file->saved);
        syncFile(staged);
        moveFile(staged,path_);
        originals.clear();
        const std::atomic_bool cancelled_ignored{false};
        Json info;
        try {open();info=validate(db_,cancelled_ignored);}
        catch(...) {
            ready_=false;
            if(db_) sqlite3_close(db_);
            db_=nullptr;
            setRecoveryError("恢复后校验未完成，原文件已归档。请重新选择有效备份继续恢复。");
            throw;
        }
        setRecoveryError("");
        std::error_code ec;fs::remove(marker,ec);
        info["path"]=pathText(source);info["rollbackPath"]=pathText(directory);
        info["warning"]="损坏片库的原始文件已归档到恢复前副本目录，仅用于排查；它们不是通过校验的可用备份。";
        if(ec) info["warning"]="恢复已完成，但恢复标记未能清理。请检查片库目录权限，重启后可能需要再次恢复。";
        return info;
    }
    Connection restore(staged,SQLITE_OPEN_READWRITE);
    const auto previous=directory/"before-restore.sqlite3";
    const auto original=snapshot(db_,previous,cancelled,progress,"backingUp");
    (void)original;
    // Launch requests and running scan states must never be replayed from a backup.
    exec(restore.value,"DELETE FROM app_launches; UPDATE directories SET state='interrupted',error='备份恢复后请重新扫描目录' WHERE state='scanning';");
    auto info=validate(restore.value,cancelled);
    progress("restoring",0,0);
    copy(restore.value,db_,cancelled,progress,"restoring");
    // SQLITE_DONE is the commit point. A late cancel must not report a completed restore as cancelled.
    info["path"]=pathText(source);
    info["rollbackPath"]=pathText(previous);
    return info;
}
