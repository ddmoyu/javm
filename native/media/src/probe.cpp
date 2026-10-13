#include "common.hpp"
#include "../../probe/src/probe.hpp"

namespace media {
Json probeDirect(const fs::path& path) {
    return javm::probe::readDirect(path, executable().parent_path() / javm::probe::libraryFilename());
}
Json probe(const fs::path& path, const std::atomic_bool& cancelled) {
    return javm::probe::inspect(executable(), path, cancelled);
}
} // namespace media
