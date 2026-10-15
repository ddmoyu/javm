#pragma once
#include "store.hpp"
#include <thread>

namespace media {
// 生命周期属于官方 Extension，页面切换及 StrictMode 均不创建扫描任务。
class LibraryService {
    Store store_;
    std::thread worker_;
    std::atomic_bool cancelled_{false};
    std::atomic_bool scrapeCancelled_{false};
    std::mutex scrapeMutex_;
    std::string scrapeJob_, cancelledScrape_;
    Json prepareScrape(const Json& params);
    Json removal_ = nullptr;
    std::string cancelledRemoval_;
    Json maintenance(const std::string& method, const Json& params);
    std::atomic_bool busy_{false};
    std::mutex startMutex_, progressMutex_;
    Json progress_ = nullptr;
    Json legacy_ = {{"state","unchecked"}};
    Json backup_ = {{"state","idle"}};
    std::atomic_bool recovering_{false};
    Json backup(const std::string& method,const Json& params);
    std::atomic_bool importing_{false};
    Json directories_ = Json::array();
    Json assetRoots_ = Json::array();
    uint64_t revision_ = 0;
    void scan(Json directory, unsigned concurrency);
    void refreshDirectories();
    void issue(const fs::path& path, const std::string& message);
    void notice(const fs::path& path, const std::string& message);
    Json start(const Json& directory, unsigned concurrency);
public:
    explicit LibraryService(const fs::path& path): store_(path) { if(store_.healthy()) refreshDirectories(); }
    ~LibraryService();
    LibraryService(const LibraryService&) = delete;
    LibraryService& operator=(const LibraryService&) = delete;
    Json handle(const std::string& method, const Json& params);
    void shutdown();
};
}
