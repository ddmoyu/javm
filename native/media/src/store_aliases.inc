Json Store::aliases(const std::string& method,const Json& params,const std::atomic_bool& cancelled) {
    std::lock_guard lock(mutex_);QueryDeadline deadline(db_);
    const auto valid=[](const std::string& name){ return !name.empty() && name.size()<=512 && std::none_of(name.begin(),name.end(),[](unsigned char c){return c<32;}); };
    const auto legacyDimension=[](const std::string& type) {
        const std::map<std::string,std::string> mapping{{"actor","actors"},{"actress","actresses"},{"histrion","maleActors"},{"studio","studios"},{"label","labels"},{"director","directors"},{"genre","genres"},{"series","series"}};
        const auto found=mapping.find(type);return found==mapping.end()?std::string{}:found->second;
    };
    if(method=="library.aliases.restore") {
        struct Group { std::string dimension;std::vector<std::string> names,canonical;bool explicitMerge=false; };
        std::map<std::string,Group> groups;std::set<std::pair<std::string,std::string>> blocked,locked;
        int favorites=0,aliases=0,skipped=0;size_t bytesRead=0,count=0;
        Transaction transaction(db_);
        Query archive(db_,"SELECT source_path,table_name,content FROM legacy_records WHERE table_name IN ('favorites','entity_aliases','alias_overrides','actors') ORDER BY source_path,table_name,row_number");
        while(archive.next()) {
            if(cancelled) throw std::runtime_error("恢复已取消，本次改动已回滚");
            auto entry=archive.row();const auto bytes=entry["content"].get_binary();bytesRead+=bytes.size();
            if(++count>100000 || bytesRead>64*1024*1024) throw std::runtime_error("归档规模超过单次恢复上限，未改动现有规则");
            const auto old=Json::from_cbor(bytes);const auto table=entry["table_name"].get<std::string>();
            const auto dimension=aliasDimension(table=="actors"?"actors":legacyDimension(stringValue(old,"entity_type"))),name=trim(stringValue(old,"name"));
            if(dimension.empty() || !valid(name)) {++skipped;continue;}
            if(table=="favorites") {
                run(db_,"INSERT OR IGNORE INTO facet_favorites VALUES(?,?,1)",{dimension,name});favorites+=sqlite3_changes(db_);continue;
            }
            if(table=="alias_overrides") {
                const auto kind=stringValue(old,"kind");
                if(kind=="block") {blocked.insert({dimension,name});continue;}
                if(kind=="canonical") {locked.insert({dimension,name});continue;}
                if(kind!="merge" || stringValue(old,"group_key").empty()) {++skipped;continue;}
            }
            std::string key=entry["source_path"].get<std::string>()+"\x1f"+dimension+"\x1f";
            if(table=="actors") {
                key+="actor:"+old.value("id",Json()).dump();auto& group=groups[key];group.dimension=dimension;group.canonical.push_back(name);group.names.push_back(name);
                try {for(const auto& alias:Json::parse(stringValue(old,"aliases"))) if(alias.is_string() && valid(alias)) group.names.push_back(alias); } catch(...) {}
            } else {
                const bool manual=table=="alias_overrides";
                key+=(manual?"manual:"+stringValue(old,"group_key"):"entity:"+old.value("entity_id",Json()).dump());
                auto& group=groups[key];group.dimension=dimension;group.explicitMerge=manual;group.names.push_back(name);
                if(!manual && old.value("is_canonical",0)==1) group.canonical.push_back(name);
            }
        }
        for(const auto& [dimension,name]:blocked) {
            run(db_,"INSERT OR IGNORE INTO facet_aliases VALUES(?,?,?,1)",{dimension,name,name});aliases+=sqlite3_changes(db_);
        }
        for(auto& [key,group]:groups) {
            if(cancelled) throw std::runtime_error("恢复已取消，本次改动已回滚");
            std::vector<std::string> chosen;for(const auto& name:group.names) if(locked.contains({group.dimension,name})) chosen.push_back(name);
            if(chosen.empty()) chosen=group.canonical;
            std::sort(chosen.begin(),chosen.end());chosen.erase(std::unique(chosen.begin(),chosen.end()),chosen.end());
            if(chosen.empty() && group.explicitMerge && !group.names.empty()) chosen.push_back(group.names[0]);
            if(chosen.size()!=1 || blocked.contains({group.dimension,chosen[0]})) {skipped+=static_cast<int>(group.names.size());continue;}
            const auto canonical=canonicalName(db_,group.dimension,chosen[0]);
            for(const auto& name:group.names) if(name!=canonical && !blocked.contains({group.dimension,name})) {
                if(!rows(db_,"SELECT 1 FROM facet_aliases WHERE dimension=? AND canonical=? AND blocked=0",{group.dimension,name}).empty()) {++skipped;continue;}
                run(db_,"INSERT OR IGNORE INTO facet_aliases VALUES(?,?,?,0)",{group.dimension,name,canonical});aliases+=sqlite3_changes(db_);
            }
        }
        transaction.commit();return {{"favorites",favorites},{"aliases",aliases},{"skipped",skipped}};
    }
    const auto dimension=aliasDimension(params.value("dimension",std::string("actors")));facetSource(dimension);
    if(dimension=="years" || dimension=="qualities") throw std::runtime_error("这个维度不支持别名");
    if(method=="library.aliases.list") {
        const auto search=params.value("query",std::string{});
        const auto result=rows(db_,"SELECT * FROM (SELECT alias,canonical,blocked,COALESCE((SELECT label FROM facet_names WHERE dimension=a.dimension AND name=a.canonical),'') AS label FROM facet_aliases a WHERE dimension=? UNION ALL SELECT name,name,0,label FROM facet_names n WHERE dimension=? AND label<>'' AND NOT EXISTS(SELECT 1 FROM facet_aliases a WHERE a.dimension=n.dimension AND a.alias=n.name)) WHERE instr(alias,?)>0 OR instr(canonical,?)>0 OR instr(label,?)>0 ORDER BY alias LIMIT 50 OFFSET ?",{dimension,dimension,search,search,search,std::max(0,params.value("offset",0))});
        return result;
    }
    const auto alias=trim(params.value("alias",std::string{}));if(!valid(alias)) throw std::runtime_error("请输入有效名称");
    if(method=="library.aliases.remove") {Transaction transaction(db_);run(db_,"DELETE FROM facet_aliases WHERE dimension=? AND alias=?",{dimension,alias});run(db_,"DELETE FROM facet_names WHERE dimension=? AND name=?",{dimension,alias});transaction.commit();return Json::object();}
    if(method!="library.aliases.save") throw std::runtime_error("未知名称管理操作");
    const bool block=params.value("blocked",false);const auto name=trim(params.value("canonical",std::string{})),label=trim(params.value("label",std::string{}));
    if(!valid(name) || (!label.empty()&&!valid(label))) throw std::runtime_error("规范名称或显示名称无效");
    const auto canonical=block?alias:canonicalName(db_,dimension,name);
    if(block && !rows(db_,"SELECT 1 FROM facet_aliases WHERE dimension=? AND canonical=? AND blocked=0",{dimension,alias}).empty()) throw std::runtime_error("此名称是其他别名的规范名称，请先移除那些归并规则");
    if(alias==canonical && name!=alias && !block) throw std::runtime_error("别名不能形成循环");
    if(rows(db_,"SELECT count(*) AS total FROM facet_aliases")[0]["total"].get<int64_t>()>=100000 && rows(db_,"SELECT 1 FROM facet_aliases WHERE dimension=? AND alias=?",{dimension,alias}).empty()) throw std::runtime_error("别名规则超过 100000 项");
    Transaction transaction(db_);
    if(!block) run(db_,"UPDATE facet_aliases SET canonical=? WHERE dimension=? AND canonical=? AND blocked=0",{canonical,dimension,alias});
    if(alias==canonical && !block) run(db_,"DELETE FROM facet_aliases WHERE dimension=? AND alias=?",{dimension,alias});
    else run(db_,"INSERT INTO facet_aliases VALUES(?,?,?,?) ON CONFLICT(dimension,alias) DO UPDATE SET canonical=excluded.canonical,blocked=excluded.blocked",{dimension,alias,canonical,block});
    run(db_,"INSERT INTO facet_names VALUES(?,?,?) ON CONFLICT(dimension,name) DO UPDATE SET label=excluded.label",{dimension,canonical,label});
    transaction.commit();return Json::object();
}
