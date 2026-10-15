Json LibraryService::backup(const std::string& method,const Json& params) {
    if(method=="library.backup.status") {std::lock_guard lock(progressMutex_);return backup_;}
    if(method=="library.backup.cancel") {
        std::lock_guard lock(progressMutex_);
        if(recovering_ && (!params.contains("id") || params["id"]==backup_.value("id",std::string{}))) cancelled_=true;
        return Json::object();
    }
    if(method!="library.backup.start") throw std::runtime_error("未知备份操作。");
    const std::string operation=params.at("operation");
    const std::string id=params.at("id");
    if((operation!="create" && operation!="inspect" && operation!="restore") || id.empty() || id.size()>100) throw std::runtime_error("备份操作参数无效。");
    std::lock_guard lock(startMutex_);
    {std::lock_guard progressLock(progressMutex_);if(backup_.value("id",std::string{})==id) return backup_;}
    if(busy_ || !removal_.is_null()) throw std::runtime_error("请等待当前扫描、导入或清理任务结束。");
    if(store_.pendingFileOperations()) throw std::runtime_error("请先恢复或取消文件整理任务。");
    if(worker_.joinable()) worker_.join();
    cancelled_=false;
    {std::lock_guard progressLock(progressMutex_);backup_={{"id",id},{"operation",operation},{"state","running"},{"phase","preparing"},{"processed",0},{"total",0},{"error",""}};}
    busy_=true;recovering_=true;
    try {
        worker_=std::thread([this,operation,params] {
            try {
                auto result=store_.backup(operation,params,cancelled_,[this](const std::string& phase,int64_t done,int64_t total) {
                    std::lock_guard lock(progressMutex_);backup_["phase"]=phase;backup_["processed"]=done;backup_["total"]=total;
                });
                if(operation=="restore") {
                    try {refreshDirectories();}
                    catch(...) {std::lock_guard lock(progressMutex_);backup_["warning"]="片库已恢复，请重启应用刷新目录。";}
                }
                std::lock_guard lock(progressMutex_);
                if(result.contains("warning")) backup_["warning"]=result["warning"];
                backup_["result"]=std::move(result);backup_["state"]="completed";
                if(operation=="restore") {progress_=nullptr;++revision_;}
            } catch(const std::exception& error) {
                const std::string message=error.what();
                const bool wasCancelled=cancelled_ && (message=="interrupted" || message=="操作已取消，原片库保留。");
                std::lock_guard lock(progressMutex_);backup_["state"]=wasCancelled ? "cancelled" : "failed";backup_["error"]=message;
            }
            recovering_=false;busy_=false;
        });
    } catch(...) {recovering_=false;busy_=false;std::lock_guard progressLock(progressMutex_);backup_["state"]="failed";backup_["error"]="无法启动后台备份任务。";throw;}
    return Json::object();
}
