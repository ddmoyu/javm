Json Store::artwork(const std::string& method,const Json& params) {
    if(method=="library.artwork.pending") {
        // 没有任何封面、但有可截帧本地视频的作品；同一视频截帧失败过的不再列出。
        const auto limit=std::clamp(params.value("limit",50),1,200);
        std::lock_guard lock(mutex_);
        return rows(db_,R"SQL(SELECT w.id,m.id AS video_id,m.path,m.file_stamp,m.duration_ms FROM works w
JOIN media_files m ON m.id=(SELECT id FROM media_files WHERE work_id=w.id AND missing=0 AND codec<>'STRM' AND duration_ms>0 ORDER BY created_at,id LIMIT 1)
WHERE w.poster='' AND w.thumb='' AND w.fanart='' AND w.id>?
AND COALESCE(json_extract(w.provenance,'$._auto.failed'),'')<>m.file_stamp
ORDER BY w.id LIMIT ?)SQL",{params.value("after",std::string{}),limit});
    }
    const auto id=stringValue(params,"id");
    if(!std::regex_match(id,std::regex("[A-Za-z0-9_-]{1,128}"))) throw std::runtime_error("作品标识无效");
    const auto root=(path_.parent_path()/L"metadata"/wide(id)/L"images").lexically_normal();
    const auto checked=[&](const fs::path& file) {
        if(!within(file,root) || pathKey(file.parent_path())!=pathKey(root)) throw std::runtime_error("图片不属于作品管理目录");
        for(auto part=file;!part.empty();part=part.parent_path()) { if(fs::exists(part) && reparse(part)) throw std::runtime_error("图片目录包含链接，已停止操作"); if(part==part.root_path()) break; }
    };
    checked(root/L"check");
    std::lock_guard lock(mutex_);
    auto works=rows(db_,"SELECT code,title,provenance,poster FROM works WHERE id=?",{id});
    if(works.empty()) throw std::runtime_error("作品已不存在");
    if(method=="library.artwork.prepare") {
        fs::create_directories(root);
        auto result=works[0]; result["directory"]=pathText(root);
        result["videos"]=rows(db_,"SELECT id,path,file_stamp,duration_ms FROM media_files WHERE work_id=? AND missing=0 AND codec<>'STRM' ORDER BY created_at,id LIMIT 20",{id});
        result["source"]=Json::parse(result["provenance"].get<std::string>()).value("_scrape",Json::object());
        result.erase("provenance");
        return result;
    }
    if(method=="library.artwork.failed") {
        // 记录截帧失败的视频指纹；视频变化后会重新尝试。
        auto provenance=Json::parse(works[0]["provenance"].get<std::string>());
        provenance["_auto"]["failed"]=stringValue(params,"fileStamp");
        run(db_,"UPDATE works SET provenance=? WHERE id=?",{provenance.dump(),id});
        return Json::object();
    }
    if(method=="library.artwork.remove") {
        const auto selected=params.value("images",Json::array());
        if(!selected.is_array() || selected.size()>100) throw std::runtime_error("图片选择无效");
        Json removed=Json::array();
        Transaction transaction(db_);
        for(const auto& row:rows(db_,"SELECT id,path FROM work_artwork WHERE work_id=? AND kind<>'poster'",{id})) {
            if(!params.value("clear",false) && std::find(selected.begin(),selected.end(),row["id"])==selected.end()) continue;
            const fs::path file(wide(row["path"])); checked(file);
            if(fs::exists(file) && !fs::is_regular_file(file)) throw std::runtime_error("图片路径已变化，请重新检查");
            removed.push_back(row["path"]);
            run(db_,"DELETE FROM work_artwork WHERE id=?",{row["id"]});
        }
        transaction.commit(); return removed;
    }
    if(method!="library.artwork.commit") throw std::runtime_error("未知图片操作");
    const auto images=params.value("images",Json::array());
    if(!images.is_array() || images.empty() || images.size()>24) throw std::runtime_error("每次最多保存 24 张图片");
    const auto posterCount=std::count_if(images.begin(),images.end(),[](const Json& image){ return image.value("kind",std::string{})=="poster"; });
    if(posterCount>1) throw std::runtime_error("每次只能保存一张封面");
    // 自动封面只在作品完全没有封面时写入，并单独标记，之后的刮削或手动封面可以替换它。
    const bool automatic=params.value("automatic",false);
    if(automatic) {
        if(posterCount!=1 || images.size()!=1) throw std::runtime_error("自动封面只能提交一张封面");
        const auto current=rows(db_,"SELECT poster,thumb,fanart FROM works WHERE id=?",{id})[0];
        if(!stringValue(current,"poster").empty() || !stringValue(current,"thumb").empty() || !stringValue(current,"fanart").empty())
            return {{"retired",Json::array()},{"skipped",true}};
    }
    const auto previous=posterCount?rows(db_,"SELECT path FROM work_artwork WHERE work_id=? AND kind='poster'",{id}):Json::array();
    if(rows(db_,"SELECT count(*) AS total FROM work_artwork WHERE work_id=?",{id})[0]["total"].get<int>()+images.size()-previous.size()>100) throw std::runtime_error("每部作品最多保存 100 张图片，请先清理截图");
    if(params.contains("video")) {
        const auto video=params.at("video");
        const auto found=rows(db_,"SELECT path,file_stamp FROM media_files WHERE id=? AND work_id=?",{video.at("id"),id});
        if(found.empty() || found[0]["file_stamp"]!=video.at("file_stamp") || stamp(fs::path(wide(found[0]["path"])))!=video.at("file_stamp").get<std::string>()) throw std::runtime_error("视频文件已变化，请重新扫描后截图");
    }
    Transaction transaction(db_);
    for(const auto& item:images) {
        const auto kind=item.value("kind",std::string{}); const fs::path file=fs::path(wide(item.at("path"))).lexically_normal(); checked(file);
        if(!std::regex_match(pathText(file.filename()),std::regex("[a-f0-9-]{36}\\.jpg",std::regex::icase))) throw std::runtime_error("图片文件名无效");
        if(kind!="poster" && kind!="screenshot" && kind!="sheet") throw std::runtime_error("图片用途无效");
        if(!fs::is_regular_file(file) || fs::file_size(file)>20*1024*1024) throw std::runtime_error("图片无效或超过 20 MiB");
        std::ifstream image(file,std::ios::binary); unsigned char signature[3]{}; image.read(reinterpret_cast<char*>(signature),3);
        if(signature[0]!=0xff || signature[1]!=0xd8 || signature[2]!=0xff) throw std::runtime_error("图片不是处理后的 JPEG");
        const auto seconds=item.value("seconds",0.0); if(!std::isfinite(seconds) || seconds<0 || seconds>86400) throw std::runtime_error("截图时间无效");
        if(kind=="poster") {
            if(params.value("expectedPoster",std::string{})!=works[0]["poster"].get<std::string>()) throw std::runtime_error("封面已变化，请重新打开编辑器");
            auto provenance=Json::parse(works[0]["provenance"].get<std::string>());
            if(automatic) { provenance["_auto"]["poster"]=pathText(file); provenance["_auto"].erase("failed"); }
            else { provenance["_manual"]["poster"]=pathText(file); if(provenance.contains("_auto")) provenance["_auto"].erase("poster"); }
            run(db_,"UPDATE works SET poster=?,provenance=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",{pathText(file),provenance.dump(),id});
            run(db_,"DELETE FROM work_artwork WHERE work_id=? AND kind='poster'",{id});
        }
        run(db_,"INSERT INTO work_artwork(id,work_id,path,kind,seconds) VALUES(?,?,?,?,?)",{uuid(),id,pathText(file),kind,seconds});
    }
    transaction.commit();
    Json retired=Json::array();
    for(const auto& old:previous) {
        const fs::path file(wide(old["path"]));
        if(std::any_of(images.begin(),images.end(),[&](const Json& image){ return pathKey(fs::path(wide(image.at("path"))))==pathKey(file); })) continue;
        try { checked(file); retired.push_back(old["path"]); } catch(...) { /* Preserve files outside our managed directory. */ }
    }
    return {{"retired",retired}};
}
