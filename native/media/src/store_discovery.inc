// 内置快照只读附加，不导入用户片库，也不经 JS 重复导入整个名单。
Json Store::catalogSeed(const Json& params) {
    const auto path=fs::path(pathFromText(requestText(params,"path")));
    if(!path.is_absolute() || !fs::is_regular_file(path) || fs::file_size(path)>16*1024*1024)
        throw std::runtime_error("内置目录文件无效，请重新安装。");
    std::lock_guard lock(mutex_);
    if(catalogSeedPath_==path) return {{"ready",true}};
    if(!catalogSeedPath_.empty()) throw std::runtime_error("内置目录版本已改变，请重新启动。");
    auto source=pathText(path);
    std::replace(source.begin(),source.end(),'\\','/');
    std::string uri="file:";
    constexpr char hex[]="0123456789ABCDEF";
    for(const auto c:source) {
        const auto byte=static_cast<unsigned char>(c);
        if((byte>='a' && byte<='z') || (byte>='A' && byte<='Z') || (byte>='0' && byte<='9') ||
            c=='/' || c==':' || c=='-' || c=='_' || c=='.') uri+=c;
        else {uri+='%';uri+=hex[byte>>4];uri+=hex[byte&15];}
    }
    uri+="?mode=ro";
    run(db_,"ATTACH DATABASE ? AS javm_seed",{uri});
    try {
        QueryDeadline deadline(db_);
        if(rows(db_,"PRAGMA javm_seed.application_id")[0]["application_id"]!=0x4a434154 ||
            rows(db_,"PRAGMA javm_seed.user_version")[0]["user_version"]!=1 ||
            sqlite3_db_readonly(db_,"javm_seed")!=1)
            throw std::runtime_error("内置目录版本无效，请重新安装。");
        const auto count=rows(db_,"SELECT count(*) AS n FROM javm_seed.catalog")[0]["n"].get<int64_t>();
        if(count>100000 || !rows(db_,"SELECT 1 FROM javm_seed.catalog WHERE dimension IN (1,2) AND video_count IS NULL LIMIT 1").empty())
            throw std::runtime_error("内置目录包含无效演员记录。");
        Transaction transaction(db_);
        exec(db_,R"SQL(
DROP VIEW javm_discovery_names;
CREATE TEMP VIEW javm_discovery_names AS
WITH combined AS (
 SELECT * FROM javm_seed.names s WHERE NOT EXISTS(
   SELECT 1 FROM javm_discovery_overrides o WHERE o.dimension=s.dimension AND o.name=s.name)
 UNION ALL SELECT * FROM javm_discovery_overrides
)
SELECT * FROM combined
UNION ALL
SELECT 'actresses',f.name,100000,NULL FROM facet_favorites f
 WHERE f.dimension IN ('actors','actresses') AND f.favorite=1 AND NOT EXISTS(
   SELECT 1 FROM combined c WHERE c.dimension='actresses' AND c.name=f.name)
 GROUP BY f.name;
)SQL");
        // 强制验证视图和列结构后才提交，失败保留原临时目录。
        rows(db_,"SELECT dimension,name,position,video_count FROM javm_discovery_names LIMIT 1");
        transaction.commit();
        catalogSeedPath_=path;
        return {{"ready",true},{"rows",count}};
    } catch(...) {
        sqlite3_exec(db_,"DETACH DATABASE javm_seed",nullptr,nullptr,nullptr);
        throw;
    }
}

Json Store::catalogEntries(const Json& params) {
    const auto after=params.value("after",0);
    if(after<0 || after>100000) throw std::runtime_error("内置目录游标无效。");
    const auto limit=std::clamp(params.value("limit",500),1,500);
    std::lock_guard lock(mutex_);
    if(catalogSeedPath_.empty()) throw std::runtime_error("内置目录尚未打开。");
    QueryDeadline deadline(db_);
    auto result=rows(db_,R"SQL(SELECT c.id AS rowId,
      CASE dimension WHEN 1 THEN 'actresses' WHEN 2 THEN 'maleActors' WHEN 3 THEN 'directors'
        WHEN 4 THEN 'studios' WHEN 5 THEN 'labels' WHEN 6 THEN 'series' WHEN 7 THEN 'genres' END AS dimension,
      CASE lane WHEN 0 THEN 'censored' ELSE 'uncensored' END AS lane,source_id AS id,name,
      COALESCE(label,name) AS label,COALESCE(aliases,'[]') AS aliases,
      CASE translation_status WHEN 0 THEN 'pending' WHEN 1 THEN 'translated' ELSE 'reviewed' END AS translationStatus,
      COALESCE(category,'') AS category,video_count AS videoCount,count_updated_at AS countUpdatedAt
      FROM javm_seed.catalog c WHERE c.id>? ORDER BY c.id LIMIT ?)SQL",{after,limit});
    int cursor=after;
    for(auto& row:result) {
        cursor=row["rowId"].get<int>();row.erase("rowId");
        row["aliases"]=Json::parse(row["aliases"].get<std::string>());
        if(row["videoCount"].is_null()) {row.erase("videoCount");row.erase("countUpdatedAt");}
    }
    return {{"items",result},{"after",cursor},{"done",result.size()<static_cast<size_t>(limit)}};
}
