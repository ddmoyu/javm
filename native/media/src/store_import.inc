Json Store::legacyCandidate() {
    std::lock_guard lock(mutex_);
    return legacy::candidate(db_,path_);
}
Json Store::importLegacy(const std::atomic_bool& cancelled,const legacy::Progress& progress) {
    std::lock_guard lock(mutex_);
    if(legacy::candidate(db_,path_).value("operation",std::string{})=="repair") return repairLegacyDiscovery(cancelled,progress);
    return legacy::importDatabase(db_,path_,cancelled,progress,[&](sqlite3* source) { return importLegacyRows(source,cancelled,progress); });
}
int64_t Store::importLegacyRows(sqlite3* source,const std::atomic_bool& cancelled,const legacy::Progress& progress) {
    auto quote=[](const std::string& name) { std::string out="\""; for(char c:name) { out+=c; if(c=='"') out+='"'; } return out+'"'; };
    auto exists=[&](const std::string& table) { return !rows(source,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",{table}).empty(); };
    auto numeric=[](const Json& row,const char* key,double fallback=0.0) { return row.contains(key)&&row[key].is_number()?row[key].get<double>():fallback; };
    auto stop=[&] { if(cancelled) throw std::runtime_error("导入已取消，原数据库已保留"); };
    const auto origin=pathKey(legacy::sourcePath(path_));
    int64_t count=0;
    // 保存全部原始表和字段，包括尚无 1.0 界面的历史记录；不将旧结构混入运行时表。
    for(const auto& table:rows(source,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
        const auto name=table["name"].get<std::string>();
        Query read(source,"SELECT * FROM "+quote(name)); int64_t number=0;
        while(read.next()) {
            stop(); const auto bytes=Json::to_cbor(read.row());
            Query saved(db_,"INSERT INTO legacy_records(source_path,table_name,row_number,content) VALUES(?1,?2,?3,?4)",Json::array({origin,name,++number}));
            saved.blob(4,std::string(bytes.begin(),bytes.end())); saved.next(); ++count;
            if(count%128==0) progress("importing",count,0);
        }
    }
    if(!exists("videos")) throw std::runtime_error("旧库缺少影片表，未导入");
    Query videos(source,"SELECT * FROM videos ORDER BY id");
    while(videos.next()) {
        stop(); const auto old=videos.row();
        Json nfo=Json::object(), file=Json::object();
        if(old["id"].is_string()) nfo["uniqueids"]=Json::array({{{"type","javm-work"},{"value",old["id"]}}});
        for(const auto& [column,key]:std::map<std::string,std::string>{{"title","title"},{"local_id","num"},{"original_title","originaltitle"},{"studio","studio"},{"director","director"},{"premiered","premiered"},{"plot","plot"},{"series","series"},{"label","label"}})
            if(!stringValue(old,column.c_str()).empty()) nfo[key]=old[column];
        nfo["rating"]=std::clamp(numeric(old,"rating"),0.0,10.0);
        nfo["runtimeSeconds"]=static_cast<int64_t>(std::max(0.0,numeric(old,"duration")));
        for(const auto& [table,key]:{std::pair{"actors","actor"},{"genres","genre"},{"tags","tag"},{"studios","studio"},{"directors","director"},{"series","series"}}) {
            const auto relation=std::string("video_")+table;
            const auto fk=std::string(table)=="series"?"series_id":std::string(table).substr(0,std::string(table).size()-1)+"_id";
            if(!exists(table)||!exists(relation)) continue;
            auto values=Json::array();
            for(const auto& row:rows(source,"SELECT e.name FROM "+quote(table)+" e JOIN "+quote(relation)+" r ON r."+quote(fk)+"=e.id WHERE r.video_id=? ORDER BY "+(std::string(table)=="actors"?"r.priority,e.name":"e.name"),{old["id"]}))
                if(!stringValue(row,"name").empty() && std::find(values.begin(),values.end(),row["name"])==values.end()) values.push_back(row["name"]);
            if(std::string(table)=="actors"||std::string(table)=="genres"||std::string(table)=="tags") nfo[key]=values;
            else if(!nfo.contains(key)&&!values.empty()) nfo[key]=values[0];
        }
        const auto path=fs::path(pathFromText(stringValue(old,"video_path")));
        file["name"]=stringValue(old,"title").empty()?pathText(path.stem()):stringValue(old,"title");
        file["pending"]=numeric(old,"scan_status")<2;
        // 旧扫描器以文件名补标题；不能把它变成正式资料，阻止以后刮削补全。
        if(file["pending"]==true && old.value("nfo_mtime",Json()).is_null()) {
            if(stringValue(old,"title")==pathText(path.stem())) nfo.erase("title");
            if(stringValue(old,"original_title")==pathText(path.stem())) nfo.erase("originaltitle");
        }
        bool present=false;
        if(path.is_absolute()) {
            file.update({{"path",pathText(path)},{"parent",pathText(path.parent_path())},{"size",old.value("file_size",Json())},{"mtime",old.value("file_mtime",Json())},{"fast_hash",stringValue(old,"fast_hash")},{"duration_ms",nfo["runtimeSeconds"].get<int64_t>()*1000}});
            const auto resolution=stringValue(old,"resolution"); std::smatch match;
            if(std::regex_match(resolution,match,std::regex("([0-9]{1,5})[xX]([0-9]{1,5})"))) { file["width"]=std::stoi(match[1]); file["height"]=std::stoi(match[2]); }
            // saveWork 的普通扫描会替换技术信息；迁移先保留新版非空字段，只补空。
            const auto current=rows(db_,"SELECT * FROM media_files WHERE path_key=?",{pathKey(path)});
            if(!current.empty()) {
                const auto& media=current[0];
                for(const auto& [column,key]:{std::pair{"path","path"},{"dir_path","parent"},{"fast_hash","fast_hash"},{"file_stamp","file_stamp"},{"codec","codec"}})
                    if(!stringValue(media,column).empty()) file[key]=media[column];
                for(const auto& [column,key]:{std::pair{"file_size","size"},{"file_mtime","mtime"}})
                    if(!media[column].is_null()) file[key]=media[column];
                for(const auto* key:{"width","height","duration_ms"})
                    if(numeric(media,key)>0) file[key]=media[key];
            }
            std::error_code ec; present=fs::is_regular_file(path,ec);
            if(present && stringValue(file,"file_stamp").empty()) {
                try { file["file_stamp"]=stamp(path); }
                catch(const fs::filesystem_error&) { present=false; } // 离线或检查期间消失的文件仍保留关联。
            }
        } else file["kind"]="metadata";
        for(const auto* kind:{"poster","thumb","fanart"}) if(!stringValue(old,kind).empty()) file[kind]=old[kind];
        const auto id=saveWork(file,nfo,nullptr);
        run(db_,"UPDATE works SET favorite=MAX(favorite,?),created_at=COALESCE(?,created_at),scraped_at=COALESCE(?,scraped_at) WHERE id=?",{numeric(old,"favorite")!=0,old.value("created_at",Json()),old.value("scraped_at",Json()),id});
        if(path.is_absolute()) {
            run(db_,"UPDATE media_files SET missing=? WHERE path_key=?",{!present,pathKey(path)});
        }
    }
    // 发现页的演员/分类作品清单只是浏览缓存，已保存在 legacy_records；不进入片库。
    const auto receipt=Json::to_cbor(Json{{"version",1},{"discoveryArchivedOnly",true}});
    Query saved(db_,"INSERT INTO legacy_records(source_path,table_name,row_number,content) VALUES(?1,'__javm_discovery_repair_v1',0,?2)",Json::array({origin}));
    saved.blob(2,std::string(receipt.begin(),receipt.end())); saved.next();
    if(exists("directories")) {
        Query dirs(source,"SELECT * FROM directories");
        while(dirs.next()) { stop(); const auto old=dirs.row(); const auto path=fs::path(pathFromText(stringValue(old,"path"))); if(!path.is_absolute()) continue;
            bool overlap=false; for(const auto& current:rows(db_,"SELECT path FROM directories")) { const auto other=fs::path(pathFromText(current["path"])); if(within(path,other)||within(other,path)) overlap=true; }
            if(!overlap) run(db_,"INSERT INTO directories(id,path,path_key,recursive,formats) VALUES(?,?,?,1,'[]')",{uuid(),pathText(path),pathKey(path)});
        }
    }
    progress("importing",count,count);
    return count;
}
