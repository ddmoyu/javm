Json Store::resources(const std::string& method,const Json& params) {
    std::lock_guard lock(mutex_);
    if(method=="library.resources.remove") {
        run(db_,"DELETE FROM saved_resources WHERE id=?",{stringValue(params,"id")});
        return Json::object();
    }
    const auto code=trim(stringValue(params,"code")), key=codeKey(code), work=stringValue(params,"workId");
    if(key.empty() || code.size()>80 || work.size()>128) throw std::runtime_error("资源查询参数无效");
    if(method=="library.resources.read") {
        auto result=rows(db_,"SELECT id,code,work_id AS workId,source_id AS sourceId,source_name AS sourceName,stream,saved_at AS savedAt FROM saved_resources WHERE code_key=? AND (work_id IS NULL OR work_id=?) ORDER BY work_id IS NULL,saved_at DESC,id LIMIT 20",{key,work});
        for(auto& row:result) { row["stream"]=Json::parse(row["stream"].get<std::string>()); if(row["workId"].is_null()) row.erase("workId"); }
        return result;
    }
    if(method!="library.resources.save") throw std::runtime_error("未知资源操作");
    const auto source=stringValue(params,"sourceId"), name=stringValue(params,"sourceName");
    if(source.empty() || source.size()>100 || name.empty() || name.size()>256 || !params.contains("stream") || !params["stream"].is_object())
        throw std::runtime_error("资源记录无效");
    auto stream=params["stream"];
    if(!stream.contains("context") || !stream["context"].is_object()) throw std::runtime_error("资源上下文无效");
    stream["context"]["headers"]=Json::object();
    if(stream["context"].contains("publicHeaders")) {
        const auto& headers=stream["context"]["publicHeaders"];
        if(!headers.is_object()) throw std::runtime_error("资源请求头无效");
        for(const auto& [header,value]:headers.items())
            if((header!="referer" && header!="origin" && header!="user-agent") || !value.is_string() || value.get_ref<const std::string&>().size()>8192)
                throw std::runtime_error("不保存私密请求头");
    }
    const auto payload=stream.dump();
    if(payload.size()>32768) throw std::runtime_error("资源记录过大");
    Transaction transaction(db_);
    if(!work.empty() && rows(db_,"SELECT id FROM works WHERE id=? AND code_key=?",{work,key}).empty())
        throw std::runtime_error("作品番号已变化，请重新查找资源");
    const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    run(db_,"INSERT INTO saved_resources VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(lookup_key,source_id) DO UPDATE SET code=excluded.code,stream=excluded.stream,source_name=excluded.source_name,saved_at=excluded.saved_at",
        {uuid(),work.empty()?"code:"+key:"work:"+work,code,key,work.empty()?Json():Json(work),source,name,payload,now});
    run(db_,"DELETE FROM saved_resources WHERE id IN (SELECT id FROM saved_resources ORDER BY saved_at DESC,id LIMIT -1 OFFSET 1000)");
    transaction.commit();
    return Json::object();
}
