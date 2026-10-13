Json Store::applicationInstance(const std::string& method,const Json& params) {
    std::lock_guard lock(mutex_);
    if(method=="library.instance.claim") {
        if(mainInstance_) return {{"primary",true}};
        const auto args=params.value("args",Json::array());
        if(!args.is_array() || args.size()>32 || args.dump().size()>16384) throw std::runtime_error("启动参数过多或过长");
        for(const auto& value:args) if(!value.is_string() || value.get_ref<const std::string&>().find('\0')!=std::string::npos) throw std::runtime_error("启动参数无效");
        // 同一数据目录只有一个主界面；播放器和隐藏取流页不调用 claim。
        auto instance=std::make_unique<MainInstanceLock>(path_);
        const bool primary=instance->primary();
        // A damaged library must still open the recovery UI without executing archived launches.
        if(!healthy()) {if(primary) mainInstance_=std::move(instance);return {{"primary",primary}};}
        {
            Transaction transaction(db_);
            // 只有主实例能把遗留的扫描状态标为中断；第二次启动不得改写主实例正在进行的扫描。
            if(primary) {run(db_,"DELETE FROM app_launches");run(db_,"UPDATE directories SET state='interrupted',error='上次扫描中断，可重新扫描' WHERE state='scanning'");}
            else run(db_,"DELETE FROM app_launches WHERE created<unixepoch()-300");
            if(rows(db_,"SELECT count(*) AS count FROM app_launches")[0]["count"].get<int>()>=32) throw std::runtime_error("启动请求队列已满，请稍后重试");
            if(!primary || !args.empty()) run(db_,"INSERT INTO app_launches(payload) VALUES(?)",{args.dump()});
            transaction.commit();if(primary) mainInstance_=std::move(instance);
            return {{"primary",primary}};
        }
    }
    if(method=="library.instance.take") {
        if(!mainInstance_) throw std::runtime_error("当前进程不是主实例");
        if(!healthy()) return Json::array();
        Transaction transaction(db_);run(db_,"DELETE FROM app_launches WHERE created<unixepoch()-300");
        Json result=Json::array();for(const auto& row:rows(db_,"SELECT payload FROM app_launches ORDER BY id LIMIT 32")) result.push_back(Json::parse(row["payload"].get<std::string>()));
        run(db_,"DELETE FROM app_launches");transaction.commit();return result;
    }
    throw std::runtime_error("不支持的启动操作");
}
