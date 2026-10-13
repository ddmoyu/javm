#include "scanner.hpp"
#include "work_queue.hpp"
#include <algorithm>
#include <chrono>
#include <map>
#include <regex>
#include <set>
#include <thread>
#include <vector>

namespace media {
namespace {
const std::set<std::string> builtins{"mp4","mkv","avi","ts","mov","wmv","flv","webm","m4v","m2ts","mts","mpg","mpeg","rmvb","rm","vob","3gp","ogv"};
// 进程启动时读取一次逻辑处理器数，状态轮询只读取缓存；读取失败时使用单并发。
constexpr unsigned maxScanConcurrency = 16;
const unsigned logicalProcessorCount = std::max(1u,std::thread::hardware_concurrency());
const unsigned automaticScanConcurrency = logicalProcessorCount > 2
    ? std::min(logicalProcessorCount-2,maxScanConcurrency) : 1u;
std::string extension(const fs::path& path) {
    auto result = lower(pathText(path.extension()));
    return result.empty() ? result : result.substr(1);
}
std::string filenameCode(const std::string& name) {
    std::smatch match;
    // 只识别清晰的番号；字幕、分段等后缀不参与身份，无法确认的名称保持待刮削。
    if(std::regex_search(name,match,std::regex(R"((?:^|[^a-zA-Z0-9])(FC2[-_ ]?(?:PPV[-_ ]?)?[0-9]{5,10}|[a-zA-Z]{2,12}[-_][0-9]{2,8})(?:[^0-9]|$))",std::regex::icase))) return match[1];
    return {};
}
Json formats(const Json& input) {
    if (!input.is_array() || input.size() > 32) throw std::runtime_error("视频格式选项无效");
    std::set<std::string> result;
    for (const auto& entry: input) {
        auto value = lower(trim(entry.get<std::string>()));
        if (!value.empty() && value.front() == '.') value.erase(0,1);
        if (value.empty() || value.size() > 12 || value.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789") != std::string::npos)
            throw std::runtime_error("扩展名只能包含字母和数字，最多 12 个字符");
        result.insert(value);
    }
    return result;
}
fs::path validateRoot(const std::string& text) {
    if (text.empty() || text.size() > 32768 || text.find('\0') != std::string::npos) throw std::runtime_error("请选择有效目录");
    auto path = fs::path(wide(text));
    if (!path.is_absolute() || !fs::is_directory(path)) throw std::runtime_error("目录不存在、磁盘离线或无法访问");
    if (reparse(path)) throw std::runtime_error("请选择实际目录，不支持符号链接或目录联接");
    path = fs::canonical(path);
    // 确认有枚举权限后才登记新目录。
    fs::directory_iterator check(path);
    return path;
}
int64_t modifiedSeconds(const fs::path& path) {
    return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::clock_cast<std::chrono::system_clock>(fs::last_write_time(path)).time_since_epoch()).count();
}
fs::path localArtwork(const std::string& reference, const fs::path& nfoPath, const fs::path& root) {
    if (reference.empty() || reference.size() > 32768 || reference.find('\0') != std::string::npos || reference.find("://") != std::string::npos) return {};
    auto path = fs::path(wide(reference));
    if (!path.is_absolute()) path = nfoPath.parent_path()/path;
    path = path.lexically_normal();
    if (!within(path,root)) return {};
    const auto relative = path.lexically_relative(root);
    if (pathText(relative).find(':') != std::string::npos) return {}; // 排除 NTFS 附加数据流。
    auto part = root;
    for (const auto& name: relative) {
        part /= name;
        std::error_code ec;
        if (!fs::exists(part,ec) || ec || reparse(part)) return {};
    }
    const auto ext = extension(path);
    if (ext != "jpg" && ext != "jpeg" && ext != "png" && ext != "webp") return {};
    return fs::is_regular_file(path) ? path : fs::path{};
}
}
LibraryService::~LibraryService() { shutdown(); }
void LibraryService::shutdown() { cancelled_ = true; scrapeCancelled_ = true; std::lock_guard lock(startMutex_); if (worker_.joinable()) worker_.join(); }
void LibraryService::refreshDirectories() {
    auto directories = store_.directories();
    auto roots = store_.assetRoots();
    std::lock_guard lock(progressMutex_);
    directories_ = std::move(directories);
    assetRoots_ = std::move(roots);
}
void LibraryService::issue(const fs::path& path, const std::string& message) {
    std::lock_guard lock(progressMutex_);
    progress_["errors"] = progress_["errors"].get<int>() + 1;
    if (progress_["issues"].size() < 30) progress_["issues"].push_back({{"path",pathText(path)},{"message",message}});
}
void LibraryService::notice(const fs::path& path, const std::string& message) {
    std::lock_guard lock(progressMutex_);
    progress_["warnings"] = progress_["warnings"].get<int>() + 1;
    if (progress_["notices"].size() < 30) progress_["notices"].push_back({{"path",pathText(path)},{"message",message}});
}
Json LibraryService::start(const Json& directory, unsigned concurrency) {
    if (!removal_.is_null()) throw std::runtime_error("正在清理影片，请等待当前操作完成");
    if (busy_) throw std::runtime_error("正在扫描其他目录，请等待完成或先停止扫描");
    if (worker_.joinable()) worker_.join();
    cancelled_ = false;
    store_.finish(directory, "scanning", "", false);
    refreshDirectories();
    {
        std::lock_guard lock(progressMutex_);
        progress_ = {{"id",uuid()},{"directoryId",directory["id"]},{"state","scanning"},{"discovered",0},{"processed",0},
            {"imported",0},{"unchanged",0},{"skipped",0},{"errors",0},{"current",""},{"issues",Json::array()},
            {"concurrency",concurrency},{"activeProbes",0},{"peakProbes",0},{"warnings",0},{"notices",Json::array()}};
    }
    busy_ = true;
    try { worker_ = std::thread([this,directory,concurrency] { scan(directory,concurrency); }); }
    catch (...) { busy_ = false; store_.finish(directory,"failed","无法启动扫描任务",false); throw; }
    return {{"directoryId",directory["id"]}};
}
#include "backup.inc"
Json LibraryService::handle(const std::string& method, const Json& params) {
    if(method.starts_with("library.backup.")) return backup(method,params);
    if(!store_.healthy()) {
        if(method.starts_with("library.instance.")) return store_.applicationInstance(method,params);
        if(method=="library.status") return {{"directories",Json::array()},{"scan",nullptr},{"revision",revision_},{"databasePath",pathText(store_.path())},{"recoveryError",store_.recoveryError()}};
        if(method=="library.shutdown" || method=="library.cancel") {shutdown();return Json::object();}
        throw std::runtime_error(store_.recoveryError());
    }
    if(recovering_ && method!="library.status" && method!="library.cancel" && method!="library.shutdown")
        throw std::runtime_error("片库正在备份或恢复，请等待完成后重试。");
    if (method == "library.scrape.cancel") {
        std::lock_guard lock(scrapeMutex_);
        cancelledScrape_=params.at("jobId");
        if (scrapeJob_==cancelledScrape_) scrapeCancelled_=true;
        return Json::object();
    }
    if (method == "library.legacy.status") {
        std::lock_guard lock(progressMutex_);
        return legacy_;
    }
    if (method == "library.legacy.cancel") { cancelled_ = true; return Json::object(); }
    if (method == "library.legacy.check") {
        if (importing_) { std::lock_guard lock(progressMutex_); return legacy_; }
        auto candidate=store_.legacyCandidate();
        std::lock_guard lock(progressMutex_);
        legacy_=std::move(candidate);
        return legacy_;
    }
    if (method == "library.legacy.start") {
        std::lock_guard lock(startMutex_);
        if(store_.pendingFileOperations()) throw std::runtime_error("请先恢复或取消文件整理任务再导入旧数据");
        if (!removal_.is_null()) throw std::runtime_error("正在清理影片，请稍候");
        if (busy_) throw std::runtime_error("请等待当前扫描或导入任务结束后重试");
        if (worker_.joinable()) worker_.join();
        cancelled_=false;
        { std::lock_guard progressLock(progressMutex_); legacy_["state"]="running"; legacy_["phase"]="preparing"; legacy_["error"]=""; }
        busy_=true; importing_=true;
        try {
            worker_=std::thread([this] {
                try {
                    auto result=store_.importLegacy(cancelled_,[this](const std::string& phase,int64_t done,int64_t total) {
                        std::lock_guard lock(progressMutex_);
                        legacy_["phase"]=phase; legacy_["processed"]=done; legacy_["total"]=total;
                    });
                    refreshDirectories();
                    std::lock_guard lock(progressMutex_);
                    legacy_.update(result); ++revision_;
                } catch (const std::exception& error) {
                    std::lock_guard lock(progressMutex_);
                    legacy_["state"]=cancelled_ ? "cancelled" : "failed";
                    legacy_["error"]=cancelled_ ? "导入已取消，新旧数据均已保留。" : error.what();
                }
                importing_=false; busy_=false;
            });
        } catch (...) { importing_=false; busy_=false; std::lock_guard progressLock(progressMutex_); legacy_["state"]="failed"; legacy_["error"]="无法启动导入任务"; throw; }
        return Json::object();
    }
    if (method == "library.status") {
        // 只读内存快照；进度和取消不等待 SQLite 写锁、磁盘或网络共享。
        std::lock_guard lock(progressMutex_);
        return {{"directories",directories_},{"assetRoots",assetRoots_},{"scan",progress_},{"revision",revision_},{"databasePath",pathText(store_.path())},
            {"metadataDirectory",pathText(store_.path().parent_path()/L"metadata")},{"logicalProcessors",logicalProcessorCount},{"defaultConcurrency",automaticScanConcurrency},{"maxConcurrency",maxScanConcurrency}};
    }
    if (method == "library.cancel") { cancelled_ = true; return Json::object(); }
    if (method == "library.shutdown") { shutdown(); return Json::object(); }
    if(method.starts_with("library.instance.")) {
        auto result=store_.applicationInstance(method,params);
        // 主实例接管时重置了遗留扫描状态，刷新构造时缓存的目录列表。
        if(method=="library.instance.claim" && result.value("primary",false)) refreshDirectories();
        return result;
    }
    if (importing_) throw std::runtime_error("正在导入旧数据，请等待导入完成后再操作媒体库");
    if(method.starts_with("library.files.")) {
        std::lock_guard lock(startMutex_);
        if(busy_ || !removal_.is_null()) throw std::runtime_error("请等待扫描或清理结束后整理文件");
        auto result=store_.fileOperations(method,params);
        if(method=="library.files.commit" || method=="library.files.relink") { refreshDirectories();std::lock_guard progressLock(progressMutex_);++revision_; }
        return result;
    }
    if(method.starts_with("library.related.")) {
        std::lock_guard lock(startMutex_);
        if(busy_ || !removal_.is_null() || store_.pendingFileOperations()) throw std::runtime_error("请等待片库操作和文件整理完成");
        auto result=store_.relatedMedia(method,params);
        if(method=="library.related.save") {std::lock_guard progressLock(progressMutex_);++revision_;}
        return result;
    }
    if((method=="library.scan" || method=="library.add" || method=="library.removeDirectory" || method.starts_with("library.maintenance.") || method.starts_with("library.scrape.") || method=="library.documents.importStream") && store_.pendingFileOperations())
        throw std::runtime_error("请先恢复或取消未完成的文件整理任务");
    if (method.starts_with("library.maintenance.")) return maintenance(method,params);
    if (method == "library.scrape.prepare" || method == "library.scrape.commit") {
        std::lock_guard lock(startMutex_);
        if (!removal_.is_null()) throw std::runtime_error("正在清理影片，请稍候再刮削");
        if (busy_) throw std::runtime_error("正在扫描或导入目录，请等待完成后重试刮削");
        {
            std::lock_guard cancelLock(scrapeMutex_);
            scrapeJob_=params.at("jobId");
            scrapeCancelled_=cancelledScrape_==scrapeJob_;
        }
        if (scrapeCancelled_) throw std::runtime_error("刮削已取消");
        auto result=method == "library.scrape.prepare" ? prepareScrape(params) : store_.applyScrape(params,scrapeCancelled_);
        refreshDirectories();
        std::lock_guard progressLock(progressMutex_); ++revision_;
        return result;
    }
    if (method == "library.videos") return store_.videos(std::max(0,params.value("offset",0)),std::clamp(params.value("limit",250),1,500));
    if (method == "library.query") return store_.query(params);
    if (method == "library.facets") return store_.facets(params);
    if(method.starts_with("library.aliases.")) {
        std::lock_guard lock(startMutex_);
        if(busy_) throw std::runtime_error("请等待扫描或导入完成后管理名称");
        cancelled_=false;auto result=store_.aliases(method,params,cancelled_);
        if(method!="library.aliases.list") {std::lock_guard progressLock(progressMutex_);++revision_;} return result;
    }
    if (method == "library.facetFavorite") { store_.facetFavorite(params); return Json::object(); }
    if (method.starts_with("library.resources.")) return store_.resources(method,params);
    if(method.starts_with("library.documents.")) {
        std::lock_guard lock(startMutex_);
        if(method=="library.documents.importStream" && (busy_ || !removal_.is_null())) throw std::runtime_error("请等待当前片库操作完成");
        auto result=store_.documents(method,params);
        if(method=="library.documents.importStream") { refreshDirectories(); std::lock_guard progressLock(progressMutex_); ++revision_; }
        return result;
    }
    if(method.starts_with("library.artwork.")) {
        std::lock_guard lock(startMutex_);
        if(busy_ || !removal_.is_null()) throw std::runtime_error("请等待当前片库操作完成后处理图片");
        auto result=store_.artwork(method,params);
        if(method!="library.artwork.prepare" && method!="library.artwork.pending" && method!="library.artwork.failed") { std::lock_guard progressLock(progressMutex_); ++revision_; }
        return result;
    }
    if (method == "library.catalogAppend") return store_.catalogAppend(params);
    if (method == "library.catalogSeed") return store_.catalogSeed(params);
    if (method == "library.catalogEntries") return store_.catalogEntries(params);
    if (method == "library.summary") return store_.summary();
    if (method == "library.video") return store_.video(params.at("id"));
    if (method == "library.playback.get") return store_.playbackPosition(params);
    if (method == "library.playback.save" || method == "library.playback.import") {
        store_.savePlaybackPositions(params, method == "library.playback.import");
        return Json::object();
    }
    if (method == "library.duplicateCode") return store_.duplicateCode(params.at("code"),params.at("except"));
    if (method == "library.updateMetadata") {
        std::lock_guard mutationLock(startMutex_);
        if (!removal_.is_null()) throw std::runtime_error("正在清理影片，请稍候再编辑");
        store_.updateMetadata(params);
        std::lock_guard lock(progressMutex_);
        ++revision_;
        return Json::object();
    }
    if (method == "library.favorite") {
        store_.favorite(params.at("id"),params.at("value"));
        std::lock_guard lock(progressMutex_);
        ++revision_;
        return Json::object();
    }
    if (method == "library.removeDirectory") {
        std::lock_guard lock(startMutex_);
        if (!removal_.is_null()) throw std::runtime_error("正在清理影片，请稍候再删除目录");
        if (busy_) throw std::runtime_error("正在扫描目录，请等待完成或先停止扫描后再删除");
        if (worker_.joinable()) worker_.join();
        const auto id = params.at("id").get<std::string>();
        auto result = store_.removeDirectory(id);
        refreshDirectories();
        std::lock_guard progressLock(progressMutex_);
        if (!progress_.is_null() && progress_.value("directoryId",std::string{}) == id) progress_ = nullptr;
        ++revision_;
        return result;
    }
    if (method == "library.add" || method == "library.scan") {
        std::lock_guard lock(startMutex_);
        if (!removal_.is_null()) throw std::runtime_error("正在清理影片，请稍候再扫描");
        if (busy_) throw std::runtime_error("正在扫描目录，请等待完成或先停止扫描");
        Json directory;
        if (method == "library.add") {
            const auto root = validateRoot(params.at("path"));
            directory = store_.addDirectory(root,params.value("recursive",true),formats(params.value("formats",Json::array())));
        } else {
            for (const auto& item: store_.directories()) if (item["id"] == params.at("id")) { directory = item; break; }
            if (directory.is_null()) throw std::runtime_error("媒体目录不存在");
            try { validateRoot(directory["path"]); }
            catch (const std::exception& error) { store_.finish(directory,"failed",error.what(),false); refreshDirectories(); throw; }
        }
        return start(directory,automaticScanConcurrency);
    }
    throw std::runtime_error("未知媒体库操作");
}
Json LibraryService::prepareScrape(const Json& params) {
    auto workId=params.value("workId",std::string{});
    const auto inputPath=params.value("path",std::string{});
    std::string fileStamp;
    if(!inputPath.empty()) {
        auto path=fs::path(wide(inputPath)).lexically_normal();
        if(!path.is_absolute() || !fs::is_regular_file(path) || !builtins.contains(extension(path)) || fs::file_size(path)==0)
            throw std::runtime_error("视频不存在、磁盘离线或格式不支持");
        for(auto part=path;!part.empty();part=part.parent_path()) {
            if(reparse(part)) throw std::runtime_error("不支持链接或目录联接中的视频");
            if(part==part.root_path()) break;
        }
        fileStamp=stamp(path);
        auto old=store_.find(path);
        const auto metadata=!old.empty() && old.value("file_stamp",std::string{})==fileStamp
            ? Json{{"video",true},{"width",old["width"]},{"height",old["height"]},{"durationMs",old["duration_ms"]},{"codec",old["codec"]}}
            : probe(path,scrapeCancelled_);
        if(!metadata.at("video").get<bool>()) throw std::runtime_error("文件不是可识别的视频");
        Json file={{"path",pathText(path)},{"parent",pathText(path.parent_path())},{"name",pathText(path.stem())},
            {"file_stamp",fileStamp},{"size",fs::file_size(path)},{"mtime",modifiedSeconds(path)},
            {"width",metadata["width"]},{"height",metadata["height"]},{"duration_ms",metadata["durationMs"]},{"codec",metadata["codec"]},{"fast_hash",fastHash(path)}};
        if(!workId.empty()) file["work_id"]=workId;
        auto nfoPath=path; nfoPath.replace_extension(".nfo");
        if(!fs::exists(nfoPath) && fs::exists(path.parent_path()/L"movie.nfo")) {
            size_t entries=0,videos=0;
            for(const auto& item:fs::directory_iterator(path.parent_path())) {
                if(++entries>10000) throw std::runtime_error("目录过大，请先执行目录扫描");
                if(item.is_regular_file() && builtins.contains(extension(item.path()))) ++videos;
            }
            if(videos==1) nfoPath=path.parent_path()/L"movie.nfo";
        }
        Json nfo=Json::object(); std::string original;
        if(fs::exists(nfoPath)) {
            const auto signature=stamp(nfoPath); nfo=readNfo(nfoPath,&original);
            if(signature!=stamp(nfoPath)) throw std::runtime_error("NFO 正在变化，请重试");
            file["nfo_path"]=pathText(nfoPath); file["nfo_stamp"]=signature; file["nfo_parser"]=nfoParserVersion;
            for(const auto* kind:{"poster","thumb","fanart"}) for(const auto& reference:nfo.value("artwork",Json::object()).value(kind,Json::array())) {
                const auto local=localArtwork(reference.get<std::string>(),nfoPath,path.parent_path());
                if(!local.empty()) { file[kind]=pathText(local); break; }
            }
        } else {
            const auto code=filenameCode(pathText(path.stem())); if(!code.empty()) nfo["num"]=code;
        }
        if(scrapeCancelled_ || stamp(path)!=fileStamp) throw std::runtime_error("视频正在变化或操作已取消");
        workId=store_.save(file,nfo,original.empty()?nullptr:&original);
    }
    auto request=params;
    if(!workId.empty()) request["workId"]=workId;
    auto work=store_.prepareWork(request);
    const auto nfoPath=fs::path(wide(work["nfo_path"]));
    std::string nfoStamp;
    if(fs::exists(nfoPath)) {
        nfoStamp=stamp(nfoPath); std::string original; const auto nfo=readNfo(nfoPath,&original);
        if(nfoStamp!=stamp(nfoPath)) throw std::runtime_error("NFO 正在变化，请重试");
        store_.save({{"kind","metadata"},{"work_id",work["id"]},{"nfo_path",pathText(nfoPath)},{"nfo_stamp",nfoStamp},{"nfo_parser",nfoParserVersion}},nfo,&original);
        work=store_.video(work["id"]);
    }
    if(scrapeCancelled_) throw std::runtime_error("刮削已取消");
    bool artwork=false;
    for(const auto* kind:{"poster","thumb","fanart"}) {
        // 自动截帧的封面不算正式封面，刮削仍会下载来源封面替换它。
        if(std::string(kind)=="poster" && work.value("poster_auto",false)) continue;
        const auto text=work.value(kind,std::string{}); std::error_code ec;
        artwork=artwork || (!text.empty() && fs::is_regular_file(fs::path(wide(text)),ec));
    }
    return {{"id",work["id"]},{"path",inputPath},{"fileStamp",fileStamp},{"nfoStamp",nfoStamp},{"nfoPath",pathText(nfoPath)},
        {"code",work["code"]},{"title",work["title"]},{"hasArtwork",artwork}};
}
void LibraryService::scan(Json directory, unsigned concurrency) {
    const auto root = fs::path(wide(directory["path"]));
    auto allowed = builtins;
    if (!directory["formats"].empty()) { allowed.clear(); for (const auto& value: directory["formats"]) allowed.insert(value.get<std::string>()); }
    std::vector<std::pair<fs::path,int>> pending{{root,0}};
    bool complete = true;
    std::string failure;
    std::mutex failureMutex;
    auto increment = [&](const char* key) { std::lock_guard lock(progressMutex_); progress_[key] = progress_[key].get<int>() + 1; };
    try {
        WorkQueue work(concurrency, 64);
        while (!pending.empty() && !cancelled_) {
            const auto [folder,depth] = pending.back(); pending.pop_back();
            if (depth > 128) { complete = false; issue(folder,"子目录超过 128 层，已跳过"); continue; }
            std::vector<fs::path> candidates,nfos;
            std::map<std::string,fs::path> siblings;
            std::error_code ec;
            fs::directory_iterator it(folder,ec), end;
            if (ec) { complete = false; issue(folder,"无法读取目录：" + ec.message()); continue; }
            for (; it != end && !cancelled_; it.increment(ec)) {
                if (ec) break;
                try {
                    const auto path = it->path();
                    if (reparse(path)) continue;
                    const auto name = lower(pathText(path.filename()));
                    if (it->is_directory()) {
                        if (directory["recursive"].get<bool>() && !name.starts_with('.') && name != "backdrops" && name != "behind the scenes") pending.emplace_back(path,depth+1);
                    } else if (it->is_regular_file()) {
                        siblings.emplace(name,path);
                        if(!name.starts_with('.') && extension(path)=="nfo") nfos.push_back(path);
                        if (!name.starts_with('.') && allowed.contains(extension(path)) && it->file_size() > 0) candidates.push_back(path);
                    }
                } catch (const std::exception& error) { complete = false; issue(it->path(),error.what()); }
            }
            if (ec) { complete = false; issue(folder,"目录枚举中断：" + ec.message()); }
            { std::lock_guard lock(progressMutex_); progress_["discovered"] = progress_["discovered"].get<int>() + static_cast<int>(candidates.size()+nfos.size()); }
            const auto folderFiles = std::make_shared<const std::map<std::string,fs::path>>(std::move(siblings));
            std::map<std::string,std::vector<fs::path>> nfoVideos;
            for (const auto& video: candidates) {
                auto name = lower(pathText(video.stem()))+".nfo";
                if (!folderFiles->contains(name) && candidates.size()==1) name = "movie.nfo";
                if (folderFiles->contains(name)) nfoVideos[name].push_back(video);
            }
            for(const auto& path:nfos) {
                if(cancelled_) break;
                if(!work.submit([&,path,companions=nfoVideos[lower(pathText(path.filename()))]] {
                    if(cancelled_) return;
                    try {
                        const auto signature=stamp(path); std::string original;
                        auto nfo=readNfo(path,&original);
                        if(stamp(path)!=signature) throw std::runtime_error("NFO 正在变化，将在下次扫描重试");
                        Json file={{"kind","metadata"},{"name",pathText(path.stem())},{"nfo_path",pathText(path)},{"nfo_stamp",signature},{"nfo_parser",nfoParserVersion}};
                        // 后补或修复的侧车 NFO 沿用现有视频身份，避免先导入 NFO 时新建第二部作品。
                        for (const auto& companion: companions) {
                            const auto old = store_.find(companion);
                            if (old.empty()) continue;
                            if (file.contains("work_id") && file["work_id"] != old["id"])
                                throw std::runtime_error("同一 NFO 对应不同作品，未自动合并，请先核对视频关联");
                            file["work_id"] = old["id"];
                        }
                        for(const auto* kind:{"poster","thumb","fanart"}) for(const auto& reference:nfo.value("artwork",Json::object()).value(kind,Json::array())) {
                            const auto local=localArtwork(reference.get<std::string>(),path,root);
                            if(!local.empty()) { file[kind]=pathText(local); break; }
                        }
                        store_.save(file,nfo,&original); increment("imported");
                    } catch(const std::exception& error) { issue(path,error.what()); }
                    increment("processed");
                },cancelled_)) break;
            }
            for (const auto& path: candidates) {
                if (cancelled_) break;
                if (!work.submit([&,path,folderFiles,singleVideo=candidates.size()==1] {
                if (cancelled_) return;
                const auto& siblings = *folderFiles;
                { std::lock_guard lock(progressMutex_); progress_["current"] = pathText(path); }
                Json file, nfo = Json::object();
                Json old;
                std::string nfoSource;
                bool nfoRead = false;
                bool unchanged = false;
                try {
                    const auto before = stamp(path);
                    old = store_.find(path);
                    unchanged = old.value("file_stamp",std::string{}) == before;
                    file = {{"path",pathText(path)},{"path_key",pathKey(path)},{"parent",pathText(path.parent_path())},
                        {"name",pathText(path.stem())},{"file_stamp",before},{"size",fs::file_size(path)},{"mtime",modifiedSeconds(path)}};
                    if (unchanged) for (const auto* field: {"width","height","duration_ms","codec"}) file[field] = old[field];
                    else {
                        {
                            std::lock_guard lock(progressMutex_);
                            const auto active = progress_["activeProbes"].get<int>() + 1;
                            progress_["activeProbes"] = active;
                            progress_["peakProbes"] = std::max(active,progress_["peakProbes"].get<int>());
                        }
                        Json metadata;
                        try { metadata = probe(path,cancelled_); }
                        catch (...) { std::lock_guard lock(progressMutex_); progress_["activeProbes"] = progress_["activeProbes"].get<int>() - 1; throw; }
                        { std::lock_guard lock(progressMutex_); progress_["activeProbes"] = progress_["activeProbes"].get<int>() - 1; }
                        if (!metadata.at("video").get<bool>()) { increment("skipped"); increment("processed"); return; }
                        file["width"] = metadata["width"]; file["height"] = metadata["height"];
                        file["duration_ms"] = metadata["durationMs"]; file["codec"] = metadata["codec"];
                    }
                    fs::path nfoPath;
                    file["fast_hash"] = unchanged && old.value("fast_hash",Json()).is_string() && !old["fast_hash"].get<std::string>().empty()
                        ? old["fast_hash"] : Json(fastHash(path));
                    const auto stem = lower(pathText(path.stem()));
                    if (auto found = siblings.find(stem+".nfo"); found != siblings.end()) nfoPath = found->second;
                    else if (singleVideo) if (auto movie = siblings.find("movie.nfo"); movie != siblings.end()) nfoPath = movie->second;
                    if (!nfoPath.empty()) {
                        const auto signature = stamp(nfoPath);
                        file["nfo_path"] = pathText(nfoPath);
                        file["nfo_stamp"] = old.value("nfo_stamp",std::string{});
                        file["nfo_parser"] = old.value("nfo_parser",0);
                        if (signature != old.value("nfo_stamp",std::string{}) || old.value("nfo_parser",0) != nfoParserVersion || pathKey(nfoPath) != pathKey(fs::path(wide(old.value("nfo_path",std::string{}))))) {
                            try {
                                nfo = readNfo(nfoPath,&nfoSource);
                                if (stamp(nfoPath) != signature) throw std::runtime_error("NFO 正在变化，将在下次扫描重试");
                                file["nfo_stamp"] = signature;
                                file["nfo_parser"] = nfoParserVersion;
                                nfoRead = true;
                                for (const auto& warning: nfo.value("_warnings",Json::array())) notice(nfoPath,warning.get<std::string>());
                            } catch (const std::exception& error) {
                                // 侧车资料损坏不能丢掉已探测的视频。保留旧资料和原始快照，修复后重扫可重新导入。
                                nfo = Json::object();
                                nfoSource.clear();
                                nfoRead = false;
                                file.erase("nfo_path");
                                file.erase("nfo_stamp");
                                file.erase("nfo_parser");
                                notice(nfoPath,std::string("NFO 读取失败，已保留原资料并继续导入视频参数：")+error.what());
                            }
                        }
                        const auto metadata = nfo.empty() ? Json::parse(old.value("nfo_data",std::string("{}"))) : nfo;
                        for (const auto* kind: {"poster","thumb","fanart"}) for (const auto& reference: metadata.value("artwork",Json::object()).value(kind,Json::array())) {
                            try {
                                const auto artworkPath = localArtwork(reference.get<std::string>(),nfoPath,root);
                                if (!artworkPath.empty()) { file[kind] = pathText(artworkPath); break; }
                            } catch (const std::exception&) { /* 图片不可用不影响视频资料导入，源引用保留于快照。 */ }
                        }
                    }
                    if (!file.contains("poster")) for (const auto* suffix: {"-poster.jpg","-poster.jpeg","-poster.png","-poster.webp"}) {
                        if (auto found = siblings.find(stem+suffix); found != siblings.end()) { file["poster"] = pathText(found->second); break; }
                    }
                    if (!file.contains("poster") && singleVideo) for (const auto* name: {"poster.jpg","poster.png","poster.webp","folder.jpg"}) {
                        if (auto found = siblings.find(name); found != siblings.end()) { file["poster"] = pathText(found->second); break; }
                    }
                    for (const auto* kind: {"thumb","fanart"}) if (!file.contains(kind)) for (const auto* ext: {".jpg",".jpeg",".png",".webp"}) {
                        auto found = siblings.find(stem+"-"+kind+ext);
                        if (found == siblings.end() && singleVideo) found = siblings.find(std::string(kind)+ext);
                        if (found != siblings.end()) { file[kind] = pathText(found->second); break; }
                    }
                    if(nfoPath.empty()) { const auto code=filenameCode(pathText(path.stem())); if(!code.empty()) nfo["num"]=code; }
                    if (stamp(path) != before) throw std::runtime_error("视频正在变化，将在下次扫描重试");
                } catch (const std::exception& error) {
                    if (!cancelled_) { issue(path,error.what()); increment("processed"); }
                    return;
                }
                if (cancelled_) return;
                // 数据库失败会中止任务，不把失败写入伪装成逐文件跳过。
                try {
                    const bool sameSidecar = file.value("nfo_path",std::string{}) == old.value("nfo_path",std::string{}) &&
                        file.value("nfo_stamp",std::string{}) == old.value("nfo_stamp",std::string{});
                    bool sameArtwork = true;
                    for (const auto* kind: {"poster","thumb","fanart"}) if (file.contains(kind) && file[kind] != old.value(kind,Json())) sameArtwork = false;
                    if (!unchanged || file["fast_hash"] != old.value("fast_hash",Json()) || !nfo.empty() || !sameSidecar || !sameArtwork || old.value("missing",0)) store_.save(file,nfo,nfoRead ? &nfoSource : nullptr);
                } catch (const std::exception& error) {
                    { std::lock_guard lock(failureMutex); if (failure.empty()) failure = error.what(); }
                    cancelled_ = true;
                    issue(path,error.what());
                    return;
                }
                increment(unchanged ? "unchanged" : "imported"); increment("processed");
                },cancelled_)) break;
            }
        }
        work.close(cancelled_);
        work.join();
    } catch (const std::exception& error) { complete = false; failure = error.what(); issue(root,failure); }
    int errors;
    { std::lock_guard lock(progressMutex_); errors = progress_["errors"]; }
    const std::string state = !failure.empty() ? "failed" : cancelled_ ? "cancelled" : errors ? "partial" : "completed";
    try {
        std::error_code ec;
        const bool online = fs::is_directory(root,ec) && !ec;
        store_.finish(directory,state,failure.empty() && errors ? std::to_string(errors)+" 项无法读取，已有资料已保留" : failure,complete && !cancelled_ && online,&cancelled_);
        refreshDirectories();
    } catch (const std::exception& error) { failure = error.what(); issue(root,failure); }
    {
        std::lock_guard lock(progressMutex_);
        progress_["state"] = !failure.empty() ? "failed" : cancelled_ ? "cancelled" : state;
        progress_["current"] = "";
        ++revision_;
    }
    busy_ = false;
}
}
