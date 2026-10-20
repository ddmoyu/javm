#include "../../native/process/src/process_spec.hpp"
#include <iostream>

int main() {
    using nlohmann::json;
    const auto valid = json{{"schema", 1}, {"file", "/工具 目录/ffmpeg"},
        {"args", {"", "中文😀", "$(touch marker)", "a'b\"c", "one\ntwo"}},
        {"envs", {{"HTTP_PROXY", "http://safe.invalid"}, {"NO_PROXY", ""}}}, {"timeoutMs", 200}};
    int checks = 0;
    const auto reject = [&](const json& value) {
        try { javm::process::parseSpec(value.dump()); }
        catch (...) { ++checks; return; }
        throw std::runtime_error("Expected rejection");
    };
    try {
        const auto spec = javm::process::parseSpec(valid.dump());
        if (spec.file != "/工具 目录/ffmpeg" || spec.args.size() != 5 || spec.args[2] != "$(touch marker)" ||
            spec.envs.at("NO_PROXY") != "" || spec.timeoutMs != 200) return 1;
        for (const auto& field : {"file", "args", "schema"}) { auto bad = valid; bad.erase(field); reject(bad); }
        for (const json& file : {json("relative"), json(3), json(std::string("/a\0b", 4))}) { auto bad = valid; bad["file"] = file; reject(bad); }
        for (const json& timeout : {json(-1), json(86'400'001), json(0.1), json("1")}) { auto bad = valid; bad["timeoutMs"] = timeout; reject(bad); }
        for (const auto& key : {"", "1VAR", "VAR=VALUE", "VAR-NAME"}) { auto bad = valid; bad["envs"] = {{key, "value"}}; reject(bad); }
        auto bad = valid; bad["args"] = {std::string(128 * 1024, 'x')}; reject(bad);
        bad = valid; bad["args"] = std::vector<std::string>(1025); reject(bad);
        bad = valid; bad["envs"] = {{"TOKEN", std::string("a\0b", 3)}}; reject(bad);
        bad = valid; bad["envs"] = json::array(); reject(bad);
        reject(json::array());
        std::cout << "Process payload boundary checks: " << checks + 1 << '\n';
    } catch (...) { return 1; }
}
