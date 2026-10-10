#include "store.hpp"
#include <windows.h>
#include <chrono>
#include <charconv>
#include <cmath>
#include <map>
#include <regex>
#include <set>
#include <utility>
#include <fstream>
#include <array>

namespace media {
namespace {
void check(sqlite3* db, int code) {
    if (code != SQLITE_OK && code != SQLITE_ROW && code != SQLITE_DONE) throw std::runtime_error(sqlite3_errmsg(db));
}
void exec(sqlite3* db, const std::string& sql) { check(db, sqlite3_exec(db, sql.c_str(), nullptr, nullptr, nullptr)); }
class Query {
    sqlite3* db_;
    sqlite3_stmt* stmt_ = nullptr;
public:
    Query(sqlite3* db, const std::string& sql, const Json& args = Json::array()): db_(db) {
        if (!args.is_array()) throw std::runtime_error("数据库绑定参数必须为数组：" + sql);
        check(db_, sqlite3_prepare_v2(db_, sql.c_str(), -1, &stmt_, nullptr));
        try {
            for (size_t i = 0; i < args.size(); ++i) {
                const auto& arg = args[i]; const auto n = static_cast<int>(i + 1);
                if (arg.is_null()) check(db_, sqlite3_bind_null(stmt_, n));
                else if (arg.is_boolean()) check(db_, sqlite3_bind_int(stmt_, n, arg.get<bool>()));
                else if (arg.is_number_integer()) check(db_, sqlite3_bind_int64(stmt_, n, arg.get<int64_t>()));
                else if (arg.is_number()) check(db_, sqlite3_bind_double(stmt_, n, arg.get<double>()));
                else { const auto text = arg.get<std::string>(); check(db_, sqlite3_bind_text(stmt_, n, text.data(), static_cast<int>(text.size()), SQLITE_TRANSIENT)); }
            }
        } catch (...) { sqlite3_finalize(stmt_); throw; }
    }
    ~Query() { sqlite3_finalize(stmt_); }
    Query(const Query&) = delete;
    Query& operator=(const Query&) = delete;
    bool next() { const auto code = sqlite3_step(stmt_); check(db_, code); return code == SQLITE_ROW; }
    void blob(int index, const std::string& bytes) { check(db_,sqlite3_bind_blob(stmt_,index,bytes.data(),static_cast<int>(bytes.size()),SQLITE_TRANSIENT)); }
    Json row() const {
        auto result = Json::object();
        for (int i = 0; i < sqlite3_column_count(stmt_); ++i) {
            const auto name = sqlite3_column_name(stmt_, i);
            switch (sqlite3_column_type(stmt_, i)) {
            case SQLITE_INTEGER: result[name] = sqlite3_column_int64(stmt_, i); break;
            case SQLITE_FLOAT: result[name] = sqlite3_column_double(stmt_, i); break;
            case SQLITE_TEXT: result[name] = std::string(reinterpret_cast<const char*>(sqlite3_column_text(stmt_, i)), sqlite3_column_bytes(stmt_, i)); break;
            case SQLITE_BLOB: {
                const auto* bytes=static_cast<const uint8_t*>(sqlite3_column_blob(stmt_,i));
                const auto size=sqlite3_column_bytes(stmt_,i);
                result[name]=Json::binary(size ? std::vector<uint8_t>(bytes,bytes+size) : std::vector<uint8_t>{}); break;
            }
            default: result[name] = nullptr;
            }
        }
        return result;
    }
};
Json rows(sqlite3* db, const std::string& sql, Json::initializer_list_t args = {}) {
    Query query(db, sql, Json::array(args)); auto result = Json::array();
    while (query.next()) result.push_back(query.row());
    return result;
}
void run(sqlite3* db, const std::string& sql, Json::initializer_list_t args = {}) { Query(db, sql, Json::array(args)).next(); }
class Transaction {
    sqlite3* db_; bool committed_ = false;
public:
    explicit Transaction(sqlite3* db): db_(db) { exec(db_, "BEGIN IMMEDIATE"); }
    ~Transaction() { if (!committed_) sqlite3_exec(db_, "ROLLBACK", nullptr, nullptr, nullptr); }
    void commit() { exec(db_, "COMMIT"); committed_ = true; }
};
std::string stringValue(const Json& object, const char* key) {
    return object.contains(key) && object[key].is_string() ? object[key].get<std::string>() : "";
}
std::string aliasDimension(std::string dimension) {
    if(dimension=="actresses" || dimension=="maleActors") return "actors";
    return dimension;
}
std::string canonicalName(sqlite3* db,const std::string& dimension,const std::string& name) {
    const auto found=rows(db,"SELECT canonical FROM facet_aliases WHERE dimension=? AND alias=? AND blocked=0",{aliasDimension(dimension),name});
    return found.empty()?name:found[0]["canonical"].get<std::string>();
}
Json relations(sqlite3* db, const std::string& id, const std::string& kind, const std::string&) {
    Json out=Json::array();
    for(const auto& row:rows(db,"SELECT e.name FROM entities e JOIN work_entities r ON r.entity_id=e.id WHERE r.work_id=? AND e.kind=? ORDER BY r.priority,e.name",{id,kind})) out.push_back(row["name"]);
    return out;
}
bool mergeRelations(sqlite3* db,const std::string& id,const std::string& kind,const std::string& key,const Json& values,const Json& previous) {
    auto current=relations(db,id,kind,key),before=previous;
    if(kind!="actors") { std::sort(current.begin(),current.end()); std::sort(before.begin(),before.end()); }
    if(!current.empty() && current!=before) return false;
    run(db,"DELETE FROM work_entities WHERE work_id=? AND entity_id IN (SELECT id FROM entities WHERE kind=?)",{id,kind});
    int priority=0;
    for(const auto& name:values) {
        run(db,"INSERT INTO entities(kind,name) VALUES(?,?) ON CONFLICT(kind,name) DO NOTHING",{kind,name});
        run(db,"INSERT INTO work_entities(work_id,entity_id,priority) SELECT ?,id,? FROM entities WHERE kind=? AND name=?",{id,priority++,kind,name});
    }
    return true;
}
}

Store::Store(fs::path path):path_(std::move(path)) {
    fs::create_directories(path_.parent_path());
    try {
        const auto opened=sqlite3_open_v2(pathText(path_).c_str(),&db_,SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|SQLITE_OPEN_FULLMUTEX,nullptr);
        check(db_,opened);
        check(db_,sqlite3_busy_timeout(db_,5000));
        const auto integrity=rows(db_,"PRAGMA quick_check");
        if(integrity.size()!=1 || integrity[0]["quick_check"]!="ok")
            throw std::runtime_error("当前片库完整性检查失败（"+pathText(path_)+"）："+integrity.dump());
        exec(db_,"PRAGMA foreign_keys=ON;");
        migrate();
        exec(db_,"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        prepareCatalog();
        exec(db_,"UPDATE directories SET state='interrupted',error='上次扫描中断，可重新扫描' WHERE state='scanning'");
    } catch(...) { if(db_) sqlite3_close(db_); db_=nullptr; throw; }
}
Store::~Store() { if(db_) sqlite3_close(db_); if(mainInstance_) CloseHandle(mainInstance_); }
void Store::migrate() {
    const auto version=rows(db_,"PRAGMA user_version")[0]["user_version"];
    const auto application=rows(db_,"PRAGMA application_id")[0]["application_id"];
    if(version==1 && application==1245793585) {
        // Additive feature tables preserve the existing 1.0 work model and all user data.
        exec(db_,
#include "library_features_schema.inc"
        );
        return;
    }
    if(version!=0 || application!=0 || !rows(db_,"SELECT name FROM sqlite_master WHERE type='table'").empty())
        throw std::runtime_error("这不是 JAVM 1.0 片库。原文件已保留；0.5.3 数据请使用旧版迁移入口导入。");
    Transaction transaction(db_);
    exec(db_,
#include "library_schema.inc"
    );
    exec(db_,
#include "library_features_schema.inc"
    );
    transaction.commit();
}
#include "store_library.inc"
#include "store_scrape.inc"
#include "store_import.inc"
#include "store_resources.inc"
#include "store_documents.inc"
#include "store_artwork.inc"
#include "store_file_operations.inc"
Json Store::playbackPosition(const Json& params) {
    const auto key = params.at("key").get<std::string>();
    if (key.size() != 64 || key.find_first_not_of("0123456789abcdef") != std::string::npos)
        throw std::runtime_error("播放进度标识无效");
    std::lock_guard lock(mutex_);
    const auto records = rows(db_, "SELECT source_key AS key,position_seconds AS time,duration_seconds AS duration,updated_at AS updated FROM playback_progress WHERE source_key=?", {key});
    return records.empty() ? Json(nullptr) : records[0];
}
void Store::savePlaybackPositions(const Json& params, bool importing) {
    const auto& records = params.at("records");
    if (!records.is_array() || records.size() > (importing ? 200u : 1u))
        throw std::runtime_error("播放进度批次无效");
    std::lock_guard lock(mutex_);
    Transaction transaction(db_);
    for (const auto& record : records) {
        const auto key = record.at("key").get<std::string>();
        const double time = record.at("time").get<double>();
        const double duration = record.at("duration").get<double>();
        if (key.size() != 64 || key.find_first_not_of("0123456789abcdef") != std::string::npos ||
            !std::isfinite(time) || !std::isfinite(duration) || time < 0 || duration <= 0 || time > duration ||
            !record.at("updated").is_number_integer()) throw std::runtime_error("播放进度数据无效");
        const auto updated = record.at("updated").get<int64_t>();
        if (updated < 0 || updated > 9007199254740991LL) throw std::runtime_error("播放进度时间戳无效");
        // 已看完也保留零位置，避免重复迁移旧配置时复活历史进度。
        run(db_, importing
            ? "INSERT INTO playback_progress VALUES(?,?,?,?) ON CONFLICT(source_key) DO NOTHING"
            : "INSERT INTO playback_progress VALUES(?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,updated_at=excluded.updated_at WHERE excluded.updated_at>=playback_progress.updated_at",
            {key,time,duration,updated});
    }
    transaction.commit();
}
namespace {
std::string sqlText(sqlite3_value* value) {
    const auto* text = sqlite3_value_text(value);
    return text ? std::string(reinterpret_cast<const char*>(text), sqlite3_value_bytes(value)) : "";
}
// 查询排序保持中文和数字自然顺序；不将自定义排序规则写入持久索引。
int naturalCompare(void*, int aSize, const void* a, int bSize, const void* b) noexcept {
    const std::string_view left(static_cast<const char*>(a), aSize), right(static_cast<const char*>(b), bSize);
    try {
        const auto wa = wide(std::string(left)), wb = wide(std::string(right));
        if (wa.empty() || wb.empty()) return wa.empty() == wb.empty() ? 0 : wa.empty() ? -1 : 1;
        const auto result = CompareStringEx(L"zh-CN", NORM_IGNORECASE | NORM_IGNORENONSPACE | SORT_DIGITSASNUMBERS,
            wa.data(), static_cast<int>(wa.size()), wb.data(), static_cast<int>(wb.size()), nullptr, nullptr, 0);
        if (result) return result - CSTR_EQUAL;
    } catch (...) { /* 无效旧文本仍有稳定的字节顺序。 */ }
    return left.compare(right);
}
std::string requestText(const Json& params, const char* key, const std::string& fallback = "") {
    const auto value = params.value(key, fallback);
    if (value.size() > 2048) throw std::runtime_error("查询文本过长");
    return value;
}
struct Predicate {
    std::string sql = "1";
    Json args = Json::array();
    void equal(const std::string& expression, const Json& value) {
        sql += " AND " + expression + "=?"; args.push_back(value);
    }
    void contains(const std::string& expression, const std::string& value) {
        if (value.empty()) return;
        // instr 按字面子串匹配，用户的 %、_ 不作为 SQL 通配符。
        sql += " AND instr(javm_lower(" + expression + "),javm_lower(?))>0"; args.push_back(value);
    }
    void oneOf(const std::string& expression, const Json& values, bool allowEmpty = true) {
        if (!values.is_array() || values.size() > 1000) throw std::runtime_error("筛选项数量无效，最多 1000 项");
        if (values.empty()) { if (!allowEmpty) sql += " AND 0"; return; }
        sql += " AND " + expression + " IN (";
        for (size_t i = 0; i < values.size(); ++i) {
            if (!values[i].is_string() || values[i].get_ref<const std::string&>().size() > 2048)
                throw std::runtime_error("筛选项内容无效");
            sql += i ? ",?" : "?"; args.push_back(values[i]);
        }
        sql += ")";
    }
};
std::string rawFacetSource(const std::string& dimension) {
    if(dimension=="actresses" || dimension=="maleActors")
        return "SELECT e.name,r.work_id AS video_id FROM entities e JOIN work_entities r ON r.entity_id=e.id WHERE e.kind='actors' AND e.name IN (SELECT name FROM javm_discovery_names WHERE dimension='"+dimension+"')";
    if(dimension=="actors" || dimension=="genres")
        return "SELECT e.name,r.work_id AS video_id FROM entities e JOIN work_entities r ON r.entity_id=e.id WHERE e.kind='"+dimension+"'";
    const std::map<std::string,std::string> columns{{"studios","catalog_studio"},{"labels","catalog_label"},{"directors","catalog_director"},
        {"series","catalog_series"},{"years","CAST(catalog_year AS TEXT)"},{"qualities","catalog_quality"}};
    const auto found = columns.find(dimension);
    if (found == columns.end()) throw std::runtime_error("未知筛选维度");
    return "SELECT " + found->second + " AS name,id AS video_id FROM javm_catalog";
}
std::string canonicalFacet(const std::string& source,const std::string& dimension) {
    if(dimension=="years" || dimension=="qualities") return source;
    return "SELECT COALESCE(a.canonical,f.name) AS name,f.video_id FROM ("+source+") f LEFT JOIN facet_aliases a ON a.dimension='"+aliasDimension(dimension)+"' AND a.alias=f.name AND a.blocked=0";
}
std::string facetSource(const std::string& dimension) { return canonicalFacet(rawFacetSource(dimension),dimension); }
std::string facetFavoriteSql(const std::string& dimension) {
    const auto normalized=aliasDimension(dimension);
    return "EXISTS(SELECT 1 FROM facet_favorites f WHERE f.dimension IN ('"+dimension+"','"+normalized+"') AND f.favorite=1 AND (f.name=facets.name OR f.name IN (SELECT alias FROM facet_aliases WHERE dimension='"+normalized+"' AND canonical=facets.name AND blocked=0)))";
}
Json queryRows(sqlite3* db, const std::string& sql, const Json& args) {
    Query query(db,sql,args); auto result = Json::array();
    while (query.next()) result.push_back(query.row());
    return result;
}
// 读查询有硬时间预算，失败返回界面供重试；进度和扫描取消仍走内存快照。
class QueryDeadline {
    sqlite3* db_;
    std::chrono::steady_clock::time_point until_ = std::chrono::steady_clock::now() + std::chrono::seconds(10);
public:
    explicit QueryDeadline(sqlite3* db): db_(db) {
        sqlite3_progress_handler(db_, 1000, [](void* context) {
            return std::chrono::steady_clock::now() > static_cast<QueryDeadline*>(context)->until_ ? 1 : 0;
        }, this);
    }
    ~QueryDeadline() { sqlite3_progress_handler(db_,0,nullptr,nullptr); }
};
}
void Store::prepareCatalog() {
    check(db_,sqlite3_create_collation_v2(db_,"JAVM_NATURAL",SQLITE_UTF8,nullptr,naturalCompare,nullptr));
    check(db_,sqlite3_create_function_v2(db_,"javm_lower",1,SQLITE_UTF8 | SQLITE_DETERMINISTIC,nullptr,
        [](sqlite3_context* context,int,sqlite3_value** values) {
            try {
                const auto source = wide(sqlText(values[0]));
                if (source.empty()) { sqlite3_result_text(context,"",0,SQLITE_STATIC); return; }
                const auto size = LCMapStringEx(LOCALE_NAME_INVARIANT,LCMAP_LOWERCASE,source.data(),static_cast<int>(source.size()),nullptr,0,nullptr,nullptr,0);
                if (!size) throw std::runtime_error("无法转换查询文本");
                std::wstring mapped(size,L'\0');
                LCMapStringEx(LOCALE_NAME_INVARIANT,LCMAP_LOWERCASE,source.data(),static_cast<int>(source.size()),mapped.data(),size,nullptr,nullptr,0);
                const auto result = utf8(mapped);
                sqlite3_result_text(context,result.data(),static_cast<int>(result.size()),SQLITE_TRANSIENT);
            } catch (const std::exception& error) { sqlite3_result_error(context,error.what(),-1); }
        },nullptr,nullptr,nullptr));
    check(db_,sqlite3_create_function_v2(db_,"javm_pixels",3,SQLITE_UTF8 | SQLITE_DETERMINISTIC,nullptr,
        [](sqlite3_context* context,int,sqlite3_value** values) {
            try {
                int width = sqlite3_value_int(values[0]), height = sqlite3_value_int(values[1]);
                if (width <= 0 || height <= 0) {
                    auto text = sqlText(values[2]);
                    if (const auto at = text.find("×"); at != std::string::npos) text.replace(at,2,"x");
                    const auto at = text.find_first_of("xX");
                    if (at != std::string::npos) {
                        const auto w = trim(text.substr(0,at)), h = trim(text.substr(at+1));
                        int parsedWidth = 0, parsedHeight = 0;
                        const auto rw = std::from_chars(w.data(),w.data()+w.size(),parsedWidth);
                        const auto rh = std::from_chars(h.data(),h.data()+h.size(),parsedHeight);
                        if (rw.ec == std::errc{} && rh.ec == std::errc{} && rw.ptr == w.data()+w.size() && rh.ptr == h.data()+h.size()) {
                            if (width <= 0) width = parsedWidth;
                            if (height <= 0) height = parsedHeight;
                        }
                    }
                }
                sqlite3_result_int(context,std::max(0,std::min(width,height)));
            } catch (const std::exception& error) { sqlite3_result_error(context,error.what(),-1); }
        },nullptr,nullptr,nullptr));
    exec(db_,
#include "library_catalog.inc"
    );
}

Json Store::query(const Json& params) {
    std::lock_guard lock(mutex_);
    QueryDeadline deadline(db_);
    Predicate where;
    const auto scope = requestText(params,"scope","all");
    if (scope == "favorites") where.sql += " AND c.favorite=1";
    else if (scope != "all") throw std::runtime_error("未知片库范围");
    const auto search = trim(requestText(params,"query"));
    if (!search.empty()) {
        where.sql += " AND (instr(javm_lower(COALESCE(c.title,'') || ' ' || COALESCE(c.local_id,'')),javm_lower(?))>0 OR EXISTS(SELECT 1 FROM entities a JOIN work_entities r ON r.entity_id=a.id WHERE r.work_id=c.id AND a.kind='actors' AND instr(javm_lower(a.name),javm_lower(?))>0))";
        where.args.push_back(search); where.args.push_back(search);
    }
    const auto filters = params.value("filters",Json::object());
    for (const auto* dimension: {"actors","genres"}) {
        const auto values = filters.value(dimension,Json::array());
        if (!values.empty()) {
            Predicate names; names.oneOf("name",values);
            where.sql += " AND c.id IN (SELECT video_id FROM (" + facetSource(dimension) + ") WHERE " + names.sql + ")";
            for (const auto& value: names.args) where.args.push_back(value);
        }
    }
    where.oneOf("CAST(c.catalog_year AS TEXT)",filters.value("years",Json::array()));
    where.oneOf("c.catalog_quality",filters.value("qualities",Json::array()));
    const std::map<std::string,std::string> durations{{"all","1"},{"short","minutes<90"},{"medium","minutes>=90 AND minutes<120"},{"long","minutes>=120"}};
    const auto duration = durations.find(requestText(filters,"duration","all"));
    if (duration == durations.end()) throw std::runtime_error("未知时长筛选");
    where.sql += " AND (" + duration->second + ")";
    const std::map<std::string,std::string> sizes{{"all","1"},{"small","c.file_size IS NOT NULL AND c.file_size<4294967296"},
        {"medium","c.file_size>=4294967296 AND c.file_size<8589934592"},{"large","c.file_size>=8589934592 AND c.file_size<12884901888"},{"largest","c.file_size>=12884901888"}};
    const auto size = sizes.find(requestText(filters,"size","all"));
    if (size == sizes.end()) throw std::runtime_error("未知大小筛选");
    where.sql += " AND (" + size->second + ")";
    const auto metadata = requestText(filters,"metadata","all");
    if (metadata == "missing") where.sql += " AND COALESCE(c.scan_status,0)<2";
    else if (metadata == "complete") where.sql += " AND c.scan_status>=2";
    else if (metadata != "all") throw std::runtime_error("未知资料状态");
    const auto availability=requestText(params,"availability","all");
    if(availability!="all") {
        if(availability!="metadata_only" && availability!="available" && availability!="unavailable") throw std::runtime_error("未知资源状态");
        where.equal("c.availability",availability);
    }
    if (params.contains("facet")) {
        const auto& facet = params.at("facet");
        where.sql += " AND c.id IN (SELECT video_id FROM (" + facetSource(requestText(facet,"dimension")) + ") WHERE name=?)";
        where.args.push_back(canonicalName(db_,requestText(facet,"dimension"),requestText(facet,"value")));
    }
    const std::map<std::string,std::string> sorts{{"added","c.created_at"},{"year","c.catalog_year"},
        {"code","COALESCE(c.local_id,'') COLLATE JAVM_NATURAL"},{"title","COALESCE(c.title,'') COLLATE JAVM_NATURAL"},
        {"duration","minutes"},{"size","COALESCE(c.file_size,0)"},{"actor","c.catalog_actor COLLATE JAVM_NATURAL"},{"quality","MIN(c.catalog_pixels,2160)"}};
    const auto sort = sorts.find(requestText(params,"sort","added"));
    const auto direction = requestText(params,"direction","desc");
    if (sort == sorts.end() || (direction != "asc" && direction != "desc")) throw std::runtime_error("未知排序方式");
    const auto source = " FROM (SELECT *,CASE WHEN duration>0 THEN MAX(1,CAST((duration+30)/60 AS INTEGER)) ELSE 0 END AS minutes FROM javm_catalog) c WHERE " + where.sql;
    Json result = Json::object();
    if (params.value("includeTotal",true)) result["total"] = queryRows(db_,"SELECT count(*) AS count" + source,where.args)[0]["count"];
    const auto offset = std::max(0,params.value("offset",0));
    const auto limit = std::clamp(params.value("limit",100),1,100);
    auto args = where.args; args.push_back(limit); args.push_back(offset);
    auto found = queryRows(db_,"SELECT c.*" + source + " ORDER BY " + sort->second + " " + direction + ",c.id ASC LIMIT ? OFFSET ?",args);
    for (auto& item: found) for (const auto* key: {"catalog_year","catalog_pixels","catalog_actor","catalog_studio","catalog_label","catalog_director","catalog_series","catalog_quality","minutes"}) item.erase(key);
    result["items"] = decorate(std::move(found)); result["offset"] = offset;
    return result;
}
Json Store::catalogAppend(const Json& params) {
    const auto dimension = requestText(params,"dimension");
    const std::set<std::string> allowed{"actors","actresses","maleActors","studios","labels","series","directors","genres"};
    const auto& names = params.at("names");
    if (!allowed.contains(dimension) || !names.is_array() || names.size() > 500)
        throw std::runtime_error("名单导入参数无效");
    if (params.contains("offset") && (!params.at("offset").is_number_integer() ||
        params.at("offset") < 0 || params.at("offset") > 100000 - names.size()))
        throw std::runtime_error("名单顺序参数无效");
    for (const auto& name: names) {
        if (!name.is_string()) throw std::runtime_error("名单名称无效");
        const auto& value = name.get_ref<const std::string&>();
        if (value.empty() || value.size() > 512 || value.find('\0') != std::string::npos)
            throw std::runtime_error("名单名称无效");
    }
    std::lock_guard lock(mutex_);
    QueryDeadline deadline(db_);
    Transaction transaction(db_);
    // 临时索引与本地媒体关系隔离；名字没有关联影片时计数仍为零。
    const auto offset = params.contains("offset") ? params.at("offset").get<int64_t>() :
        rows(db_,"SELECT COALESCE(MAX(position)+1,0) AS next FROM javm_discovery_names WHERE dimension=?",{dimension})[0]["next"].get<int64_t>();
    const auto insert = "INSERT INTO javm_discovery_names(dimension,name,position) SELECT ?,value,?+MIN(CAST(key AS INTEGER)) FROM json_each(?) GROUP BY value ";
    run(db_,insert+std::string(params.contains("offset") ?
        "ON CONFLICT(dimension,name) DO UPDATE SET position=excluded.position" :
        "ON CONFLICT(dimension,name) DO NOTHING"),{dimension,offset,names.dump()});
    const auto count = rows(db_,"SELECT count(*) AS count FROM javm_discovery_names WHERE dimension=?",{dimension})[0]["count"].get<int64_t>();
    if (count > 100000) throw std::runtime_error("名单数量超过限制");
    transaction.commit();
    return {{"count",count}};
}
Json Store::facets(const Json& params) {
    std::lock_guard lock(mutex_);
    QueryDeadline deadline(db_);
    const auto dimension = requestText(params,"dimension","actors");
    auto facet = facetSource(dimension);
    Json sourceArgs = Json::array();
    if (params.value("includeCatalog",false)) {
        facet += " UNION ALL SELECT name,NULL AS video_id FROM javm_discovery_names WHERE dimension=?";
        sourceArgs.push_back(dimension);
    }
    if (params.contains("catalogNames")) {
        const auto& names = params.at("catalogNames");
        if (dimension != "genres" || !names.is_array() || names.size() > 5000)
            throw std::runtime_error("分类目录参数无效");
        for (const auto& name : names)
            if (!name.is_string() || name.get_ref<const std::string&>().empty() ||
                name.get_ref<const std::string&>().size() > 512)
                throw std::runtime_error("分类目录名称无效");
        // 内置目录只参与本次分页查询；NULL 不计作影片，不写入媒体关系表。
        facet += " UNION ALL SELECT value AS name,NULL AS video_id FROM json_each(?)";
        sourceArgs.push_back(names.dump());
    }
    facet=canonicalFacet(facet,dimension);
    const auto grouped = "SELECT name,count(DISTINCT video_id) AS count FROM (" + facet + ") WHERE name<>'' GROUP BY name";
    const auto source = " FROM (" + grouped + ") AS facets";
    Predicate where;
    const auto search=trim(requestText(params,"query"));
    if(!search.empty()) {
        where.sql+=" AND (instr(javm_lower(name),javm_lower(?))>0 OR name IN (SELECT canonical FROM facet_aliases WHERE dimension=? AND blocked=0 AND instr(javm_lower(alias),javm_lower(?))>0) OR name IN (SELECT name FROM facet_names WHERE dimension=? AND instr(javm_lower(label),javm_lower(?))>0))";
        for(const auto& value:Json::array({search,aliasDimension(dimension),search,aliasDimension(dimension),search})) where.args.push_back(value);
    }
    if (params.contains("names")) where.oneOf("name",params.at("names"),false);
    if (params.value("favoritesOnly",false)) {
        where.sql += " AND "+facetFavoriteSql(dimension);
    }
    auto filteredArgs = sourceArgs;
    for (const auto& value : where.args) filteredArgs.push_back(value);
    Json result = Json::object();
    if (params.value("includeTotal",true)) {
        result["total"] = queryRows(db_,"SELECT count(*) AS count" + source + " WHERE " + where.sql,filteredArgs)[0]["count"];
        result["available"] = queryRows(db_,"SELECT count(*) AS count" + source,sourceArgs)[0]["count"];
    }
    const auto sort = requestText(params,"sort","name");
    if (sort != "name" && sort != "source") throw std::runtime_error("未知维度排序方式");
    std::string order = dimension == "years" ? "CAST(name AS INTEGER) DESC" : "name COLLATE JAVM_NATURAL";
    auto orderedSource = source;
    if (sort == "source" && dimension != "years") {
        // 别名归并后取最早的来源位置；本地独有条目放到来源名单之后。
        const auto ranked = canonicalFacet("SELECT name,position AS video_id FROM javm_discovery_names WHERE dimension='"+dimension+"'",dimension);
        orderedSource = " FROM (SELECT counts.*,r.source_position FROM ("+grouped+") counts LEFT JOIN (SELECT name,MIN(video_id) AS source_position FROM ("+ranked+") GROUP BY name) r ON r.name=counts.name) AS facets";
        order = "source_position IS NULL,source_position,name COLLATE JAVM_NATURAL";
    }
    const auto offset = std::max(0,params.value("offset",0));
    const bool includeFavorites=params.value("includeFavorites",false);
    auto args = Json::array();
    for (const auto& value : filteredArgs) args.push_back(value);
    args.push_back(std::clamp(params.value("limit",100),1,100)); args.push_back(offset);
    const auto columns=std::string("SELECT name,count")+(includeFavorites ? ","+facetFavoriteSql(dimension)+" AS favorite" : "")+(params.value("includeLabels",false)?",COALESCE((SELECT label FROM facet_names WHERE dimension='"+aliasDimension(dimension)+"' AND name=facets.name),'') AS label":"");
    result["items"] = queryRows(db_,columns + orderedSource + " WHERE " + where.sql + " ORDER BY " + order + " LIMIT ? OFFSET ?",args);
    result["offset"] = offset;
    return result;
}
Json Store::summary() {
    std::lock_guard lock(mutex_);
    return rows(db_,"SELECT count(*) AS total,COALESCE(sum(favorite<>0),0) AS favorites FROM works")[0];
}
Json Store::video(const std::string& id) {
    std::lock_guard lock(mutex_);
    auto result=decorate(rows(db_,"SELECT * FROM javm_catalog WHERE id=?",{id}));
    return result.empty()?Json(nullptr):result[0];
}
Json Store::videos(int offset,int limit) {
    std::lock_guard lock(mutex_);
    return decorate(rows(db_,"SELECT * FROM javm_catalog ORDER BY created_at,id LIMIT ? OFFSET ?",{limit,offset}));
}
bool Store::duplicateCode(const std::string& code,const std::string& except) {
    std::lock_guard lock(mutex_);
    return !rows(db_,"SELECT id FROM works WHERE code_key=? AND id<>? LIMIT 1",{codeKey(code),except}).empty();
}
void Store::favorite(const std::string& id,bool value) {
    std::lock_guard lock(mutex_);
    run(db_,"UPDATE works SET favorite=? WHERE id=?",{value,id});
    if(!sqlite3_changes(db_)) throw std::runtime_error("作品不存在");
}
void Store::facetFavorite(const Json& params) {
    std::lock_guard lock(mutex_);
    const auto dimension=aliasDimension(requestText(params,"dimension")), name=canonicalName(db_,dimension,trim(requestText(params,"name")));
    facetSource(dimension);
    if(name.empty() || name.size()>512 || name.find('\0')!=std::string::npos || !params.contains("value") || !params["value"].is_boolean())
        throw std::runtime_error("收藏参数无效");
    if(rows(db_,"SELECT count(*) AS count FROM facet_favorites WHERE favorite=1")[0]["count"].get<int64_t>()>=10000 && params["value"]==true &&
       rows(db_,"SELECT 1 FROM facet_favorites WHERE dimension=? AND name=? AND favorite=1",{dimension,name}).empty())
        throw std::runtime_error("维度收藏已达到 10000 项上限");
    Transaction transaction(db_);
    if(!params.at("value").get<bool>()) run(db_,"UPDATE facet_favorites SET favorite=0 WHERE dimension IN (?,?,?) AND (name=? OR name IN (SELECT alias FROM facet_aliases WHERE dimension=? AND canonical=? AND blocked=0))",{dimension,dimension=="actors"?"actresses":dimension,dimension=="actors"?"maleActors":dimension,name,dimension,name});
    run(db_,"INSERT INTO facet_favorites VALUES(?,?,?) ON CONFLICT(dimension,name) DO UPDATE SET favorite=excluded.favorite",{dimension,name,params["value"]});
    transaction.commit();
}
#include "store_aliases.inc"
#include "store_related.inc"
#include "store_instance.inc"
}
