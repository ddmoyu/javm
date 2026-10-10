Json Store::documents(const std::string& method,const Json& params) {
    if(method=="library.documents.importStream") {
        const fs::path path=fs::path(wide(stringValue(params,"path"))).lexically_normal();
        const auto content=stringValue(params,"content"), url=stringValue(params,"url");
        if(!path.is_absolute() || lower(pathText(path.extension()))!=".strm" || content.size()>8192 || url.size()>8192 ||
           !std::regex_match(url,std::regex(R"(^https?://[^/@\s]+[^\s]*$)",std::regex::icase))) throw std::runtime_error("STRM 路径或网络地址无效");
        const auto authorityStart=url.find("://")+3, authorityEnd=url.find_first_of("/?#",authorityStart);
        if(url.substr(authorityStart,authorityEnd-authorityStart).find('@')!=std::string::npos) throw std::runtime_error("STRM 不能包含登录凭据");
        for(auto part=path;!part.empty();part=part.parent_path()) { if(reparse(part)) throw std::runtime_error("不导入链接目录中的 STRM"); if(part==part.root_path()) break; }
        if(!fs::is_regular_file(path) || fs::file_size(path)>8192) throw std::runtime_error("STRM 不存在或超过 8 KiB");
        const auto signature=stamp(path);
        std::ifstream stream(path,std::ios::binary); std::string bytes(8193,'\0'); stream.read(bytes.data(),static_cast<std::streamsize>(bytes.size())); bytes.resize(static_cast<size_t>(stream.gcount()));
        if(stream.bad() || bytes!=content || stamp(path)!=signature) throw std::runtime_error("STRM 文件正在变化，请重新导入");
        auto normalized=trim(bytes); if(normalized.starts_with("\xEF\xBB\xBF")) normalized=trim(normalized.substr(3));
        if(normalized!=url) throw std::runtime_error("STRM 地址与文件内容不一致");
        Json file={{"path",pathText(path)},{"parent",pathText(path.parent_path())},{"name",pathText(path.stem())},{"size",bytes.size()},
            {"file_stamp",signature},{"fast_hash",fastHash(path)},{"codec","STRM"},{"stream_url",url}};
        Json metadata=Json::object(); std::string original;
        const auto code=stringValue(params,"code"); if(code.size()>80) throw std::runtime_error("番号过长"); if(!code.empty()) metadata["num"]=code;
        auto nfo=path; nfo.replace_extension(L".nfo");
        if(fs::exists(nfo)) {
            if(reparse(nfo)) throw std::runtime_error("不导入符号链接 NFO");
            const auto before=stamp(nfo); metadata=readNfo(nfo,&original);
            if(stamp(nfo)!=before) throw std::runtime_error("NFO 正在变化，请重试");
            file["nfo_path"]=pathText(nfo);file["nfo_stamp"]=before;file["nfo_parser"]=nfoParserVersion;
        }
        return {{"id",save(file,metadata,original.empty()?nullptr:&original)}};
    }
    std::lock_guard lock(mutex_);
    if(method=="library.documents.list") return rows(db_,"SELECT id FROM works WHERE id>? ORDER BY id LIMIT 100",{stringValue(params,"after")});
    if(method!="library.documents.nfo") throw std::runtime_error("未知资料文件操作");
    const auto id=stringValue(params,"id");
    auto result=rows(db_,"SELECT * FROM javm_catalog WHERE id=?",{id});
    if(result.empty()) throw std::runtime_error("作品已不存在");
    const auto provenance=Json::parse(result[0]["provenance"].get<std::string>());
    const auto work=decorate(result)[0];
    Json metadata={{"title",work["title"]},{"originaltitle",work["original_title"]},{"num",work["code"]},{"plot",work["plot"]},
        {"studio",work["studio"]},{"label",work["label"]},{"director",work["director"]},{"series",work["series"]},{"premiered",work["premiered"]},
        {"rating",work["rating"]},{"runtimeSeconds",work["runtime_seconds"]},{"actor",work["actors"]},{"genre",work["genres"]},{"tag",work["tags"]}};
    auto source=provenance.value("_scrape",Json::object()); source["workId"]=id; source["hasVideo"]=!work["media_files"].empty();
    return {{"id",id},{"code",work["code"]},{"content",serializeNfo(metadata,source)}};
}
