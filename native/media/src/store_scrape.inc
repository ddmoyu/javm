Json Store::applyScrape(const Json& params, const std::atomic_bool& cancelled) {
    const auto id=params.at("id").get<std::string>();
    const auto& details=params.at("details");
    const auto& incoming=details.at("fields");
    if (!incoming.is_object() || incoming.dump().size()>128*1024) throw std::runtime_error("刮削资料无效或过大");
    const auto provider=details.at("provider").get<std::string>(), providerId=details.at("id").get<std::string>();
    if (provider.empty() || provider.size()>100 || providerId.empty() || providerId.size()>200) throw std::runtime_error("缺少刮削来源身份");
    std::lock_guard lock(mutex_);
    auto found=rows(db_,"SELECT * FROM javm_catalog WHERE id=?",{id});
    if (found.empty()) throw std::runtime_error("影片已不存在");
    auto provenance=Json::parse(found[0]["nfo_data"].get<std::string>());
    const auto manual=provenance.value("_manual",Json::object());
    auto current=decorate(found)[0];
    // 显示别名不改变底层原始资料；只有实际采用的新字段才写回。
    for(const auto* field:{"studio","label","director","series"}) current[field]=found[0][field];
    for(const auto* field:{"actors","genres","tags"}) current[field]=relations(db_,id,field,"");
    auto fusion=details.value("fusion",Json::object());
    const auto sources=fusion.value("sources",Json::array({{{"provider",provider},{"id",providerId}}}));
    if(!sources.is_array() || sources.empty() || sources.size()>5 || fusion.dump().size()>16000) throw std::runtime_error("资料来源记录无效");
    Json identities=Json::array();std::set<std::string> sourceKeys;
    for(const auto& item:sources) {
        const auto name=item.at("provider").get<std::string>(),key=item.at("id").get<std::string>();
        if(name.empty() || name.size()>100 || name.find(':')!=std::string::npos || key.empty() || key.size()>200) throw std::runtime_error("资料来源身份无效");
        sourceKeys.insert(name+":"+key);identities.push_back({{"type","metatube"},{"value",name+":"+key}});
    }
    if(!sourceKeys.contains(provider+":"+providerId)) throw std::runtime_error("资料来源不含主身份");
    const auto fieldSources=fusion.value("fields",Json::object());Json adopted=Json::object();
    if(!fieldSources.is_object() || fieldSources.size()>16) throw std::runtime_error("字段来源记录无效");
    for(const auto& origin:fieldSources) {
        if(!origin.is_object() || !sourceKeys.contains(origin.value("provider",std::string{})+":"+origin.value("id",std::string{})))
            throw std::runtime_error("字段来源与资料身份不一致");
    }
    auto record=[&](const std::string& key) {
        const auto origin=fieldSources.value(key,Json{{"provider",provider},{"id",providerId}});
        if(!sourceKeys.contains(origin.at("provider").get<std::string>()+":"+origin.at("id").get<std::string>())) throw std::runtime_error("字段来源与资料身份不一致");
        adopted[key]=origin;
    };
    const auto filePath=params.value("path",std::string{});
    if (!filePath.empty()) {
        const auto path=fs::path(wide(filePath));
        for(auto part=path;!part.empty();part=part.parent_path()) {
            if(reparse(part)) throw std::runtime_error("视频路径变为链接，请重新关联");
            if(part==part.root_path()) break;
        }
        if(rows(db_,"SELECT id FROM media_files WHERE work_id=? AND path_key=?",{id,pathKey(path)}).empty() || stamp(path)!=params.at("fileStamp").get<std::string>())
            throw std::runtime_error("视频关联或内容已变化，请重试");
    }
    const auto code=incoming.value("code",std::string{});
    if (code.empty() || code.size()>80 || incoming.value("title",std::string{}).empty()) throw std::runtime_error("缺少番号或标题");
    const auto oldCode=stringValue(current,"code");
    if (!oldCode.empty() && codeKey(oldCode)!=codeKey(code)) throw std::runtime_error("刮削番号与片库不一致，请手动确认");
    Json merged=Json::object();
    const std::map<std::string,std::string> fields{{"title","title"},{"originalTitle","original_title"},{"code","code"},{"premiered","premiered"},{"director","director"},{"studio","studio"},{"label","label"},{"plot","plot"},{"series","series"}};
    for (const auto& [key,column]: fields) {
        auto value=stringValue(current,column.c_str());
        const bool generated=column=="title" && provenance.contains("_filenameTitle") && current["title"]==provenance["_filenameTitle"];
        if (!manual.contains(column) && (value.empty() || generated) && incoming.contains(key)) {
            if (!incoming[key].is_string()) throw std::runtime_error("刮削字段格式无效");
            const auto candidate=incoming[key].get<std::string>();
            if (candidate.size()>64000) throw std::runtime_error("刮削字段过长");
            if (!candidate.empty()) {value=candidate;record(key);}
        }
        merged[column]=value;
    }
    for (const auto* key: {"actors","genres","tags"}) {
        auto value=current.value(key,Json::array());
        if (!manual.contains(key) && value.empty() && incoming.contains(key)) {value=incoming[key];if(!value.empty()) record(key);}
        if (!value.is_array() || value.size()>100) throw std::runtime_error("刮削列表无效或过长");
        Json unique=Json::array(); std::set<std::string> seen;
        for (const auto& entry: value) {
            if (!entry.is_string() || entry.get_ref<const std::string&>().size()>800) throw std::runtime_error("刮削列表内容无效");
            const auto text=trim(entry.get<std::string>());
            if (!text.empty() && seen.insert(text).second) unique.push_back(text);
        }
        merged[key]=unique;
    }
    for (const auto* key: {"rating","duration"}) {
        double value=current[key].is_number() ? current[key].get<double>() : 0;
        if (value<=0 && !manual.contains(key) && incoming.contains(key) && incoming[key].is_number()) {
            const auto candidate=incoming[key].get<double>();
            if (!std::isfinite(candidate) || candidate<0 || candidate>(std::string(key)=="rating" ? 5 : 1440)) throw std::runtime_error("刮削评分或时长无效");
            value=candidate*(std::string(key)=="rating" ? 2 : 60);
            if(candidate>0) record(key);
        }
        merged[key]=value;
    }
    const auto nfoPath=fs::path(wide(stringValue(current,"nfo_path")));
    if(!nfoPath.is_absolute()) throw std::runtime_error("作品没有资料保存位置，请重新准备刮削");
    for(auto part=nfoPath;!part.empty();part=part.parent_path()) {
        if(fs::exists(part) && reparse(part)) throw std::runtime_error("资料路径变为链接，已停止写入");
        if(part==part.root_path()) break;
    }
    if ((fs::exists(nfoPath) ? stamp(nfoPath) : std::string{})!=params.value("nfoStamp",std::string{})) throw std::runtime_error("NFO 已被修改，请重试以重新读取最新资料");
    matchWork({{"num",code},{"uniqueids",identities}},id);
    if (cancelled) throw std::runtime_error("刮削已取消");
    std::string warning, poster=stringValue(current,"poster");
    const auto image=params.value("image",std::string{});
    if (!image.empty()) {
        try { poster=pathText(saveScrapedArtwork(fs::path(wide(image)),nfoPath)); }
        catch (const std::exception& error) { warning=std::string("封面未保存：")+error.what(); }
    }
    Json metadata={{"title",merged["title"]},{"originaltitle",merged["original_title"]},{"num",merged["code"]},
        {"plot",merged["plot"]},{"premiered",merged["premiered"]},{"director",merged["director"]},{"studio",merged["studio"]},
        {"label",merged["label"]},{"series",merged["series"]},{"actor",merged["actors"]},{"genre",merged["genres"]},{"tag",merged["tags"]},
        {"rating",merged["rating"]},{"runtimeSeconds",static_cast<int64_t>(merged["duration"].get<double>())}};
    if (!poster.empty()) {
        const auto relative=fs::path(wide(poster)).lexically_relative(nfoPath.parent_path());
        metadata["poster"]=relative.empty() ? poster : utf8(relative.generic_wstring());
    }
    Json source={{"workId",id},{"hasVideo",!current["media_files"].empty()},{"provider",provider},{"id",providerId},{"homepage",details.value("homepage",std::string{})}};
    source["sources"]=sources;
    if(details.value("origin",std::string{})=="metatube") {
        source["origin"]="metatube";
        const auto previewUrl=[](const Json& value) -> std::string {
            if(!value.is_string()) return {};
            const auto url=value.get<std::string>();
            if(url.size()>2048 || (!url.starts_with("https://") && !url.starts_with("http://")) ||
                std::any_of(url.begin(),url.end(),[](unsigned char c){return c<=32 || c==127;})) return {};
            const auto start=url.find("://")+3, end=url.find_first_of("/?#",start);
            const auto authority=url.substr(start,end==std::string::npos?end:end-start);
            return authority.empty() || authority.find('@')!=std::string::npos ? std::string{} : url;
        };
        Json preview={{"homepage",previewUrl(details.value("homepage",Json()))},{"previewImages",Json::array()}};
        for(const auto* key:{"previewVideoUrl","previewVideoHlsUrl"}) {
            const auto url=previewUrl(details.value(key,Json()));
            if(!url.empty()) preview[key]=url;
        }
        const auto images=details.value("previewImages",Json::array());
        std::set<std::string> seen;
        if(images.is_array()) for(const auto& value:images) {
            const auto url=previewUrl(value);
            if(!url.empty() && seen.insert(url).second) preview["previewImages"].push_back(url);
            if(preview["previewImages"].size()>=24) break;
        }
        // 仅保存用户主动刮削得到的链接，普通目录收藏不能触发或覆盖此预览。
        provenance["_preview"]=preview;
    }
    // 文件与 SQLite 无法跨介质原子提交；文件先安全替换，数据库失败时可幂等重试。
    const auto original=writeScrapedNfo(nfoPath,metadata,source,params.value("nfoStamp",std::string{}));
    const auto parsed=readNfo(nfoPath);
    Transaction transaction(db_);
    provenance.update(parsed);
    provenance["_scrape"]=source;
    auto previousFusion=provenance.value("_fusion",Json::object());
    auto previousFields=previousFusion.value("fields",Json::object());previousFields.update(adopted);
    fusion["fields"]=previousFields;fusion["sources"]=sources;provenance["_fusion"]=fusion;
    if (!manual.empty()) provenance["_manual"]=manual;
    if (merged["title"]!=current["title"]) provenance.erase("_filenameTitle");
    if (!poster.empty()) provenance["_local_poster"]=poster;
    run(db_,"UPDATE works SET title=?,original_title=?,code=?,code_key=?,premiered=?,director=?,studio=?,label=?,series=?,plot=?,rating=?,runtime_seconds=?,poster=?,provenance=?,scan_status=2,scraped_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        {merged["title"],merged["original_title"],merged["code"],codeKey(merged["code"]),merged["premiered"],merged["director"],merged["studio"],merged["label"],merged["series"],merged["plot"],merged["rating"],metadata["runtimeSeconds"],poster,provenance.dump(),id});
    for (const auto& [table,key]: {std::pair{"actors","actor"},{"genres","genre"},{"tags","tag"}})
        mergeRelations(db_,id,table,key,merged[table],current[table]);
    for(const auto& item:sources) run(db_,"INSERT OR IGNORE INTO work_sources VALUES(?,?,?)",{item["provider"],item["id"],id});
    Query saved(db_,"UPDATE nfo_documents SET stamp=?1,encoding='UTF-8',parser_version=?2,content=?4 WHERE path_key=?3",Json::array({stamp(nfoPath),nfoParserVersion,pathKey(nfoPath)}));
    saved.blob(4,original); saved.next();
    transaction.commit();
    return {{"warning",warning},{"nfoPath",pathText(nfoPath)}};
}
void Store::updateMetadata(const Json& params) {
    const std::string id = params.at("id");
    const auto& patch = params.at("patch");
    const auto& expected = params.at("expected");
    if (!patch.is_object() || patch.empty() || patch.size() > 15 || !expected.is_object()) throw std::runtime_error("资料修改参数无效");
    const std::map<std::string,std::string> columns{{"title","title"},{"originalTitle","original_title"},{"code","code"},
        {"premiered","premiered"},{"director","director"},{"studio","studio"},{"rating","rating"},{"duration","runtime_seconds"},{"plot","plot"},{"series","series"},{"label","label"}};
    const std::map<std::string,std::string> arrays{{"actors","actor"},{"genres","genre"},{"tags","tag"}};
    auto validateText = [](const Json& value, size_t limit) {
        if (!value.is_string()) throw std::runtime_error("资料文本格式无效");
        const auto text = value.get<std::string>();
        if (text.size() > limit || std::any_of(text.begin(),text.end(),[](unsigned char c) { return c < 32 && c != '\n' && c != '\r' && c != '\t'; })) throw std::runtime_error("资料文本过长或含无效字符");
    };
    for (auto it = patch.begin(); it != patch.end(); ++it) {
        const auto& key = it.key(); const auto& value = it.value();
        if (!columns.contains(key) && !arrays.contains(key) && key != "series" && key != "plot" && key != "label") throw std::runtime_error("不支持的资料字段");
        if (!expected.contains(key)) throw std::runtime_error("缺少原资料，请重新打开影片");
        if (arrays.contains(key)) {
            if (!value.is_array() || value.size() > 100) throw std::runtime_error("资料列表过长");
            for (const auto& name: value) { validateText(name,800); if (trim(name.get<std::string>()).empty()) throw std::runtime_error("资料列表含空名称"); }
            auto unique = value; std::sort(unique.begin(),unique.end());
            if (std::adjacent_find(unique.begin(),unique.end()) != unique.end()) throw std::runtime_error("资料列表含重复名称");
        } else if (key == "duration" || key == "rating") {
            if (!value.is_number() || !std::isfinite(value.get<double>()) || value.get<double>() < 0 || value.get<double>() > (key == "rating" ? 10 : 1440)) throw std::runtime_error("时长或评分超出范围");
        } else validateText(value,key == "plot" ? 64000 : 8000);
        if (key == "title" && trim(value.get<std::string>()).empty()) throw std::runtime_error("影片标题不能为空");
        if (key == "code" && value.get<std::string>().size() > 80) throw std::runtime_error("番号过长");
    }
    std::lock_guard lock(mutex_);
    Transaction transaction(db_);
    auto rowsFound = rows(db_,"SELECT * FROM javm_catalog WHERE id=?",{id});
    if (rowsFound.empty()) throw std::runtime_error("影片已不存在");
    auto provenance = Json::parse(rowsFound[0]["nfo_data"].get<std::string>());
    const auto current = decorate(rowsFound)[0];
    for (auto it = patch.begin(); it != patch.end(); ++it) {
        const auto& key = it.key();
        Json oldValue;
        if (key == "duration") { const auto seconds = current["duration"].is_number() ? current["duration"].get<int64_t>() : 0; oldValue = seconds ? std::max(int64_t{1},(seconds+30)/60) : 0; }
        else if (key == "rating") oldValue = current["rating"].is_number() ? current["rating"] : Json(0);
        else if (arrays.contains(key)) oldValue = current[key];
        else oldValue = stringValue(current,columns.contains(key) ? columns.at(key).c_str() : key.c_str());
        // 未命名的本地视频在前端显示文件名作为标题。
        if (key == "title" && oldValue == "") oldValue = pathText(fs::path(wide(current["video_path"])).filename());
        if (oldValue != expected[key]) throw std::runtime_error("资料已被其他操作更新，请重新打开影片后再保存");
    }
    if (patch.contains("code") && !patch["code"].get<std::string>().empty() && !rows(db_,"SELECT id FROM works WHERE id<>? AND code_key=? LIMIT 1",{id,codeKey(patch["code"])}).empty()) throw std::runtime_error("该番号已存在");
    auto manual = provenance.value("_manual",Json::object());
    for (auto it = patch.begin(); it != patch.end(); ++it) {
        const auto& key = it.key(); auto value = it.value();
        if (columns.contains(key)) {
            if (key == "duration") value = static_cast<int64_t>(value.get<double>()*60);
            run(db_,"UPDATE works SET " + columns.at(key) + "=? WHERE id=?",{value,id});
            manual[key=="duration" ? "duration" : columns.at(key)] = value;
        } else if (arrays.contains(key)) {
            mergeRelations(db_,id,key,arrays.at(key),value,relations(db_,id,key,arrays.at(key)));
            manual[key] = value;
        } else manual[key] = value;
    }
    provenance["_manual"] = manual;
    run(db_,"UPDATE works SET provenance=? WHERE id=?",{provenance.dump(),id});
    if(patch.contains("code")) {
        run(db_,"UPDATE works SET code_key=? WHERE id=?",{codeKey(patch["code"]),id});
        if(codeKey(patch["code"])!=codeKey(current["code"])) run(db_,"DELETE FROM work_sources WHERE work_id=?",{id});
    }
    run(db_,"UPDATE works SET updated_at=CURRENT_TIMESTAMP,scan_status=MAX(COALESCE(scan_status,0),2) WHERE id=?",{id});
    transaction.commit();
}
