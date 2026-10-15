// 仅负责 SQLite 持久化和旧统计读取；日期、计数和上报调度由 TypeScript 管理。
void Store::openAnalytics() {
    if(analyticsDb_) return;
    sqlite3* raw=nullptr;
    const auto code=sqlite3_open_v2(pathText(path_.parent_path()/"analytics.sqlite3").c_str(),&raw,
        SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|SQLITE_OPEN_FULLMUTEX,nullptr);
    std::unique_ptr<sqlite3,decltype(&sqlite3_close)> connection(raw,sqlite3_close);
    if(code!=SQLITE_OK) throw std::runtime_error("无法打开使用统计数据库，原文件保留");
    check(raw,sqlite3_busy_timeout(raw,1000));
    exec(raw,"PRAGMA trusted_schema=OFF;");
    QueryDeadline deadline(raw);
    const auto version=rows(raw,"PRAGMA user_version")[0]["user_version"];
    const auto application=rows(raw,"PRAGMA application_id")[0]["application_id"];
    if(version==0 && application==0 && rows(raw,"SELECT name FROM sqlite_master WHERE type='table'").empty()) {
        Transaction transaction(raw);
        exec(raw,"CREATE TABLE usage_analytics_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))); PRAGMA application_id=1245795905; PRAGMA user_version=1;");
        transaction.commit();
    } else if(version!=1 || application!=1245795905) throw std::runtime_error("使用统计数据库格式不兼容，原文件保留");
    const auto integrity=rows(raw,"PRAGMA quick_check");
    if(integrity.size()!=1 || integrity[0]["quick_check"]!="ok") throw std::runtime_error("使用统计数据库损坏，原文件保留");
    exec(raw,"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    if(!db_ && rows(raw,"SELECT id FROM usage_analytics_state WHERE id=1").empty())
        throw std::runtime_error("请先恢复片库，再迁移旧使用统计身份；原记录保留");
    // 兼容先前放在片库的快照，只迁移一次，不删除源记录。此后片库恢复不影响身份和计数。
    if(db_ && rows(raw,"SELECT id FROM usage_analytics_state WHERE id=1").empty() &&
        !rows(db_,"SELECT name FROM sqlite_master WHERE type='table' AND name='usage_analytics_state'").empty()) {
        const auto previous=rows(db_,"SELECT revision,payload FROM usage_analytics_state WHERE id=1");
        if(!previous.empty()) {
            const auto payload=previous[0]["payload"].get<std::string>();
            if(payload.size()>65536) throw std::runtime_error("旧使用统计超过迁移上限，原记录保留");
            run(raw,"INSERT INTO usage_analytics_state(id,revision,payload) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING",{previous[0]["revision"],payload});
        }
    }
    analyticsDb_=connection.release();
}
Json Store::analytics(const std::string& method,const Json& params) {
    std::lock_guard lock(mutex_);
    if(method=="library.analytics.context") {
        if(!db_) throw std::runtime_error("片库恢复后再更新视频总数");
        QueryDeadline deadline(db_);
        return rows(db_,"SELECT count(*) AS videoCount FROM media_files")[0];
    }
    openAnalytics();
    QueryDeadline deadline(analyticsDb_);
    if(method=="library.analytics.save") {
        const auto expected=params.at("expectedRevision").get<int64_t>();
        const auto& value=params.at("state");
        const auto payload=value.dump();
        if(expected<0 || expected>=9007199254740991LL || !value.is_object() ||
            value.value("version",0)!=1 || payload.size()>65536)
            throw std::runtime_error("使用统计记录无效，原记录保留");
        Transaction transaction(analyticsDb_);
        const auto saved=rows(analyticsDb_,"SELECT revision,payload FROM usage_analytics_state WHERE id=1");
        // Extension 超时可能已经提交；允许同一快照重试，避免重复累加。
        if(!saved.empty() && saved[0]["revision"]==expected+1 && saved[0]["payload"]==payload) {
            transaction.commit();return Json::object();
        }
        if(saved.empty() ? expected!=0 : saved[0]["revision"]!=expected)
            throw std::runtime_error("使用统计已变化，请重启应用后重试；原记录保留");
        run(analyticsDb_,"INSERT INTO usage_analytics_state(id,revision,payload) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",{expected+1,payload});
        transaction.commit();return Json::object();
    }
    if(method!="library.analytics.load") throw std::runtime_error("未知的使用统计操作");
    const auto saved=rows(analyticsDb_,"SELECT revision,payload FROM usage_analytics_state WHERE id=1");
    Json result={{"revision",saved.empty()?Json(0):saved[0]["revision"]},
        {"state",saved.empty()?Json(nullptr):Json::parse(saved[0]["payload"].get<std::string>())},
        {"legacyMeta",Json::array()},{"legacyDays",Json::array()}};
    if(!saved.empty()) return result;

    // 优先使用已导入的原始归档，仅解码统计两张表，不读取媒体内容。
    size_t count=0,bytes=0;
    if(db_) {
        QueryDeadline archiveDeadline(db_);
        Query archive(db_,"SELECT table_name,content FROM legacy_records WHERE table_name IN ('analytics_meta','analytics_daily') ORDER BY source_path,table_name,row_number LIMIT 65");
        while(archive.next()) {
            const auto row=archive.row();const auto& content=row["content"].get_binary();
            bytes+=content.size();
            if(++count>64 || bytes>65536) throw std::runtime_error("旧统计归档超过迁移上限，原记录保留");
            result[row["table_name"]=="analytics_meta"?"legacyMeta":"legacyDays"].push_back(Json::from_cbor(content));
        }
    }
    if(count) return result;

    // 即使尚未导入片库，也沿用 0.5.3 的匿名标识；源库始终只读，不更改或删除。
    const auto source=legacy::sourcePath(path_);
    if(!fs::exists(source)) return result;
    sqlite3* raw=nullptr;
    const auto code=sqlite3_open_v2(pathText(source).c_str(),&raw,SQLITE_OPEN_READONLY|SQLITE_OPEN_FULLMUTEX,nullptr);
    const std::unique_ptr<sqlite3,decltype(&sqlite3_close)> old(raw,sqlite3_close);
    if(code!=SQLITE_OK) throw std::runtime_error("无法读取旧使用统计，原数据库保留");
    check(raw,sqlite3_busy_timeout(raw,1000));
    sqlite3_db_config(raw,SQLITE_DBCONFIG_TRUSTED_SCHEMA,0,nullptr);
    QueryDeadline oldDeadline(raw);
    const auto exists=[&](const char* name) { return !rows(raw,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",{name}).empty(); };
    if(exists("analytics_meta"))
        result["legacyMeta"]=rows(raw,"SELECT key,value FROM analytics_meta WHERE key IN ('analytics_user_id','analytics_system_language','analytics_last_active_date') LIMIT 4");
    if(exists("analytics_daily"))
        result["legacyDays"]=rows(raw,"SELECT user_id,stat_date,os,cpu_arch,system_language,app_version,play_video_count,download_video_count,app_launch_count,active_duration_seconds,search_designation_count,search_resource_link_count,current_video_total_count,needs_sync FROM analytics_daily LIMIT 33");
    if(result.dump().size()>65536 || result["legacyDays"].size()>32)
        throw std::runtime_error("旧使用统计超过迁移上限，原记录保留");
    return result;
}
