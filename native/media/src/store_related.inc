Json Store::relatedMedia(const std::string& method,const Json& params) {
    std::lock_guard lock(mutex_);
    const auto id=params.at("id").get<std::string>();
    const auto found=rows(db_,"SELECT path,work_id FROM media_files WHERE id=?",{id});
    if(found.empty()) throw std::runtime_error("视频关联已不存在");
    const auto source=fs::path(wide(found[0]["path"]));
    auto validSubtitle=[](const fs::path& path) {
        static const std::set<std::string> extensions{".srt",".vtt",".ass",".ssa"};
        if(!path.is_absolute() || !extensions.contains(lower(pathText(path.extension())))) throw std::runtime_error("只支持本地 SRT、VTT、ASS 或 SSA 字幕");
        for(auto part=path;!part.empty();part=part.parent_path()) {if(reparse(part)) throw std::runtime_error("字幕路径不能是链接");if(part==part.root_path()) break;}
        if(!fs::is_regular_file(path) || fs::file_size(path)>5*1024*1024) throw std::runtime_error("字幕不存在或超过 5 MiB");
    };
    if(method=="library.related.discover") {
        Json result=Json::array();size_t count=0;const auto stem=lower(pathText(source.stem()));
        for(const auto& item:fs::directory_iterator(source.parent_path())) {
            if(++count>2000) throw std::runtime_error("同目录文件超过 2000 项，请手动选择字幕");
            const auto name=lower(pathText(item.path().stem()));
            if(name!=stem && !name.starts_with(stem+".")) continue;
            try {validSubtitle(item.path());} catch(...) {continue;}
            result.push_back(pathText(item.path()));if(result.size()>=16) break;
        }
        return result;
    }
    if(method!="library.related.save") throw std::runtime_error("不支持的关联操作");
    const int part=params.value("part",0),total=params.value("parts",0);
    const auto subtitles=params.value("subtitles",Json::array());
    if(part<0 || part>99 || total<0 || total>99 || (total && (!part || total<part)) || !subtitles.is_array() || subtitles.size()>16) throw std::runtime_error("分卷或字幕关联参数无效");
    Json validated=Json::array();std::set<std::string> seen;
    for(const auto& value:subtitles) {const auto path=fs::path(wide(value.get<std::string>()));validSubtitle(path);if(seen.insert(pathKey(path)).second) validated.push_back({{"key",pathKey(path)},{"path",pathText(path)}});}
    Transaction transaction(db_);
    run(db_,"INSERT INTO media_parts VALUES(?,?,?) ON CONFLICT(media_id) DO UPDATE SET part_number=excluded.part_number,total=excluded.total",{id,part,total});
    run(db_,"DELETE FROM media_subtitles WHERE media_id=?",{id});
    for(const auto& row:validated) run(db_,"INSERT INTO media_subtitles VALUES(?,?,?)",{id,row["key"],row["path"]});
    transaction.commit();return Json::object();
}
