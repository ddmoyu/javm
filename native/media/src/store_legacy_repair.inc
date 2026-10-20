// 只修复具有完整迁移证据的发现页缓存；所有改动均有独立备份并在单个事务内提交。
Json Store::repairLegacyDiscovery(const std::atomic_bool& cancelled,const legacy::Progress& progress) {
    using library_backup::Connection;
    const auto imports=rows(db_,R"SQL(SELECT i.* FROM javm_legacy_imports i
WHERE NOT EXISTS(SELECT 1 FROM legacy_records r WHERE r.source_path=i.source_path AND r.table_name='__javm_discovery_repair_v1')
AND EXISTS(SELECT 1 FROM legacy_records r WHERE r.source_path=i.source_path AND r.table_name IN ('actor_works','facet_works'))
ORDER BY i.completed_at,i.source_path)SQL");
    if(imports.empty()) throw std::runtime_error("没有需要修复的旧库导入记录。");
    auto stop=[&] { library_backup::cancelled(cancelled); };
    std::vector<std::unique_ptr<Connection>> previous;
    progress("preparing",0,0);
    for(const auto& item:imports) {
        stop();
        const auto original=fs::path(pathFromText(item.at("backup_path"))).parent_path()/"new-before-import.db";
        if(!within(original,path_.parent_path()/"backups") || !fs::is_regular_file(original))
            throw std::runtime_error("导入前备份缺失，无法安全区分原有资料与发现页缓存。请恢复 backups 中的 new-before-import.db 后重试；当前片库未修改。");
        auto input=std::make_unique<Connection>(library_backup::safePath(pathText(original),false),SQLITE_OPEN_READONLY);
        library_backup::SqlCancellation interrupt(input->value,cancelled);
        const auto integrity=rows(input->value,"PRAGMA quick_check");
        if(rows(input->value,"PRAGMA application_id")[0]["application_id"]!=1245793585 ||
           rows(input->value,"PRAGMA user_version")[0]["user_version"]!=1 ||
           integrity.size()!=1 || integrity[0]["quick_check"]!="ok" || !rows(input->value,"PRAGMA foreign_key_check").empty())
            throw std::runtime_error("导入前备份校验失败，当前片库未修改。");
        previous.push_back(std::move(input));
    }
    const auto folder=path_.parent_path()/"backups"/("legacy-discovery-"+uuid());
    fs::create_directories(folder);
    library_backup::safePath(pathText(folder),true);
    const auto backup=folder/"before-repair.sqlite3";
    // 备份必须在写事务之前完成，避免同连接 SQLite Backup 等待自身写锁。
    library_backup::snapshot(db_,backup,cancelled,[&](const std::string&,int64_t done,int64_t total) {
        progress("backingUp",done,total);
    },"backingUp");
    int64_t removed=0,processed=0;
    const auto total=rows(db_,"SELECT count(*) AS n FROM legacy_records WHERE table_name IN ('videos','actor_works','facet_works')")[0]["n"].get<int64_t>();
    struct Cleanup {
        sqlite3* db;
        ~Cleanup() { sqlite3_exec(db,"DROP TABLE IF EXISTS temp.javm_repair_keep; DROP TABLE IF EXISTS temp.javm_repair_video_codes; DROP TABLE IF EXISTS temp.javm_repair_cache; DROP TABLE IF EXISTS temp.javm_repair_remove;",nullptr,nullptr,nullptr); }
    } cleanup{db_};
    Transaction transaction(db_);
    library_backup::SqlCancellation interrupt(db_,cancelled);
    exec(db_,R"SQL(
CREATE TEMP TABLE javm_repair_keep(id TEXT PRIMARY KEY);
CREATE TEMP TABLE javm_repair_video_codes(code_key TEXT PRIMARY KEY);
CREATE TEMP TABLE javm_repair_cache(code_key TEXT NOT NULL,code TEXT NOT NULL,title TEXT NOT NULL,premiered TEXT NOT NULL,poster TEXT NOT NULL);
CREATE INDEX temp.javm_repair_cache_code ON javm_repair_cache(code_key);
CREATE TEMP TABLE javm_repair_remove(id TEXT PRIMARY KEY);
)SQL");
    // 正在下载、已下载或暂停的任务都可能关联作品，不能因尚无本地文件而移除。
    const auto downloads=path_.parent_path()/"downloads-v1.sqlite3";
    if(fs::is_regular_file(downloads)) {
        Connection input(library_backup::safePath(pathText(downloads),false),SQLITE_OPEN_READONLY);
        library_backup::SqlCancellation cancelDownloads(input.value,cancelled);
        for(const auto* table:{"download_tasks","scrape_jobs"}) {
            if(rows(input.value,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",{table}).empty()) continue;
            Query tasks(input.value,std::string("SELECT json_extract(payload,'$.workId') AS id FROM ")+table+" WHERE json_type(payload,'$.workId')='text'");
            while(tasks.next()) { stop(); run(db_,"INSERT OR IGNORE INTO javm_repair_keep VALUES(?)",{tasks.row()["id"]}); }
        }
    }
    for(size_t i=0;i<imports.size();++i) {
        const auto& receipt=imports[i]; const auto source=receipt.at("source_path");
        // 所有导入前已有的作品均受保护，包括没有本地视频、没有收藏的资料卡片。
        Query kept(previous[i]->value,"SELECT id FROM works");
        while(kept.next()) { stop(); run(db_,"INSERT OR IGNORE INTO javm_repair_keep VALUES(?)",{kept.row()["id"]}); }
        exec(db_,"DELETE FROM javm_repair_cache; DELETE FROM javm_repair_video_codes; DELETE FROM javm_repair_remove;");
        Query archived(db_,"SELECT table_name,content FROM legacy_records WHERE source_path=? AND table_name IN ('videos','actor_works','facet_works') ORDER BY table_name,row_number",Json::array({source}));
        while(archived.next()) {
            stop(); const auto record=archived.row(); const auto old=Json::from_cbor(record.at("content").get_binary());
            if(record["table_name"]=="videos") {
                run(db_,"INSERT OR IGNORE INTO javm_repair_keep VALUES(?)",{stringValue(old,"id")});
                run(db_,"INSERT OR IGNORE INTO javm_repair_video_codes VALUES(?)",{codeKey(stringValue(old,"local_id"))});
            } else {
                const auto code=stringValue(old,"code"),title=stringValue(old,"title"),key=codeKey(code);
                if(!key.empty()) run(db_,"INSERT INTO javm_repair_cache VALUES(?,?,?,?,?)",
                    {key,code,title.empty()?code:title,stringValue(old,"release_date"),stringValue(old,"cover_url")});
            }
            if(++processed%128==0) progress("importing",processed,total);
        }
        // 来源资料必须仍是旧迁移器生成的最小形态，且各字段均能在缓存中找到证据。
        // 不以“没有本地文件”作为删除依据，保留离线视频、手工修改、收藏和后续业务关联。
        run(db_,R"SQL(INSERT INTO javm_repair_remove
SELECT w.id FROM works w WHERE w.code_key<>'' AND w.favorite=0 AND w.scan_status=2
AND w.created_at<=?1 AND w.updated_at<=?1 AND w.scraped_at IS NULL
AND w.original_title='' AND w.plot='' AND w.studio='' AND w.label='' AND w.director='' AND w.series=''
AND w.runtime_seconds=0 AND w.rating=0 AND w.thumb='' AND w.fanart=''
AND NOT EXISTS(SELECT 1 FROM javm_repair_keep k WHERE k.id=w.id)
AND NOT EXISTS(SELECT 1 FROM javm_repair_video_codes v WHERE v.code_key=w.code_key)
AND (SELECT count(*) FROM works other WHERE other.code_key=w.code_key)=1
AND NOT EXISTS(SELECT 1 FROM media_files m WHERE m.work_id=w.id)
AND NOT EXISTS(SELECT 1 FROM nfo_documents n WHERE n.work_id=w.id)
AND NOT EXISTS(SELECT 1 FROM work_sources s WHERE s.work_id=w.id)
AND NOT EXISTS(SELECT 1 FROM work_artwork a WHERE a.work_id=w.id)
AND NOT EXISTS(SELECT 1 FROM saved_resources s WHERE s.work_id=w.id OR s.code_key=w.code_key)
AND NOT EXISTS(SELECT 1 FROM work_entities r JOIN entities e ON e.id=r.entity_id WHERE r.work_id=w.id AND e.kind<>'actors')
AND json_valid(w.provenance) AND json_type(w.provenance)='object'
AND NOT EXISTS(SELECT 1 FROM json_each(w.provenance) p WHERE p.key NOT IN ('num','title','premiered','_local_poster'))
AND EXISTS(SELECT 1 FROM javm_repair_cache c WHERE c.code_key=w.code_key AND c.code=w.code)
AND EXISTS(SELECT 1 FROM javm_repair_cache c WHERE c.code_key=w.code_key AND c.title=w.title)
AND EXISTS(SELECT 1 FROM javm_repair_cache c WHERE c.code_key=w.code_key AND c.premiered=w.premiered)
AND EXISTS(SELECT 1 FROM javm_repair_cache c WHERE c.code_key=w.code_key AND c.poster=w.poster)
AND (w.poster='' OR json_extract(w.provenance,'$._local_poster')=w.poster)
AND EXISTS(SELECT 1 FROM javm_repair_cache c WHERE c.code_key=w.code_key
 AND c.code=json_extract(w.provenance,'$.num') AND c.title=json_extract(w.provenance,'$.title')
 AND c.premiered=json_extract(w.provenance,'$.premiered')))SQL",{receipt["completed_at"]});
        const auto count=rows(db_,"SELECT count(*) AS n FROM javm_repair_remove")[0]["n"].get<int64_t>();
        stop();
        // 独立完整备份保留作品及全部关系；旧发现页原始 CBOR 归档始终留在当前库。
        exec(db_,"DELETE FROM works WHERE id IN (SELECT id FROM javm_repair_remove);");
        const auto marker=Json::to_cbor(Json{{"version",1},{"removedWorks",count},{"backupPath",pathText(backup)}});
        Query saved(db_,"INSERT INTO legacy_records(source_path,table_name,row_number,content) VALUES(?1,'__javm_discovery_repair_v1',0,?2)",Json::array({source}));
        saved.blob(2,std::string(marker.begin(),marker.end())); saved.next();
        removed+=count;
    }
    progress("checking",processed,total);
    const auto integrity=rows(db_,"PRAGMA quick_check");
    if(integrity.size()!=1 || integrity[0]["quick_check"]!="ok" || !rows(db_,"PRAGMA foreign_key_check").empty())
        throw std::runtime_error("修复校验失败，当前片库已回滚。");
    stop(); transaction.commit();
    return {{"state","completed"},{"operation","repair"},{"removedWorks",removed},{"backupPath",pathText(backup)},
        {"targetBackupPath",pathText(backup)},{"warning",""}};
}
