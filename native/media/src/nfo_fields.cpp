#include "nfo_compat.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iomanip>
#include <sstream>

namespace media::nfo {
std::string tag(Node node) { return lower(node.name()); }
Node child(Node node, const char* name) { for (auto item: node.children()) if (tag(item) == name) return item; return {}; }
std::string text(Node node) {
    std::string result;
    for (auto item: node.children()) if (item.type() == pugi::node_pcdata || item.type() == pugi::node_cdata) result += item.value();
    if (result.size() > 256*1024) throw std::runtime_error("NFO 单个字段超过 256 KiB");
    return trim(result);
}
std::string first(Node node, std::initializer_list<const char*> names) {
    for (const auto* name: names) for (auto item: node.children()) if (tag(item) == name) {
        const auto value = text(child(item,"name") ? child(item,"name") : item);
        if (!value.empty()) return value;
    }
    return {};
}
std::optional<double> number(const std::string& input) {
    const auto value = trim(input);
    double result = 0;
    const auto parsed = std::from_chars(value.data(),value.data()+value.size(),result);
    if (value.empty() || parsed.ec != std::errc{} || parsed.ptr != value.data()+value.size() || !std::isfinite(result)) return {};
    return result;
}
namespace {
std::string attribute(Node node, const char* name) { for (auto attr: node.attributes()) if (lower(attr.name()) == name) return trim(attr.value()); return {}; }
bool truth(const std::string& value) { return lower(value) == "true" || value == "1"; }
std::vector<Node> entries(Node movie, const char* name, const char* container = "") {
    std::vector<Node> result;
    for (auto item: movie.children()) {
        if (tag(item) == name) result.push_back(item);
        else if (*container && tag(item) == container) for (auto nested: item.children()) if (tag(nested) == name) result.push_back(nested);
    }
    return result;
}
void append(Json& array, const std::string& value) {
    if (value.empty()) return;
    if (array.is_null()) array = Json::array();
    if (std::find(array.begin(),array.end(),value) == array.end()) array.push_back(value);
}
bool designation(const std::string& value) {
    // 不猜测纯数字或 IMDb ID；旧式 id 仅在形如 TEST-001 的番号时作为回退。
    if (value.empty() || value.size() > 100 || value.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") != std::string::npos) return false;
    return value.find_first_of("-_") != std::string::npos && value.find_first_of("0123456789") != std::string::npos;
}
std::string date(const std::string& input) {
    auto value = trim(input);
    std::replace(value.begin(),value.end(),'/','-');
    std::istringstream stream(value);
    int year = 0, month = 0, day = 0; char a = 0, b = 0;
    if (!(stream >> year >> a >> month >> b >> day) || a != '-' || b != '-' || year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return {};
    stream >> std::ws;
    if (!stream.eof() || !std::chrono::year_month_day{std::chrono::year{year},std::chrono::month{static_cast<unsigned>(month)},std::chrono::day{static_cast<unsigned>(day)}}.ok()) return {};
    std::ostringstream output; output << year << '-' << std::setfill('0') << std::setw(2) << month << '-' << std::setw(2) << day;
    return output.str();
}
std::optional<int64_t> runtime(const std::string& input) {
    auto value = lower(trim(input));
    double seconds = 0;
    if (std::count(value.begin(),value.end(),':') == 2) {
        const auto a = value.find(':'), b = value.find(':',a+1);
        const auto hours = number(value.substr(0,a)), minutes = number(value.substr(a+1,b-a-1)), rest = number(value.substr(b+1));
        if (!hours || !minutes || !rest || *hours < 0 || *minutes < 0 || *minutes >= 60 || *rest < 0 || *rest >= 60 || std::floor(*hours) != *hours || std::floor(*minutes) != *minutes) return {};
        seconds = *hours*3600 + *minutes*60 + *rest;
    } else {
        for (const auto* suffix: {"minutes","minute","mins","min","分钟","分"}) if (value.ends_with(suffix)) { value = trim(value.substr(0,value.size()-std::char_traits<char>::length(suffix))); break; }
        const auto minutes = number(value); if (!minutes) return {};
        seconds = *minutes * 60;
    }
    if (seconds <= 0 || seconds > 7*24*3600) return {};
    return std::llround(seconds);
}
void rating(Node movie, Json& result) {
    std::vector<std::pair<bool,double>> choices;
    for (auto entry: entries(child(movie,"ratings"),"rating")) {
        const auto value = number(first(entry,{"value"}));
        const auto maxText = attribute(entry,"max");
        const auto max = maxText.empty() ? std::optional<double>{10} : number(maxText);
        if (!value || !max || *max <= 0 || *max > 100 || *value < 0 || *value > *max) { warn(result,"已忽略无效评分，原始内容已保留"); continue; }
        const auto normalized = *value / *max * 10;
        const auto preferred = truth(attribute(entry,"default"));
        choices.emplace_back(preferred,normalized);
        if (!result.contains("ratings")) result["ratings"] = Json::array();
        result["ratings"].push_back({{"name",attribute(entry,"name")},{"max",*max},{"value",*value},{"default",preferred},{"votes",first(entry,{"votes"})}});
    }
    if (!choices.empty()) {
        const auto preferred = std::find_if(choices.begin(),choices.end(),[](auto item) { return item.first; });
        result["rating"] = (preferred == choices.end() ? choices.front() : *preferred).second;
        return;
    }
    for (auto entry: entries(movie,"rating")) {
        const auto value = number(text(entry));
        const auto maxText = attribute(entry,"max");
        const auto max = maxText.empty() ? std::optional<double>{10} : number(maxText);
        if (value && max && *max > 0 && *max <= 100 && *value >= 0 && *value <= *max) { result["rating"] = *value / *max * 10; return; }
        if (!text(entry).empty()) warn(result,"已忽略无效评分，原始内容已保留");
    }
}
}
void parseFields(Node movie, Json& result) {
    auto put = [&](const char* key, std::initializer_list<const char*> names) { const auto value = first(movie,names); if (!value.empty()) result[key] = value; };
    put("title",{"title","localtitle","name"});
    put("originaltitle",{"originaltitle","original_title"});
    put("sorttitle",{"sorttitle","sortname"});
    put("plot",{"plot","outline","review"});
    put("studio",{"studio","maker"});
    put("label",{"label","publisher"});
    put("director",{"director"});
    put("series",{"set","series"});
    for (const auto* field: {"outline","originalplot","tagline","maker","publisher","label","mpaa","customrating","countrycode","website","trailer"}) put(field,{field});
    put("num",{"num","number"});
    auto identities = Json::array();
    for (auto id: entries(movie,"uniqueid")) {
        const auto type = lower(attribute(id,"type")), value = text(id);
        if (value.empty()) continue;
        identities.push_back({{"type",type},{"value",value},{"default",truth(attribute(id,"default"))}});
        if (!result.contains("num") && (type == "num" || type == "local" || type == "jav" || type == "javm" || (type.empty() && designation(value)))) result["num"] = value;
    }
    if (!identities.empty()) result["uniqueids"] = identities;
    const auto id = first(movie,{"id"});
    if (!id.empty()) result["legacyId"] = id;
    if (!result.contains("num") && designation(id)) { result["num"] = id; warn(result,"已按旧式 id 标签回填番号"); }
    for (const auto* field: {"premiered","releasedate","release"}) {
        const auto value = first(movie,{field}); if (value.empty()) continue;
        const auto normalized = date(value);
        if (!normalized.empty()) { result["premiered"] = normalized; break; }
        warn(result,"已忽略无效发行日期，原始内容已保留");
    }
    if (const auto year = number(first(movie,{"year"})); year && *year >= 1000 && *year <= 9999 && std::floor(*year) == *year) result["year"] = static_cast<int>(*year);
    for (const auto& [name,container]: {std::pair{"genre","genres"},{"tag","tags"}}) {
        Json values = Json::array();
        for (auto entry: entries(movie,name,container)) append(values,text(entry));
        if (!values.empty()) result[name] = values;
    }
    std::vector<std::pair<int,Json>> actors;
    for (auto entry: entries(movie,"actor","actors")) {
        const auto name = child(entry,"name") ? first(entry,{"name"}) : text(entry);
        if (name.empty()) continue;
        const auto order = number(first(entry,{"order"}));
        const int priority = order && *order >= 0 && *order < 100000 && std::floor(*order) == *order ? static_cast<int>(*order) : static_cast<int>(actors.size());
        Json actor{{"name",name},{"role",first(entry,{"role"})},{"thumb",first(entry,{"thumb"})},{"order",priority}};
        actors.emplace_back(priority,std::move(actor));
    }
    std::stable_sort(actors.begin(),actors.end(),[](const auto& a,const auto& b) { return a.first < b.first; });
    std::set<std::string> names;
    for (const auto& [order,actor]: actors) if (names.insert(actor["name"].get<std::string>()).second) {
        if (!result.contains("actor")) { result["actor"] = Json::array(); result["actors"] = Json::array(); }
        result["actor"].push_back(actor["name"]); result["actors"].push_back(actor);
    }
    const auto video = child(child(child(movie,"fileinfo"),"streamdetails"),"video");
    const auto seconds = number(first(video,{"durationinseconds"}));
    if (seconds && *seconds > 0 && *seconds <= 7*24*3600) result["runtimeSeconds"] = std::llround(*seconds);
    else {
        const auto value = first(movie,{"runtime"});
        if (const auto duration = runtime(value)) result["runtimeSeconds"] = *duration;
        else if (!value.empty() && value != "0") warn(result,"已忽略无效时长，原始内容已保留");
    }
    for (const auto* field: {"width","height"}) if (const auto value = number(first(video,{field})); value && *value > 0 && *value <= 131072 && std::floor(*value) == *value) result[field] = static_cast<int>(*value);
    rating(movie,result);
    for (const auto* field: {"studio","director","country","credits"}) {
        Json values = Json::array();
        for (auto entry: entries(movie,field)) append(values,first(entry,{"name"}).empty() ? text(entry) : first(entry,{"name"}));
        if (!values.empty()) result[std::string(field)+"s"] = values;
    }
    auto& art = result["artwork"]; art = Json::object();
    for (const auto* kind: {"poster","cover"}) for (auto entry: entries(movie,kind)) append(art["poster"],text(entry));
    for (const auto* kind: {"poster","thumb","fanart"}) for (auto entry: entries(child(movie,"art"),kind)) append(art[kind],text(entry));
    for (auto entry: entries(movie,"thumb")) {
        const auto aspect = lower(attribute(entry,"aspect"));
        append(art[aspect == "poster" ? "poster" : aspect == "landscape" || aspect == "thumb" ? "thumb" : aspect.empty() ? "samples" : "other"],text(entry));
    }
    for (auto fanart: entries(movie,"fanart")) {
        for (auto entry: entries(fanart,"thumb")) append(art["fanart"],text(entry));
        append(art["fanart"],text(fanart));
    }
    for (auto it = art.begin(); it != art.end();) if (it.value().is_null()) it = art.erase(it); else ++it;
    if (art.empty()) result.erase("artwork");
}
}
