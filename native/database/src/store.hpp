#pragma once
#include <sqlite3.h>
#include <nlohmann/json.hpp>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <chrono>
#ifdef _WIN32
#include <windows.h>
#endif

using Json = nlohmann::json;
namespace fs = std::filesystem;

class Database {
#ifdef _WIN32
    struct OwnerLock {
        HANDLE handle = INVALID_HANDLE_VALUE;
        ~OwnerLock() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
        void acquire(const fs::path& path) {
            handle = CreateFileW((path.wstring() + L".owner.lock").c_str(), GENERIC_READ | GENERIC_WRITE,
                0, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
            if (handle == INVALID_HANDLE_VALUE)
                throw std::runtime_error("下载数据库已被另一 JAVM 实例占用，或当前目录不可写。请使用已打开的窗口。");
        }
    } owner_;
#endif
    sqlite3* connection_ = nullptr;
    using Statement = std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)>;
    void check(int code) const {
        if (code != SQLITE_OK && code != SQLITE_DONE && code != SQLITE_ROW)
            throw std::runtime_error(sqlite3_errmsg(connection_));
    }
    Statement statement(const char* sql) const {
        sqlite3_stmt* result = nullptr;
        check(sqlite3_prepare_v2(connection_, sql, -1, &result, nullptr));
        return Statement(result, sqlite3_finalize);
    }
    void bind(sqlite3_stmt* query, int index, const std::string& value) const {
        check(sqlite3_bind_text(query, index, value.data(), static_cast<int>(value.size()), SQLITE_TRANSIENT));
    }
    int scalar(const char* sql) const {
        auto query = statement(sql);
        check(sqlite3_step(query.get()));
        return sqlite3_column_int(query.get(), 0);
    }
    void sql(const char* text) const { check(sqlite3_exec(connection_, text, nullptr, nullptr, nullptr)); }
public:
    explicit Database(const fs::path& path) {
        fs::create_directories(path.parent_path());
#ifdef _WIN32
        owner_.acquire(path);
#endif
        const auto utf8 = path.u8string();
        if (sqlite3_open_v2(reinterpret_cast<const char*>(utf8.c_str()), &connection_,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr) != SQLITE_OK) {
            const std::string error = connection_ ? sqlite3_errmsg(connection_) : "Cannot open database";
            if (connection_) sqlite3_close(connection_);
            connection_ = nullptr;
            throw std::runtime_error(error);
        }
        try {
            sqlite3_busy_timeout(connection_, 5000);
            const int version = scalar("PRAGMA user_version");
            const int application = scalar("PRAGMA application_id");
            if (version == 0 && application == 0 && scalar("SELECT count(*) FROM sqlite_master WHERE type='table'") == 0) {
                sql("BEGIN IMMEDIATE;"
                    "CREATE TABLE download_tasks(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));"
                    "CREATE TABLE download_settings(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL CHECK(json_valid(payload)));"
                    "CREATE TABLE scrape_jobs(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));"
                    "PRAGMA application_id=1245793604; PRAGMA user_version=2; COMMIT;");
            } else if ((version != 1 && version != 2) || application != 1245793604) {
                throw std::runtime_error("Unsupported database schema; the existing file has been preserved");
            } else if (version == 1) {
                const auto backupPath = fs::path(path.wstring()+L".pre-v2-"+std::to_wstring(std::chrono::system_clock::now().time_since_epoch().count())+L".bak");
                sqlite3* copy = nullptr;
                const auto bytes = backupPath.u8string();
                if (sqlite3_open(reinterpret_cast<const char*>(bytes.c_str()),&copy) != SQLITE_OK) {
                    if (copy) sqlite3_close(copy);
                    throw std::runtime_error("无法备份任务数据库，原数据保留");
                }
                auto backup = sqlite3_backup_init(copy,"main",connection_,"main");
                const int result = backup ? sqlite3_backup_step(backup,-1) : SQLITE_ERROR;
                const int finished = backup ? sqlite3_backup_finish(backup) : SQLITE_ERROR;
                sqlite3_close(copy);
                if (result != SQLITE_DONE || finished != SQLITE_OK) throw std::runtime_error("任务数据库备份失败，原数据保留");
                sql("BEGIN IMMEDIATE; CREATE TABLE scrape_jobs(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))); PRAGMA user_version=2; COMMIT;");
            }
            sql("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
            sql("CREATE INDEX IF NOT EXISTS download_tasks_created ON download_tasks(json_extract(payload,'$.createdAt'),id);");
        } catch (...) { sqlite3_close(connection_); connection_ = nullptr; throw; }
    }
    ~Database() { if (connection_) sqlite3_close(connection_); }
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

    Json handle(const std::string& method, const Json& params) {
        if (method == "hello") return Json{{"protocol", 1}, {"schema", 2}};
        if (method == "scraping.load") {
            auto query = statement("SELECT payload FROM scrape_jobs ORDER BY json_extract(payload,'$.createdAt'),id LIMIT 100 OFFSET ?");
            check(sqlite3_bind_int(query.get(),1,std::max(0,params.value("offset",0))));
            Json tasks=Json::array(); int code;
            while ((code=sqlite3_step(query.get())) == SQLITE_ROW) tasks.push_back(Json::parse(reinterpret_cast<const char*>(sqlite3_column_text(query.get(),0))));
            check(code); return tasks;
        }
        if (method == "scraping.save") {
            const auto& task=params.at("task");
            const auto id=task.at("id").get<std::string>();
            const int expected=params.at("expectedRevision"), revision=task.at("revision");
            const auto payload=task.dump();
            if (id.empty() || id.size()>100 || expected<0 || revision!=expected+1 || payload.size()>32768)
                throw std::runtime_error("刮削任务记录无效");
            if (!expected && scalar("SELECT count(*) FROM scrape_jobs")>=1000) throw std::runtime_error("刮削任务已达 1000 条上限，请清理已结束记录");
            auto query=statement(expected==0 ? "INSERT INTO scrape_jobs(id,revision,payload) VALUES(?1,?2,?3)" : "UPDATE scrape_jobs SET revision=?2,payload=?3 WHERE id=?1 AND revision=?4");
            bind(query.get(),1,id); check(sqlite3_bind_int(query.get(),2,revision)); bind(query.get(),3,payload);
            if (expected) check(sqlite3_bind_int(query.get(),4,expected));
            check(sqlite3_step(query.get()));
            if (sqlite3_changes(connection_)!=1) throw std::runtime_error("刮削任务已被其他操作修改");
            return Json::object();
        }
        if (method == "scraping.remove") {
            auto query=statement("DELETE FROM scrape_jobs WHERE id=? AND revision=?");
            bind(query.get(),1,params.at("id")); check(sqlite3_bind_int(query.get(),2,params.at("revision")));
            check(sqlite3_step(query.get()));
            if (sqlite3_changes(connection_)!=1) throw std::runtime_error("刮削任务已被其他操作修改");
            return Json::object();
        }
        if (method == "downloads.load") {
            Json tasks = Json::array();
            const auto offset = std::max(int64_t{0},params.value("offset",int64_t{0}));
            auto query = statement("SELECT payload FROM download_tasks ORDER BY json_extract(payload,'$.createdAt'), id LIMIT 100 OFFSET ?");
            check(sqlite3_bind_int64(query.get(),1,offset));
            size_t bytes = 0;
            int code;
            while ((code = sqlite3_step(query.get())) == SQLITE_ROW) {
                const auto length = static_cast<size_t>(sqlite3_column_bytes(query.get(),0));
                // 除条数外限制消息体大小，避免旧记录中的长日志阻塞前端解析。
                if (!tasks.empty() && bytes + length > 1024 * 1024) break;
                tasks.push_back(Json::parse(reinterpret_cast<const char*>(sqlite3_column_text(query.get(),0))));
                bytes += length;
            }
            check(code);
            const Json nextOffset = code == SQLITE_ROW || tasks.size() == 100
                ? Json(offset + static_cast<int64_t>(tasks.size())) : Json(nullptr);
            Json settings = Json::object();
            auto config = statement("SELECT payload FROM download_settings WHERE id=1");
            code = sqlite3_step(config.get());
            if (code == SQLITE_ROW) settings = Json::parse(reinterpret_cast<const char*>(sqlite3_column_text(config.get(), 0)));
            else check(code);
            return Json{{"tasks", tasks}, {"settings", settings}, {"nextOffset", nextOffset}};
        }
        if (method == "downloads.save") {
            const auto& task = params.at("task");
            const auto id = task.at("id").get<std::string>();
            const auto expected = params.at("expectedRevision").get<int>();
            const auto revision = task.at("revision").get<int>();
            const auto payload = task.dump();
            if (id.empty() || id.size() > 100 || expected < 0 || revision != expected + 1 || payload.size() > 512 * 1024)
                throw std::runtime_error("Invalid download record");
            // 与前端 downloadTaskLimit 一致；仅限制新增，旧记录仍可读取、更新和移除。
            if (expected == 0 && scalar("SELECT count(*) FROM download_tasks") >= 1000)
                throw std::runtime_error("下载任务已达 1000 条上限，请先移除已结束记录；文件不会被删除");
            auto query = statement(expected == 0
                ? "INSERT INTO download_tasks(id,revision,payload) VALUES(?1,?2,?3)"
                : "UPDATE download_tasks SET revision=?2,payload=?3 WHERE id=?1 AND revision=?4");
            bind(query.get(), 1, id);
            check(sqlite3_bind_int(query.get(), 2, revision));
            bind(query.get(), 3, payload);
            if (expected != 0) check(sqlite3_bind_int(query.get(), 4, expected));
            check(sqlite3_step(query.get()));
            if (sqlite3_changes(connection_) != 1) throw std::runtime_error("Download revision conflict");
            return Json::object();
        }
        if (method == "downloads.remove") {
            auto query = statement("DELETE FROM download_tasks WHERE id=? AND revision=?");
            bind(query.get(), 1, params.at("id").get<std::string>());
            check(sqlite3_bind_int(query.get(), 2, params.at("revision").get<int>()));
            check(sqlite3_step(query.get()));
            if (sqlite3_changes(connection_) != 1) throw std::runtime_error("Download revision conflict");
            return Json::object();
        }
        if (method == "downloads.settings") {
            const auto payload = params.dump();
            if (!params.is_object() || payload.size() > 32768) throw std::runtime_error("Invalid download settings");
            auto query = statement("INSERT INTO download_settings(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload");
            bind(query.get(), 1, payload);
            check(sqlite3_step(query.get()));
            return Json::object();
        }
        if (method == "close") { sql("PRAGMA wal_checkpoint(PASSIVE)"); return Json::object(); }
        throw std::runtime_error("Unknown database operation");
    }
};
