namespace {
void checkedOperationPath(const fs::path& path,bool required) {
    if(!path.is_absolute() || path==path.root_path() || pathText(path.relative_path()).find(':')!=std::string::npos || pathText(path).size()>32000)
        throw std::runtime_error("文件路径无效");
    if(!fs::is_directory(path.parent_path())) throw std::runtime_error("文件目录不可访问");
    for(auto p=path;!p.empty();p=p.parent_path()) {
        if(fs::exists(p) && reparse(p)) throw std::runtime_error("文件操作不支持链接或目录联接");
        if(p==p.root_path()) break;
    }
    if((required || fs::exists(path)) && !fs::is_regular_file(path)) throw std::runtime_error("对象不是普通文件");
}
std::string operationIdentity(const fs::path& path) {
    const auto handle=CreateFileW(path.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
    if(handle==INVALID_HANDLE_VALUE) throw std::runtime_error("无法读取文件身份");
    BY_HANDLE_FILE_INFORMATION info{}; const bool ok=GetFileInformationByHandle(handle,&info)!=0; CloseHandle(handle);
    if(!ok || (info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("文件身份不可用");
    return std::to_string(info.dwVolumeSerialNumber)+":"+std::to_string(info.nFileIndexHigh)+":"+std::to_string(info.nFileIndexLow);
}
void sameOperationFile(const fs::path& file,const std::string& identity,const std::string& signature={}) {
    checkedOperationPath(file,true);
    if(operationIdentity(file)!=identity || (!signature.empty() && stamp(file)!=signature)) throw std::runtime_error("文件已变化，已保留文件，请重新核对");
}
}
bool Store::pendingFileOperations() {
    std::lock_guard lock(mutex_);
    return !rows(db_,"SELECT id FROM file_operations WHERE state IN ('copying','ready','committed') LIMIT 1").empty();
}
Json Store::fileOperations(const std::string& method,const Json& params) {
    std::lock_guard lock(mutex_);
    if(method=="library.files.list") return rows(db_,"SELECT * FROM file_operations WHERE state IN ('copying','ready','committed') ORDER BY created_at LIMIT 100");
    if(method=="library.files.relinkPreview") {
        const fs::path oldRoot=fs::path(wide(params.at("oldRoot"))).lexically_normal(),newRoot=fs::path(wide(params.at("newRoot"))).lexically_normal();
        if(!oldRoot.is_absolute() || !newRoot.is_absolute() || !fs::is_directory(newRoot)) throw std::runtime_error("请选择有效的旧根目录和新根目录");
        const auto prefix=pathKey(oldRoot)+"/"; Json result=Json::array();
        for(const auto& row:rows(db_,"SELECT id,path,file_size,fast_hash FROM media_files WHERE substr(path_key,1,?)=? AND id>? ORDER BY id LIMIT 500",{prefix.size(),prefix,params.value("after",std::string{})})) {
            const fs::path old(wide(row["path"])),target=newRoot/old.lexically_relative(oldRoot);
            auto item=row;item["target"]=pathText(target); item["matched"]=false;
            try {
                if(!within(target,newRoot)) throw std::runtime_error("新路径超出所选目录");
                checkedOperationPath(target,true);
                item["matched"]=!fs::exists(old) && !row["file_size"].is_null() && fs::file_size(target)==row["file_size"].get<uint64_t>() && row["fast_hash"]!="" && fastHash(target)==row["fast_hash"].get<std::string>();
            } catch(...) {}
            result.push_back(item);
        }
        return result;
    }
    if(method=="library.files.relink") {
        const auto found=rows(db_,"SELECT path,file_size,fast_hash FROM media_files WHERE id=?",{params.at("id")});
        if(found.empty()) throw std::runtime_error("资源记录已不存在");
        const fs::path old(wide(found[0]["path"])),target=fs::path(wide(params.at("target"))).lexically_normal(); checkedOperationPath(target,true);
        if(fs::exists(old) || found[0]["file_size"].is_null() || fs::file_size(target)!=found[0]["file_size"].get<uint64_t>() || found[0]["fast_hash"]=="" || fastHash(target)!=found[0]["fast_hash"].get<std::string>()) throw std::runtime_error("文件大小或指纹不匹配，未更改关联");
        Transaction transaction(db_);
        run(db_,"UPDATE media_files SET path=?,path_key=?,dir_path=?,file_stamp=?,missing=0 WHERE id=?",{pathText(target),pathKey(target),pathText(target.parent_path()),stamp(target),params.at("id")});
        rememberAssetRoot(target.parent_path());transaction.commit();return Json::object();
    }
    if(method=="library.files.prepare") {
        const auto requestedId=params.value("operationId",std::string{});
        if(!requestedId.empty()) {
            if(!std::regex_match(requestedId,std::regex("[a-fA-F0-9-]{36}"))) throw std::runtime_error("文件操作标识无效");
            const auto previous=rows(db_,"SELECT * FROM file_operations WHERE id=?",{requestedId});
            if(!previous.empty()) {
                if(pathKey(fs::path(wide(previous[0]["source"])))!=pathKey(fs::path(wide(params.at("source")))) || pathKey(fs::path(wide(previous[0]["target"])))!=pathKey(fs::path(wide(params.at("target"))))) throw std::runtime_error("恢复路径不一致");
                return previous[0];
            }
        }
        if(!rows(db_,"SELECT id FROM file_operations WHERE state IN ('copying','ready','committed') LIMIT 1").empty()) throw std::runtime_error("请先恢复或取消未完成的文件操作");
        auto found=params.contains("mediaId")?rows(db_,"SELECT id,path,file_stamp FROM media_files WHERE id=?",{params.at("mediaId")}):rows(db_,"SELECT id,path,file_stamp FROM media_files WHERE path_key=?",{pathKey(fs::path(wide(params.at("source"))))});
        if(found.empty()) {
            if(!params.value("rename",false)) throw std::runtime_error("资源记录已不存在");
            const fs::path file(wide(params.at("source")));checkedOperationPath(file,true);
            found.push_back({{"id",""},{"path",pathText(file)},{"file_stamp",stamp(file)}});
        }
        const fs::path source(wide(found[0]["path"])),target=fs::path(wide(params.at("target"))).lexically_normal();
        checkedOperationPath(source,true); checkedOperationPath(target,false);
        if(stamp(source)!=found[0]["file_stamp"].get<std::string>()) throw std::runtime_error("源文件已变化，请先重新扫描");
        if(pathKey(source)==pathKey(target) || fs::exists(target) || !rows(db_,"SELECT id FROM media_files WHERE path_key=?",{pathKey(target)}).empty()) throw std::runtime_error("目标已存在或已关联其他资源");
        if(lower(pathText(source.extension()))!=lower(pathText(target.extension()))) throw std::runtime_error("整理文件时不能修改视频扩展名");
        const auto name=pathText(target.filename());
        if(name.empty() || name.back()=='.' || name.back()==' ' || name.find_first_of("<>:\"|?*")!=std::string::npos || std::regex_match(name,std::regex("(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\\..*)?",std::regex::icase))) throw std::runtime_error("目标文件名无效");
        const auto id=requestedId.empty()?uuid():requestedId;
        if(params.value("rename",false)) {
            if(pathKey(source.parent_path())!=pathKey(target.parent_path())) throw std::runtime_error("下载改名必须在原目录中进行");
            const auto signature=stamp(source),identity=operationIdentity(source);
            run(db_,"INSERT INTO file_operations(id,media_id,source,target,temporary,source_stamp,source_identity,temporary_identity,target_stamp,size,verified,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'ready')",{id,found[0]["id"],pathText(source),pathText(target),pathText(source),signature,identity,identity,signature,fs::file_size(source),fs::file_size(source)});
            return rows(db_,"SELECT * FROM file_operations WHERE id=?",{id})[0];
        }
        const auto temporary=target.parent_path()/wide(".javm-"+id+".tmp");
        const auto handle=CreateFileW(temporary.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(handle==INVALID_HANDLE_VALUE) throw std::runtime_error("无法创建独占临时文件"); CloseHandle(handle);
        try {
            run(db_,"INSERT INTO file_operations(id,media_id,source,target,temporary,source_stamp,source_identity,temporary_identity,size) VALUES(?,?,?,?,?,?,?,?,?)",{id,found[0]["id"],pathText(source),pathText(target),pathText(temporary),stamp(source),operationIdentity(source),operationIdentity(temporary),fs::file_size(source)});
        } catch(...) { DeleteFileW(temporary.c_str());throw; }
        return rows(db_,"SELECT * FROM file_operations WHERE id=?",{id})[0];
    }
    const auto found=rows(db_,"SELECT * FROM file_operations WHERE id=?",{params.at("id")});
    if(found.empty()) throw std::runtime_error("文件操作记录不存在");
    auto item=found[0]; const auto id=item["id"];
    const fs::path source(wide(item["source"])),target(wide(item["target"])),temporary(wide(item["temporary"]));
    if(item["state"]=="done") { sameOperationFile(target,item["temporary_identity"],item["target_stamp"]); return item; }
    if(item["state"]=="aborted") return item;
    if(method=="library.files.abort") {
        if(item["state"]!="copying") throw std::runtime_error("文件已进入提交阶段，请继续恢复以保证关联一致");
        if(fs::exists(temporary)) { sameOperationFile(temporary,item["temporary_identity"]); if(!DeleteFileW(temporary.c_str())) throw std::runtime_error("临时文件被占用，未取消操作"); }
        run(db_,"UPDATE file_operations SET state='aborted' WHERE id=?",{id});item["state"]="aborted";return item;
    }
    if(method=="library.files.inspect" || method=="library.files.verify") {
        sameOperationFile(source,item["source_identity"],item["source_stamp"]);
        sameOperationFile(temporary,item["temporary_identity"]);
        const auto length=fs::file_size(temporary),verified=item["verified"].get<uint64_t>(),total=item["size"].get<uint64_t>();
        if(length<verified || length>total) throw std::runtime_error("临时文件大小异常，源文件已保留");
        if(method=="library.files.verify" && verified<length) {
            const auto count=static_cast<size_t>(std::min<uint64_t>(1024*1024,length-verified));
            std::vector<char> a(count),b(count); std::ifstream original(source,std::ios::binary),copy(temporary,std::ios::binary);
            original.seekg(verified);copy.seekg(verified);original.read(a.data(),count);copy.read(b.data(),count);
            if(original.gcount()!=static_cast<std::streamsize>(count) || copy.gcount()!=static_cast<std::streamsize>(count) || a!=b) throw std::runtime_error("复制内容核对失败，源文件已保留");
            sameOperationFile(source,item["source_identity"],item["source_stamp"]);
            item["verified"]=verified+count;run(db_,"UPDATE file_operations SET verified=? WHERE id=?",{item["verified"],id});
        }
        item["written"]=length;return item;
    }
    if(method!="library.files.commit") throw std::runtime_error("未知文件操作");
    checkedOperationPath(target,false);
    if(item["state"]=="copying") {
        sameOperationFile(source,item["source_identity"],item["source_stamp"]);sameOperationFile(temporary,item["temporary_identity"]);
        if(item["verified"]!=item["size"] || fs::file_size(temporary)!=item["size"].get<uint64_t>()) throw std::runtime_error("复制尚未核对完成");
        item["target_stamp"]=stamp(temporary);item["state"]="ready";
        run(db_,"UPDATE file_operations SET state='ready',target_stamp=? WHERE id=?",{item["target_stamp"],id});
    }
    if(item["state"]=="ready") {
        if(fs::exists(temporary)) {
            sameOperationFile(temporary,item["temporary_identity"],item["target_stamp"]);
            if(!MoveFileW(temporary.c_str(),target.c_str())) throw std::runtime_error("目标已存在或被占用，文件与恢复记录已保留");
        }
        sameOperationFile(target,item["temporary_identity"],item["target_stamp"]);
        Transaction transaction(db_);
        if(item["media_id"]!="") {
            run(db_,"UPDATE media_files SET path=?,path_key=?,dir_path=?,file_stamp=?,missing=0 WHERE id=? AND path_key=?",{pathText(target),pathKey(target),pathText(target.parent_path()),stamp(target),item["media_id"],pathKey(source)});
            if(sqlite3_changes(db_)!=1) throw std::runtime_error("资源关联已变化，请保留文件并重新核对");
            rememberAssetRoot(target.parent_path());
        }
        run(db_,"UPDATE file_operations SET state='committed' WHERE id=?",{id});transaction.commit();item["state"]="committed";
    }
    sameOperationFile(target,item["temporary_identity"],item["target_stamp"]);
    if(fs::exists(source)) {
        sameOperationFile(source,item["source_identity"],item["source_stamp"]);
        if(!DeleteFileW(source.c_str())) throw std::runtime_error("目标已入库，原文件被占用；稍后恢复可继续清理");
    }
    run(db_,"UPDATE file_operations SET state='done' WHERE id=?",{id}); item["state"]="done";
    run(db_,"DELETE FROM file_operations WHERE state IN ('done','aborted') AND id NOT IN (SELECT id FROM file_operations ORDER BY created_at DESC LIMIT 200)");
    return item;
}
