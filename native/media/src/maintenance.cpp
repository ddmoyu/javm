#include "scanner.hpp"
#include <set>

namespace media {
namespace {
// 删除仍由 TS 通过官方 filesystem API 执行。原生只读取文件信息、锁定数据库变更并校验结果。
bool checkedFile(const fs::path& path) {
    if (!path.is_absolute() || path == path.root_path()) throw std::runtime_error("清理文件路径无效");
    if (pathText(path.relative_path()).find(':') != std::string::npos) throw std::runtime_error("不支持清理附加数据流");
    if (!fs::is_directory(path.parent_path())) throw std::runtime_error("视频目录离线或不可访问，未移除数据库记录");
    for (auto part = path.parent_path(); !part.empty(); part = part.parent_path()) {
        if (reparse(part)) throw std::runtime_error("不能清理符号链接或目录联接中的文件");
        if (part == part.root_path()) break;
    }
    if (!fs::exists(path)) return false;
    if (reparse(path) || !fs::is_regular_file(path)) throw std::runtime_error("清理对象不是普通文件：" + pathText(path));
    return true;
}
std::string ext(const fs::path& path) { return lower(pathText(path.extension())); }
const std::set<std::string> images{".jpg",".jpeg",".png",".webp"};
const std::set<std::string> subtitles{".srt",".ass",".ssa",".vtt",".sub",".idx",".smi",".sup",".sbv",".dfxp",".ttml",".scc",".usf"};
void checkRetainedCopy(const Json& retained) {
    if (retained.is_null()) return;
    const fs::path path(wide(retained.at("path")));
    if (!checkedFile(path) || fs::file_size(path) == 0)
        throw std::runtime_error("要保留的视频已丢失或不可用，未继续删除，请重新扫描并选择保留文件");
    if (stamp(path) != retained.at("stamp").get<std::string>())
        throw std::runtime_error("要保留的视频已变化，未继续删除，请重新扫描后核对");
}
}

Json LibraryService::maintenance(const std::string& method, const Json& params) {
    std::lock_guard lock(startMutex_);
    if (method == "library.maintenance.abort") {
        cancelledRemoval_ = params.at("token");
        if (!removal_.is_null() && removal_["token"] == cancelledRemoval_) removal_ = nullptr;
        return Json::object();
    }
    if (busy_) throw std::runtime_error("请等待目录扫描或旧数据导入完成后再检查和清理");
    if (method == "library.maintenance.read") {
        if (!removal_.is_null()) throw std::runtime_error("正在清理影片，请稍候再检查");
        uint64_t revision;
        { std::lock_guard progressLock(progressMutex_); revision = revision_; }
        if (params.contains("revision") && params["revision"] != revision) throw std::runtime_error("片库已发生变化，请重新检查");
        const bool health=params.value("health",false);
        auto items=store_.maintenanceRows(params.value("after",std::string{}),health);
        if(health) for(auto& item:items) {
            Json issues=Json::array();
            const fs::path path(wide(item.at("path")));
            try {
                if(!checkedFile(path)) { issues.push_back("视频文件缺失"); item["missing"]=true; }
                else {
                    item["missing"]=false;
                    const auto size=fs::file_size(path);
                    item["size"]=size;
                    if(size==0) issues.push_back("视频文件为空");
                    if(!item.at("file_stamp").get<std::string>().empty() && stamp(path)!=item.at("file_stamp").get<std::string>())
                        issues.push_back("视频已变化，需要重新扫描");
                    if(item.at("codec")!="STRM" && (item.at("duration").get<int64_t>()<=0 || item.at("resolution")=="")) issues.push_back("视频探测资料不完整");
                }
            } catch(const std::exception&) { issues.push_back("目录离线、不可访问或包含链接"); item["missing"]=true; }
            if(item.at("code")=="" || item.at("scan_status").get<int>()<2) issues.push_back("作品资料未补全");
            if(item.at("nfo").is_null()) issues.push_back("缺少规范 NFO");
            else { std::error_code ec; if(!fs::is_regular_file(fs::path(wide(item.at("nfo"))),ec) || ec) issues.push_back("NFO 不可访问"); }
            bool artwork=false;
            for(const auto* kind:{"poster","thumb","fanart"}) {
                const auto value=item.at(kind).get<std::string>();
                if(!value.empty()) { std::error_code ec; artwork=artwork || (fs::is_regular_file(fs::path(wide(value)),ec) && !ec); }
                item.erase(kind);
            }
            if(!artwork) issues.push_back("缺少可访问的封面");
            item.erase("file_stamp");item.erase("nfo");item.erase("codec");item.erase("scan_status");item["issues"]=issues;
        }
        return {{"revision",revision},{"items",items}};
    }
    const auto token = params.at("token").get<std::string>();
    if (token.empty() || token.size() > 100) throw std::runtime_error("清理请求标识无效");
    if (method == "library.maintenance.prepare") {
        if (cancelledRemoval_ == token) throw std::runtime_error("清理已取消");
        if (!removal_.is_null()) {
            if (removal_["token"] == token) return removal_;
            throw std::runtime_error("正在清理另一部影片，请稍候");
        }
        const auto info = store_.removalInfo(params.at("id"));
        const auto path = fs::path(wide(info.at("video_path"))).lexically_normal();
        if (pathKey(path) != pathKey(fs::path(wide(params.at("path"))))) throw std::runtime_error("视频路径已变化，请重新检查");
        const bool exists = checkedFile(path), metadataOnly = params.at("metadataOnly");
        if (exists && !info.at("file_stamp").get<std::string>().empty() && stamp(path) != info.at("file_stamp").get<std::string>())
            throw std::runtime_error("视频文件已变化，请重新扫描后核对");
        Json retained = nullptr;
        if (!metadataOnly && params.value("requireRetainedCopy",false) && exists && fs::file_size(path) > 0) {
            if (!params.contains("retained") || !params["retained"].is_object())
                throw std::runtime_error("重复清理需要保留一个可用视频，请取消勾选要保留的文件");
            const auto& requested = params.at("retained");
            const auto copy = store_.fileIdentity(requested.at("id"));
            const fs::path copyPath(wide(copy.at("path")));
            if (copy.at("id") == info.at("id") || pathKey(copyPath) == pathKey(path) ||
                pathKey(copyPath) != pathKey(fs::path(wide(requested.at("path")))))
                throw std::runtime_error("保留视频的路径或身份已变化，请重新检查");
            if (!checkedFile(copyPath) || fs::file_size(copyPath) == 0)
                throw std::runtime_error("要保留的视频已丢失或不可用，未删除任何文件，请重新扫描");
            const auto signature = stamp(copyPath);
            if (!copy.at("file_stamp").get<std::string>().empty() && signature != copy.at("file_stamp").get<std::string>())
                throw std::runtime_error("要保留的视频已变化，未删除任何文件，请重新扫描后核对");
            retained = {{"id",copy.at("id")},{"path",pathText(copyPath)},{"stamp",signature}};
        }
        std::set<std::string> shared, added;
        for (const auto& value: info["shared"]) shared.insert(pathKey(fs::path(wide(value))));
        Json files = Json::array();
        unsigned preserved = 0;
        const auto stem = lower(pathText(path.stem()));
        bool sameStem = false;
        for (const auto& other: info["siblingStems"]) if (other == stem) sameStem = true;
        auto add = [&](const fs::path& candidate) {
            const auto normalized = candidate.lexically_normal();
            const auto key = pathKey(normalized);
            if (!added.insert(key).second) return;
            if (shared.contains(key)) { ++preserved; return; }
            if (!metadataOnly && pathKey(normalized.parent_path()) != pathKey(path.parent_path())) { ++preserved; return; }
            if (sameStem && key != pathKey(path)) {
                const auto name = lower(pathText(normalized.stem()));
                if (name == stem || name.starts_with(stem+"-")) {
                    if (fs::exists(normalized)) ++preserved;
                    return;
                }
            }
            if (checkedFile(normalized)) files.push_back({{"path",pathText(normalized)},{"stamp",stamp(normalized)}});
        };
        // 普通视频删除保留作品资料；只有显式的资料清理才处理 NFO 和封面。
        if(metadataOnly) {
        if(!info["shared"].empty()) {
            for(const auto& value:info["assets"]) if(shared.contains(pathKey(fs::path(wide(value)))))
                throw std::runtime_error("作品资料仍被其他视频使用，不能单独清除");
        }
        for (const auto& value: info["assets"]) {
            const fs::path asset(wide(value));
            if (ext(asset) == ".nfo" || images.contains(ext(asset))) add(asset); else ++preserved;
        }
        auto nfo = path; nfo.replace_extension(".nfo"); add(nfo);
        for (const auto* kind: {"poster","thumb","fanart"}) for (const auto& extension: images)
            add(path.parent_path()/wide(pathText(path.stem())+"-"+kind+extension));
        }
        if (!metadataOnly) {
            for (const auto& entry: fs::directory_iterator(path.parent_path())) {
                const auto candidate = entry.path();
                const auto name = lower(pathText(candidate.stem()));
                if (!subtitles.contains(ext(candidate)) || !name.starts_with(stem)) continue;
                const auto suffix = name.substr(stem.size());
                bool belongsToAnother=false;
                for (const auto& value: info["siblingStems"]) {
                    const auto other=value.get<std::string>();
                    if (other.size()<stem.size() || !name.starts_with(other)) continue;
                    const auto rest=name.substr(other.size());
                    if (rest.empty() || std::string("._- [(").find(rest.front())!=std::string::npos) belongsToAnother=true;
                }
                if (belongsToAnother) { ++preserved; continue; }
                if (suffix.empty() || std::string("._- [(").find(suffix.front()) != std::string::npos) add(candidate);
                if (files.size() > 256) throw std::runtime_error("关联文件过多，请先手动整理后再清理");
            }
            add(path);
        }
        if (checkedFile(path) != exists)
            throw std::runtime_error("视频文件状态已变化，未删除任何文件，请重新检查");
        removal_ = {{"token",token},{"id",info["id"]},{"path",pathText(path)},
            {"metadataOnly",metadataOnly},{"files",files},{"preserved",preserved},{"retained",retained}};
        return removal_;
    }
    if (removal_.is_null() || removal_["token"] != token) throw std::runtime_error("清理任务不存在或已结束");
    if (method == "library.maintenance.checkFile") {
        for (const auto& file: removal_["files"]) if (file["path"] == params.at("path")) {
            checkRetainedCopy(removal_.at("retained"));
            const fs::path path(wide(file["path"]));
            if (!checkedFile(path)) return {{"exists",false}};
            if (stamp(path) != file["stamp"].get<std::string>()) throw std::runtime_error("关联文件已变化，已停止清理："+pathText(path));
            return {{"exists",true}};
        }
        throw std::runtime_error("文件不属于本次清理任务");
    }
    if (method == "library.maintenance.complete") {
        for (const auto& file: removal_["files"]) if (checkedFile(fs::path(wide(file["path"]))))
            throw std::runtime_error("文件尚未删除，已保留数据库记录");
        if (!removal_.at("metadataOnly").get<bool>() && checkedFile(fs::path(wide(removal_.at("path")))))
            throw std::runtime_error("视频文件仍存在或已恢复，已保留数据库记录，请重新检查");
        const auto id = removal_.at("id").get<std::string>();
        store_.completeRemoval(id,removal_.at("metadataOnly"));
        removal_ = nullptr;
        refreshDirectories();
        std::lock_guard progressLock(progressMutex_); ++revision_;
        return Json::object();
    }
    throw std::runtime_error("未知清理操作");
}
}
