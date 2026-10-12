Json Store::relatedMedia(const std::string& method,const Json& params) {
    std::lock_guard lock(mutex_);
    const auto id=params.at("id").get<std::string>();
    const auto found=rows(db_,"SELECT path,work_id FROM media_files WHERE id=?",{id});
    if(found.empty()) throw std::runtime_error("视频关联已不存在");
    if(method!="library.related.save") throw std::runtime_error("不支持的关联操作");
    const int part=params.value("part",0),total=params.value("parts",0);
    if(params.contains("subtitles")) throw std::runtime_error("字幕功能不在当前范围。");
    if(part<0 || part>99 || total<0 || total>99 || (total && (!part || total<part))) throw std::runtime_error("分卷参数无效");
    Transaction transaction(db_);
    run(db_,"INSERT INTO media_parts VALUES(?,?,?) ON CONFLICT(media_id) DO UPDATE SET part_number=excluded.part_number,total=excluded.total",{id,part,total});
    // Existing legacy associations remain archived; changing part order never deletes user data.
    transaction.commit();return Json::object();
}
