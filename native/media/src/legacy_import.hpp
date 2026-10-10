#pragma once
#include "common.hpp"
#include <sqlite3.h>
#include <functional>

namespace media::legacy {
using Progress = std::function<void(const std::string&, int64_t, int64_t)>;
fs::path sourcePath(const fs::path& target);
Json inspect(const fs::path& target);
Json candidate(sqlite3* db, const fs::path& target);
Json importDatabase(sqlite3* db, const fs::path& target, const std::atomic_bool& cancelled,
                    const Progress& progress, const std::function<int64_t(sqlite3*)>& importRows);
}
