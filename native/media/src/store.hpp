#pragma once
#include "common.hpp"
#include "legacy_import.hpp"
#include <sqlite3.h>
#include <memory>
#include <mutex>

namespace media {
class Store {
    sqlite3* db_ = nullptr;
    fs::path path_;
    std::mutex mutex_;
    void migrate();
    void prepareCatalog();
    std::string matchWork(const Json& nfo, const std::string& requested = "");
    std::string saveWork(const Json& file, const Json& nfo, const std::string* nfoSource);
    void rememberAssetRoot(const fs::path& path);
    int64_t importLegacyRows(sqlite3* source, const std::atomic_bool& cancelled, const legacy::Progress& progress);
    Json decorate(Json videos);
public:
    explicit Store(fs::path path);
    ~Store();
    Store(const Store&) = delete;
    Store& operator=(const Store&) = delete;
    Json directories();
    Json assetRoots();
    Json addDirectory(const fs::path& path, bool recursive, const Json& formats);
    Json removeDirectory(const std::string& id);
    Json maintenanceRows(const std::string& after);
    Json fileIdentity(const std::string& id);
    Json removalInfo(const std::string& id);
    void completeRemoval(const std::string& id, bool metadataOnly);
    Json find(const fs::path& path);
    std::string save(const Json& file, const Json& nfo, const std::string* nfoSource = nullptr);
    Json prepareWork(const Json& params);
    void removeWork(const std::string& id);
    void finish(const Json& directory, const std::string& state, const std::string& error, bool reconcile, const std::atomic_bool* cancelled = nullptr);
    Json videos(int offset, int limit);
    Json query(const Json& params);
    Json facets(const Json& params);
    Json catalogAppend(const Json& params);
    Json summary();
    Json video(const std::string& id);
    bool duplicateCode(const std::string& code, const std::string& except);
    void favorite(const std::string& id, bool value);
    Json resources(const std::string& method, const Json& params);
    void updateMetadata(const Json& params);
    Json applyScrape(const Json& params, const std::atomic_bool& cancelled);
    Json playbackPosition(const Json& params);
    void savePlaybackPositions(const Json& params, bool importing);
    Json legacyCandidate();
    Json importLegacy(const std::atomic_bool& cancelled, const legacy::Progress& progress);
    const fs::path& path() const { return path_; }
};
}
