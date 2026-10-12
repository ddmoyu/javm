std::string Store::matchWork(const Json& nfo,const std::string& requested) {
    std::set<std::string> explicitIds, declaredIds;
    for(const auto& item:nfo.value("uniqueids",Json::array())) {
        const auto type=item.value("type",std::string{}),value=item.value("value",std::string{});
        if(type=="javm-work") {
            declaredIds.insert(value);
            if(!rows(db_,"SELECT id FROM works WHERE id=?",{value}).empty()) explicitIds.insert(value);
        }
        if(type=="metatube") if(const auto at=value.find(':');at!=std::string::npos)
            for(const auto& row:rows(db_,"SELECT work_id FROM work_sources WHERE provider=? AND source_id=?",{value.substr(0,at),value.substr(at+1)})) explicitIds.insert(row["work_id"]);
    }
    if(explicitIds.size()>1 || declaredIds.size()>1) throw std::runtime_error("NFO 的作品身份互相冲突，未自动合并");
    if(!requested.empty()) {
        auto found=rows(db_,"SELECT code_key FROM works WHERE id=?",{requested});
        if(found.empty()) throw std::runtime_error("关联作品已不存在，请重新选择");
        const auto code=codeKey(nfo.value("num",std::string{}));
        if((!explicitIds.empty() && !explicitIds.contains(requested)) || (!code.empty() && found[0]["code_key"]!="" && found[0]["code_key"]!=code))
            throw std::runtime_error("文件资料与所选作品不一致，未改动关联");
        return requested;
    }
    if(!explicitIds.empty()) return matchWork(nfo,*explicitIds.begin());
    const auto code=codeKey(nfo.value("num",std::string{}));
    if(code.empty()) return {};
    auto matches=rows(db_,"SELECT id FROM works WHERE code_key=? LIMIT 2",{code});
    if(matches.size()>1) throw std::runtime_error("相同番号对应多部作品，请从作品详情手动关联文件");
    return matches.empty()?std::string{}:matches[0]["id"].get<std::string>();
}

std::string Store::save(const Json& file,const Json& nfo,const std::string* source) {
    std::lock_guard lock(mutex_);
    Transaction transaction(db_);
    const auto id=saveWork(file,nfo,source);
    transaction.commit();
    return id;
}

std::string Store::saveWork(const Json& file,const Json& nfo,const std::string* source) {
    const bool metadataOnly=file.value("kind",std::string{})=="metadata";
    const auto path=metadataOnly?std::string{}:file.at("path").get<std::string>();
    const auto nfoPath=file.value("nfo_path",std::string{}), requested=file.value("work_id",std::string{});
    Json found=Json::array();
    if(!path.empty()) found=rows(db_,"SELECT work_id FROM media_files WHERE path_key=?",{pathKey(fs::path(wide(path)))});
    if(!nfoPath.empty()) {
        const auto document=rows(db_,"SELECT work_id FROM nfo_documents WHERE path_key=?",{pathKey(fs::path(wide(nfoPath)))});
        if(!found.empty() && !document.empty() && found[0]["work_id"]!=document[0]["work_id"]) throw std::runtime_error("视频与 NFO 属于不同作品，未自动合并");
        if(found.empty()) found=document;
    }
    if(!found.empty() && !requested.empty() && found[0]["work_id"]!=requested) throw std::runtime_error("文件已关联其他作品，请先确认所属作品");
    auto identity=nfo;
    bool oldEditedCode=false;
    if(!found.empty()) {
        const auto existing=rows(db_,"SELECT provenance FROM works WHERE id=?",{found[0]["work_id"]});
        const auto previous=Json::parse(existing[0]["provenance"].get<std::string>());
        oldEditedCode=previous.value("_manual",Json::object()).contains("code") && previous.value("num",Json())==nfo.value("num",Json());
        if(oldEditedCode) identity.erase("num");
    }
    auto id=matchWork(identity,found.empty()?requested:found[0]["work_id"].get<std::string>());
    auto oldRows=rows(db_,"SELECT * FROM javm_catalog WHERE id=?",{id});
    const bool fresh=oldRows.empty();
    if(fresh) {
        id=uuid();
        for(const auto& item:nfo.value("uniqueids",Json::array())) if(item.value("type",std::string{})=="javm-work") {
            const auto savedId=item.value("value",std::string{});
            if(std::regex_match(savedId,std::regex("[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}"))) id=savedId;
        }
    }
    auto old=fresh?Json::object():oldRows[0];
    auto provenance=fresh?Json::object():Json::parse(old["provenance"].get<std::string>());
    const auto previous=provenance, manual=provenance.value("_manual",Json::object());
    const bool sameSource=!nfoPath.empty() && pathKey(fs::path(wide(nfoPath)))==pathKey(fs::path(wide(stringValue(old,"nfo_path"))));
    if(fresh || sameSource || stringValue(old,"nfo_path").empty()) provenance.update(nfo);
    auto merged=old;
    if(fresh) merged["title"]=file.value("name",std::string("未命名作品"));
    for(const auto& [column,key]:std::map<std::string,std::string>{{"title","title"},{"original_title","originaltitle"},{"code","num"},{"studio","studio"},{"label","label"},{"director","director"},{"series","series"},{"plot","plot"},{"premiered","premiered"}}) {
        auto value=stringValue(merged,column.c_str());
        const bool generated=column=="title" && previous.contains("_filenameTitle") && merged["title"]==previous["_filenameTitle"];
        if(manual.contains(column)) value=manual[column].get<std::string>();
        else if(nfo.contains(key) && (fresh || value.empty() || generated || (sameSource && previous.contains(key) && previous[key]==value))) value=nfo[key].get<std::string>();
        merged[column]=value;
    }
    if(fresh && !nfo.contains("title")) provenance["_filenameTitle"]=merged["title"];
    if(nfo.contains("title")) provenance.erase("_filenameTitle");
    if(!manual.empty()) provenance["_manual"]=manual;
    const auto number=[&](const char* column,const char* key,const char* manualKey) {
        if(manual.contains(manualKey)) return manual[manualKey];
        const auto value=old.value(column,Json(0));
        if(nfo.contains(key) && (fresh || value.get<double>()<=0 || (sameSource && previous.contains(key) && previous[key]==value))) return nfo[key];
        return value;
    };
    const auto rating=number("rating","rating","rating");
    const auto duration=number("runtime_seconds","runtimeSeconds","duration");
    for(const auto* kind:{"poster","thumb","fanart"}) {
        auto value=stringValue(old,kind);
        if(manual.contains(kind)) value=manual[kind].get<std::string>();
        else if(file.contains(kind) && (value.empty() || (sameSource && previous.value(std::string("_local_")+kind,std::string{})==value))) value=file[kind].get<std::string>();
        merged[kind]=value;
        if(!value.empty()) provenance[std::string("_local_")+kind]=value;
    }
    const bool hasMetadata=(source || nfo.contains("title")) && !file.value("pending",false);
    run(db_,R"SQL(INSERT INTO works(id,code,code_key,title,original_title,plot,studio,label,director,series,premiered,runtime_seconds,rating,poster,thumb,fanart,provenance,scan_status)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,code_key=excluded.code_key,title=excluded.title,
original_title=excluded.original_title,plot=excluded.plot,studio=excluded.studio,label=excluded.label,director=excluded.director,series=excluded.series,
premiered=excluded.premiered,runtime_seconds=excluded.runtime_seconds,rating=excluded.rating,poster=excluded.poster,thumb=excluded.thumb,fanart=excluded.fanart,
provenance=excluded.provenance,scan_status=MAX(works.scan_status,excluded.scan_status),updated_at=CURRENT_TIMESTAMP)SQL",
        {id,merged["code"],codeKey(merged["code"]),merged["title"],merged["original_title"],merged["plot"],merged["studio"],merged["label"],merged["director"],merged["series"],merged["premiered"],duration,rating,merged["poster"],merged["thumb"],merged["fanart"],provenance.dump(),hasMetadata?2:1});
    for(const auto& [kind,key]:{std::pair{"actors","actor"},{"genres","genre"},{"tags","tag"}}) if(nfo.contains(key) && !manual.contains(kind))
        mergeRelations(db_,id,kind,key,nfo[key],sameSource?previous.value(key,Json::array()):Json::array());
    if(!path.empty()) run(db_,R"SQL(INSERT INTO media_files(id,work_id,path_key,path,dir_path,file_size,file_mtime,fast_hash,file_stamp,width,height,duration_ms,codec)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path_key) DO UPDATE SET path=excluded.path,dir_path=excluded.dir_path,file_size=excluded.file_size,file_mtime=excluded.file_mtime,
fast_hash=excluded.fast_hash,file_stamp=excluded.file_stamp,width=excluded.width,height=excluded.height,duration_ms=excluded.duration_ms,codec=excluded.codec,missing=0)SQL",
        {uuid(),id,pathKey(fs::path(wide(path))),path,file.at("parent"),file.value("size",Json()),file.value("mtime",Json()),file.value("fast_hash",std::string{}),file.value("file_stamp",std::string{}),file.value("width",0),file.value("height",0),file.value("duration_ms",int64_t{0}),file.value("codec",std::string{})});
    if(!nfoPath.empty()) {
        const bool canonical=rows(db_,"SELECT path_key FROM nfo_documents WHERE work_id=? AND canonical=1",{id}).empty();
        run(db_,R"SQL(INSERT INTO nfo_documents(path_key,work_id,path,stamp,canonical,encoding,parser_version) VALUES(?,?,?,?,?,?,?)
ON CONFLICT(path_key) DO UPDATE SET stamp=excluded.stamp,encoding=excluded.encoding,parser_version=excluded.parser_version)SQL",
            {pathKey(fs::path(wide(nfoPath))),id,nfoPath,file.value("nfo_stamp",std::string{}),canonical,nfo.value("_encoding",std::string{}),file.value("nfo_parser",0)});
        if(source) { Query saved(db_,"UPDATE nfo_documents SET content=?2 WHERE path_key=?1",Json::array({pathKey(fs::path(wide(nfoPath)))})); saved.blob(2,*source); saved.next(); }
    }
    if(file.contains("stream_url")) run(db_,"INSERT INTO stream_targets(media_id,url) SELECT id,? FROM media_files WHERE path_key=? ON CONFLICT(media_id) DO UPDATE SET url=excluded.url",{file.at("stream_url"),pathKey(fs::path(wide(path)))});
    if(!path.empty()) {
        const auto name=pathText(fs::path(wide(path)).stem());std::smatch part;
        static const std::regex pattern(R"((?:^|[ ._-])(?:CD|DISC|DISK|PART)[ ._-]*([0-9]{1,2})(?:$|[ ._-]))",std::regex::icase);
        if(std::regex_search(name,part,pattern) && std::stoi(part[1])>0)
            run(db_,"INSERT OR IGNORE INTO media_parts(media_id,part_number) SELECT id,? FROM media_files WHERE path_key=?",{std::stoi(part[1]),pathKey(fs::path(wide(path)))});
    }
    for(const auto& item:nfo.value("uniqueids",Json::array())) if(!oldEditedCode && item.value("type",std::string{})=="metatube") {
        const auto value=item.value("value",std::string{}); const auto at=value.find(':'); if(at==std::string::npos) continue;
        const auto provider=value.substr(0,at), sourceId=value.substr(at+1);
        auto existing=rows(db_,"SELECT work_id FROM work_sources WHERE provider=? AND source_id=?",{provider,sourceId});
        if(!existing.empty() && existing[0]["work_id"]!=id) throw std::runtime_error("来源身份已属于其他作品，导入已回滚");
        run(db_,"INSERT OR IGNORE INTO work_sources VALUES(?,?,?)",{provider,sourceId,id});
    }
    if(!path.empty()) rememberAssetRoot(fs::path(wide(path)).parent_path());
    if(!nfoPath.empty()) rememberAssetRoot(fs::path(wide(nfoPath)).parent_path());
    return id;
}

Json Store::decorate(Json result) {
    for(auto& work:result) {
        const auto id=work["id"].get<std::string>();
        for(const auto* kind:{"actors","genres","tags"}) work[kind]=relations(db_,id,kind,"");
        for(const auto* kind:{"actors","genres"}) {
            Json names=Json::array(); for(const auto& raw:work[kind]) { const auto name=canonicalName(db_,kind,raw); if(std::find(names.begin(),names.end(),name)==names.end()) names.push_back(name); } work[kind]=names;
        }
        for(const auto& [field,dimension]:{std::pair{"studio","studios"},{"label","labels"},{"director","directors"},{"series","series"}}) work[field]=canonicalName(db_,dimension,work[field]);
        const auto provenance=Json::parse(work["provenance"].get<std::string>());
        work["metadata_edited"]=!provenance.value("_manual",Json::object()).empty();
        work["year"]=provenance.value("year",0);
        work["preview"]=provenance.value("_preview",Json::object());
        work["media_files"]=rows(db_,"SELECT m.id,path,file_size,width,height,duration_ms,codec,missing,s.url AS stream_url,COALESCE(p.part_number,0) AS part,COALESCE(p.total,0) AS parts FROM media_files m LEFT JOIN stream_targets s ON s.media_id=m.id LEFT JOIN media_parts p ON p.media_id=m.id WHERE work_id=? ORDER BY missing,CASE WHEN p.part_number>0 THEN p.part_number ELSE 100 END,created_at,m.id",{id});
        for(auto& file:work["media_files"]) {file["subtitles"]=Json::array();for(const auto& sub:rows(db_,"SELECT path FROM media_subtitles WHERE media_id=? ORDER BY path_key LIMIT 16",{file["id"]})) file["subtitles"].push_back(sub["path"]);}
        work["nfo_files"]=rows(db_,"SELECT path,canonical FROM nfo_documents WHERE work_id=? AND stamp<>'' ORDER BY canonical DESC,path_key",{id});
        work["screenshots"]=rows(db_,"SELECT id,path,kind,seconds FROM work_artwork WHERE work_id=? AND kind<>'poster' ORDER BY rowid LIMIT 100",{id});
        work.erase("provenance"); work.erase("nfo_data");
    }
    return result;
}

Json Store::find(const fs::path& path) {
    std::lock_guard lock(mutex_);
    auto found=rows(db_,"SELECT c.*,m.file_stamp,m.width,m.height,m.duration_ms,m.codec,m.fast_hash,m.missing FROM media_files m JOIN javm_catalog c ON c.id=m.work_id WHERE m.path_key=?",{pathKey(path)});
    if(found.empty()) return Json::object();
    auto result=found[0]; result["nfo_parser"]=0;
    return result;
}

Json Store::prepareWork(const Json& params) {
    std::string id=params.value("workId",std::string{});
    if(id.empty()) {
    const auto candidate=params.at("candidate");
    const auto provider=candidate.at("provider").get<std::string>(),sourceId=candidate.at("id").get<std::string>(),code=candidate.at("code").get<std::string>(),title=candidate.at("title").get<std::string>();
    if(provider.empty()||provider.size()>100||sourceId.empty()||sourceId.size()>200||code.empty()||code.size()>80||title.empty()||title.size()>64000) throw std::runtime_error("收藏资料缺少有效的来源、番号或标题");
    Json nfo={{"num",code},{"title",title},{"uniqueids",Json::array({{{"type","metatube"},{"value",provider+":"+sourceId}}})}};
    id=save({{"kind","metadata"},{"name",title},{"pending",true}},nfo);
    } else if(video(id).is_null()) throw std::runtime_error("作品已不存在，请重新选择");
    {
        std::lock_guard lock(mutex_);
        if(rows(db_,"SELECT path_key FROM nfo_documents WHERE work_id=? AND canonical=1",{id}).empty()) {
            const auto folder=path_.parent_path()/L"metadata"/wide(id);
            fs::create_directories(folder); const auto path=folder/L"movie.nfo";
            run(db_,"INSERT INTO nfo_documents(path_key,work_id,path,canonical) VALUES(?,?,?,1)",{pathKey(path),id,pathText(path)});
        }
    }
    if(params.value("collect",false)) favorite(id,true);
    return video(id);
}

void Store::removeWork(const std::string& id) {
    std::lock_guard lock(mutex_);
    if(!rows(db_,"SELECT id FROM media_files WHERE work_id=? LIMIT 1",{id}).empty()) throw std::runtime_error("作品仍关联视频，请先在媒体清理中处理视频");
    run(db_,"DELETE FROM works WHERE id=?",{id});
}

Json Store::directories() {
    std::lock_guard lock(mutex_);
    auto result=rows(db_,"SELECT d.*,(SELECT count(*) FROM media_files m WHERE m.path_key>=d.path_key||'/' AND m.path_key<d.path_key||'0' AND m.missing=0) AS video_count FROM directories d ORDER BY created_at,id");
    for(auto& dir:result) { dir["formats"]=Json::parse(dir["formats"].get<std::string>()); dir["recursive"]=dir["recursive"].get<int>()!=0; }
    return result;
}
Json Store::assetRoots() {
    std::lock_guard lock(mutex_);
    return rows(db_,"SELECT id,path FROM asset_roots ORDER BY path_key");
}
void Store::rememberAssetRoot(const fs::path& path) {
    if(!path.is_absolute()) return;
    const auto key=pathKey(path);
    // 按路径层级查询索引，不能用字典序前驱（相邻兄弟目录可能排在祖先后面）。
    Json ancestors=Json::array();
    for(auto current=path.lexically_normal(); !current.empty();) {
        ancestors.push_back(pathKey(current));
        const auto parent=current.parent_path(); if(parent==current) break; current=parent;
    }
    if(!rows(db_,"SELECT path_key FROM asset_roots WHERE path_key IN (SELECT value FROM json_each(?)) LIMIT 1",{ancestors.dump()}).empty()) return;
    const auto prefix=key.ends_with('/')?key:key+"/";
    auto upper=prefix; upper.back()='0';
    run(db_,"DELETE FROM asset_roots WHERE path_key>=? AND path_key<?",{prefix,upper});
    run(db_,"INSERT OR IGNORE INTO asset_roots(id,path_key,path) VALUES(?,?,?)",{uuid(),key,pathText(path)});
}
Json Store::addDirectory(const fs::path& path,bool recursive,const Json& formats) {
    std::lock_guard lock(mutex_);
    std::string id;
    for(const auto& row:rows(db_,"SELECT id,path FROM directories")) {
        const auto other=fs::path(wide(row["path"]));
        if(pathKey(other)==pathKey(path)) id=row["id"];
        else if(within(path,other)||within(other,path)) throw std::runtime_error("所选目录与已有目录重叠，请扫描已有目录");
    }
    if(id.empty()) id=uuid();
    rememberAssetRoot(path);
    run(db_,"INSERT INTO directories(id,path,path_key,recursive,formats) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET recursive=excluded.recursive,formats=excluded.formats",{id,pathText(path),pathKey(path),recursive,formats.dump()});
    return {{"id",id},{"path",pathText(path)},{"recursive",recursive},{"formats",formats}};
}
Json Store::removeDirectory(const std::string& id) {
    std::lock_guard lock(mutex_);
    // Stop managing the root; work identities and resource associations remain available for re-linking.
    run(db_,"DELETE FROM directories WHERE id=?",{id});
    if(sqlite3_changes(db_)==0) throw std::runtime_error("媒体目录不存在");
    return {{"removedVideos",0}};
}
void Store::finish(const Json& directory,const std::string& state,const std::string& error,bool reconcile,const std::atomic_bool* cancelled) {
    const auto prefix=pathKey(fs::path(wide(directory["path"])))+"/";
    if(reconcile) for(std::string after;;) {
        if(cancelled && *cancelled) break;
        Json files;
        { std::lock_guard lock(mutex_); files=rows(db_,"SELECT id,path,missing FROM media_files WHERE id>? AND instr(path_key,?)=1 ORDER BY id LIMIT 128",{after,prefix}); }
        for(const auto& file:files) {
            if(cancelled && *cancelled) break;
            after=file["id"]; std::error_code ec; const bool exists=fs::is_regular_file(fs::path(wide(file["path"])),ec);
            if(!ec || ec==std::errc::no_such_file_or_directory || ec==std::errc::not_a_directory) { std::lock_guard lock(mutex_); run(db_,"UPDATE media_files SET missing=? WHERE id=?",{!exists,file["id"]}); }
        }
        if(files.size()<128) break;
    }
    if(!state.empty()) { std::lock_guard lock(mutex_);
        run(db_,"UPDATE directories SET state=?,error=?,scanned_at=CURRENT_TIMESTAMP WHERE id=?",{cancelled && *cancelled && state!="failed"?"cancelled":state,error,directory["id"]}); }
}

Json Store::maintenanceRows(const std::string& after, bool health) {
    std::lock_guard lock(mutex_);
    const std::string extra=health ? ",m.file_stamp,m.codec,w.scan_status,w.poster,w.thumb,w.fanart,(SELECT path FROM nfo_documents WHERE work_id=w.id AND canonical=1) AS nfo" : "";
    auto result = rows(db_,R"SQL(SELECT m.id,m.path,w.title,w.code,m.fast_hash AS hash,m.file_size AS size,m.duration_ms/1000 AS duration,m.missing,
 CASE WHEN m.width>0 AND m.height>0 THEN m.width||'x'||m.height ELSE '' END AS resolution
)SQL"+extra+" FROM media_files m JOIN works w ON w.id=m.work_id WHERE m.id>? ORDER BY m.id LIMIT 500",{after});
    for (auto& row: result) row["missing"] = row["missing"].get<int>() != 0;
    return result;
}
Json Store::fileIdentity(const std::string& id) {
    std::lock_guard lock(mutex_);
    const auto found = rows(db_,"SELECT id,path,file_stamp FROM media_files WHERE id=?",{id});
    if (found.empty()) throw std::runtime_error("要保留的视频记录已不存在，请重新检查");
    return found[0];
}
Json Store::removalInfo(const std::string& id) {
    std::lock_guard lock(mutex_);
    auto found=rows(db_,"SELECT m.id,m.work_id,m.path AS video_path,m.file_stamp,w.poster,w.thumb,w.fanart FROM media_files m JOIN works w ON w.id=m.work_id WHERE m.id=?",{id});
    if(found.empty()) throw std::runtime_error("文件记录已不存在，请刷新");
    auto result=found[0]; const auto workId=result["work_id"];
    Json assets=Json::array(),shared=Json::array(),stems=Json::array();
    for(const auto& row:rows(db_,"SELECT path FROM nfo_documents WHERE work_id=?",{workId})) assets.push_back(row["path"]);
    for(const auto* kind:{"poster","thumb","fanart"}) if(!stringValue(result,kind).empty()) assets.push_back(result[kind]);
    const auto parent=pathKey(fs::path(wide(result["video_path"])).parent_path());
    for(const auto& row:rows(db_,"SELECT id,path,work_id FROM media_files WHERE id<>?",{id})) {
        const auto path=fs::path(wide(row["path"]));
        if(pathKey(path.parent_path())==parent) stems.push_back(lower(pathText(path.stem())));
        if(row["work_id"]==workId) for(const auto& asset:assets) shared.push_back(asset);
    }
    // Work artwork and canonical NFO are retained when deleting a video resource.
    for(const auto& row:rows(db_,"SELECT path FROM nfo_documents WHERE work_id<>?",{workId})) shared.push_back(row["path"]);
    for(const auto& row:rows(db_,"SELECT poster,thumb,fanart FROM works WHERE id<>?",{workId})) for(const auto* kind:{"poster","thumb","fanart"}) if(!stringValue(row,kind).empty()) shared.push_back(row[kind]);
    result["assets"]=assets;result["shared"]=shared;result["siblingStems"]=stems;
    return result;
}
void Store::completeRemoval(const std::string& id,bool metadataOnly) {
    std::lock_guard lock(mutex_); Transaction transaction(db_);
    auto files=rows(db_,"SELECT work_id FROM media_files WHERE id=?",{id});
    if(files.empty()) throw std::runtime_error("文件记录已不存在");
    const auto workId=files[0]["work_id"];
    if(metadataOnly) {
        run(db_,"UPDATE works SET original_title='',plot='',studio='',label='',director='',series='',premiered='',runtime_seconds=0,rating=0,poster='',thumb='',fanart='',provenance='{}',scan_status=1,scraped_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?",{workId});
        run(db_,"DELETE FROM nfo_documents WHERE work_id=?",{workId}); run(db_,"DELETE FROM work_entities WHERE work_id=?",{workId});
    } else run(db_,"DELETE FROM media_files WHERE id=?",{id});
    transaction.commit();
}
