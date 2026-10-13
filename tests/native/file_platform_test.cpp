#include "common.hpp"
#include "file_platform.hpp"
#include "nfo_compat.hpp"
#include "store.hpp"
#include "../../native/common/unicode.hpp"
#include <fstream>
#include <iostream>
#include <set>

int main() {
    using namespace media;
    const auto root = fs::canonical(fs::temp_directory_path()) / pathFromText("javm-safe-files-" + uuid());
    int checks = 0;
    const auto require = [&](bool valid, const char* name) { if (!valid) throw std::runtime_error(name); ++checks; };
    const auto rejects = [&](auto action) {
        try { action(); } catch (const std::exception&) { ++checks; return; }
        throw std::runtime_error("expected a rejected operation");
    };
    const auto read = [](const fs::path& path) { std::ifstream input(path, std::ios::binary); return std::string(std::istreambuf_iterator<char>(input), {}); };
    try {
        fs::create_directory(root);
        const auto first = root / pathFromText("安全 空格😀.nfo");
        const auto second = root / "second.nfo";
        require(pathFromText(pathText(first)) == first, "UTF-8 path roundtrip");
        require(within(first, root) && !within(root / "../outside", root), "directory boundary");
        require(within(first, root.root_path()), "filesystem root boundary");
        require(!within(root.parent_path() / pathFromText(pathText(root.filename()) + "-outside"), root), "prefix sibling");
        require(validFilename(first), "Unicode filename");
#ifdef _WIN32
        require(pathKey(root / "Case") == pathKey(root / "case"), "Windows case folding");
        require(!validFilename(root / "CON.txt") && hasAlternateStream(root / "safe.txt:stream"), "Windows filename rules");
#else
        require(validFilename(root / "file:literal\\name") && !hasAlternateStream(root / "file:literal"), "POSIX literal characters");
#ifndef __APPLE__
        require(pathKey(root / "Case") != pathKey(root / "case"), "Linux case preservation");
#endif
#endif
        createExclusiveFile(first, "first");
        require(stamp(first).starts_with("5:") && stamp(first) == stamp(first), "stable full precision file stamp");
        const auto identity = media::fileIdentity(first);
        rejects([&] { createExclusiveFile(first, "must not overwrite"); });
        require(read(first) == "first", "exclusive creation preserves existing data");
        createExclusiveFile(second, "second");
        rejects([&] { moveFile(first, second); });
        require(read(first) == "first" && read(second) == "second", "no replace preserves both files");
        moveFile(first, second, true);
        require(!fs::exists(first) && media::fileIdentity(second) == identity && read(second) == "first", "atomic replace and identity");
        durableWrite(second, "committed");
        require(read(second) == "committed" && media::fileIdentity(second) != identity, "durable replacement identity");
        removeFile(second);
        require(!fs::exists(second), "remove exact file");
        {
            MainInstanceLock primary(root / "library.db");
            MainInstanceLock secondary(root / "library.db");
            require(primary.primary() && !secondary.primary(), "instance exclusion");
        }
        { MainInstanceLock next(root / "library.db"); require(next.primary(), "instance reacquisition"); }
        require(compareNatural("样例2", "样例10") < 0, "numeric collation");
        require(unicodeLower("ÄBC 中文") == "äbc 中文", "Unicode lowercase");
        std::set<std::string> ids;
        for (int i = 0; i < 200; ++i) ids.insert(uuid());
        require(ids.size() == 200 && ids.begin()->size() == 36, "UUID uniqueness");
        const std::string title = "安全样例 😀 𐐷";
        const std::string xml = "<movie><title>" + title + "</title></movie>";
        for (const bool little : {false, true}) {
            for (const int width : {2, 4}) {
                std::string encoded;
                auto append = [&](uint32_t code) {
                    for (int i = 0; i < width; ++i) encoded.push_back(static_cast<char>(code >> (8 * (little ? i : width - 1 - i))));
                };
                append(0xfeff);
                if (width == 2) for (const auto code : javm::fromUtf8<char16_t>(xml)) append(code);
                else for (const auto code : javm::fromUtf8<char32_t>(xml)) append(code);
                createExclusiveFile(first, encoded);
                std::string original;
                require(readNfo(first, &original).at("title") == title && original == encoded, "UTF NFO decoding and original bytes");
                removeFile(first);
            }
        }
        for (const auto& [encoding, bytes, expected] : {
            std::tuple{"GB18030", "\xd6\xd0\xce\xc4", "中文"},
            std::tuple{"Big5", "\xa4\xa4\xa4\xe5", "中文"},
            std::tuple{"Shift_JIS", "\x83\x65\x83\x58\x83\x67", "テスト"}}) {
            createExclusiveFile(first, std::string("<?xml version=\"1.0\" encoding=\"") + encoding + "\"?><movie><title>" + bytes + "</title></movie>");
            require(readNfo(first).at("title") == expected, "legacy NFO encoding");
            removeFile(first);
        }
        Json info;
        require(nfo::number("1.5") == 1.5 && nfo::number(" 1e2 ") == 100 && nfo::number("-2") == -2, "locale-independent NFO numbers");
        for (const auto* invalid: {"+2", "1,5", "1.5extra", "1 2", "NaN", "inf", "1e9999", ""})
            require(!nfo::number(invalid), "invalid NFO number rejected");
        rejects([&] { nfo::decode(std::string("\xff\xfe\0\xd8", 4), info); });
        rejects([&] { nfo::decode(std::string("\xff\xfe\0\0\0\0\x11\0", 8), info); });
        const Json source{{"workId", "safe-fixture"}};
        const Json metadata{{"title", title}};
        writeScrapedNfo(first, metadata, source, "");
        const auto original = read(first), expected = stamp(first);
        require(readNfo(first).at("title") == title, "create UTF-8 NFO");
        rejects([&] { writeScrapedNfo(first, metadata, source, "wrong stamp"); });
        require(read(first) == original, "NFO conflict preserves source");
        writeScrapedNfo(first, Json{{"title", "安全新样例"}}, source, expected);
        require(readNfo(first).at("title") == "安全新样例" && read(withSuffix(first, ".javm.bak")) == original, "NFO replacement retains backup");
        const auto link = root / "safe-link.nfo";
        std::error_code error;
        fs::create_symlink(first, link, error);
        if (!error) {
            require(reparse(link), "symlink detection");
            rejects([&] { media::fileIdentity(link); });
            rejects([&] { writeScrapedNfo(link, metadata, source, stamp(first)); });
        } else std::cout << "symlink checks skipped: OS privilege unavailable\n";
        {
            // Only synthetic records are checked; registering the filesystem root
            // in this isolated Store does not enumerate or scan that filesystem.
            Store store(root / "safe-library.sqlite3");
            const auto sourceDirectory = root / pathFromText("安全媒体😀");
            const auto sibling = root / pathFromText("安全媒体😀-other");
            const auto destination = root / "destination";
            for(const auto& folder : {sourceDirectory, sibling, destination}) fs::create_directory(folder);
            const auto present = sourceDirectory / "present.mp4", missing = sourceDirectory / "missing.mp4", outside = sibling / "outside.mp4";
            createExclusiveFile(present, "safe fixture");
            createExclusiveFile(outside, "safe fixture");
            for(const auto& file : {present, missing, outside})
                store.save({{"path",pathText(file)},{"parent",pathText(file.parent_path())},{"name","Safe fixture"}}, Json::object());
            const auto directory = store.addDirectory(root.root_path(), true, Json::array({"mp4"}));
            require(store.directories()[0]["video_count"] == 3, "root directory counts synthetic records");
            store.finish(directory, "completed", "", true);
            require(store.find(missing)["missing"] == 1 && store.find(present)["missing"] == 0, "root directory reconciles missing files");
            require(store.directories()[0]["video_count"] == 2, "root count excludes missing files");
            const auto preview = [&](const fs::path& oldRoot) {
                return store.fileOperations("library.files.relinkPreview", {{"oldRoot",pathText(oldRoot)},{"newRoot",pathText(destination)}});
            };
            require(preview(sourceDirectory).size() == 2, "Unicode directory relink excludes prefix sibling");
            require(preview(root.root_path()).size() == 3, "root directory relink includes synthetic records");
        }
        fs::remove_all(root);
        std::cout << checks << " safe filesystem and NFO checks passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::error_code ignored; fs::remove_all(root, ignored);
        std::cerr << "check " << checks + 1 << ": " << error.what() << '\n';
        return 1;
    }
}
