#include "nfo_compat.hpp"
#include <fstream>
#include <set>
#include <vector>
#include <sstream>
#include <windows.h>

namespace media {
Json readNfo(const fs::path& path, std::string* original) {
    constexpr size_t limit = 2 * 1024 * 1024;
    if (fs::file_size(path) > limit) throw std::runtime_error("NFO 超过 2 MiB");
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw std::runtime_error("NFO 无法读取");
    // 读取量有硬上限，也覆盖检查后文件继续增长的情况。
    std::vector<char> bytes(limit + 1);
    stream.read(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    const auto size = static_cast<size_t>(stream.gcount());
    if (size > limit || stream.bad()) throw std::runtime_error("NFO 读取失败或超过 2 MiB");
    const std::string source(bytes.data(),size);
    Json result = Json::object();
    const auto content = nfo::repair(nfo::decode(source,result),result);
    pugi::xml_document document;
    // fragment 保留根节点外的正文，以便拒绝默认解析选项会静默丢弃的残余内容。
    const auto parsed = document.load_buffer(content.data(),content.size(),pugi::parse_default | pugi::parse_doctype | pugi::parse_fragment,pugi::encoding_utf8);
    if (!parsed) throw std::runtime_error(std::string("NFO XML 无效：") + parsed.description());
    size_t nodes = 0;
    std::vector<std::pair<pugi::xml_node, int>> pending{{document, 0}};
    while (!pending.empty()) {
        const auto [node, depth] = pending.back(); pending.pop_back();
        if (++nodes > 50000 || depth > 64) throw std::runtime_error("NFO 结构过深或节点过多");
        if (node.type() == pugi::node_doctype) throw std::runtime_error("NFO 不支持 DTD");
        for (auto child: node.children()) pending.emplace_back(child, depth + 1);
    }
    auto movie = document.document_element();
    if (nfo::tag(movie) != "movie") throw std::runtime_error("NFO 必须只有一个 movie 根节点");
    for (auto node: document.children()) {
        if ((node.type() == pugi::node_element && node != movie) ||
            ((node.type() == pugi::node_pcdata || node.type() == pugi::node_cdata) && !trim(node.value()).empty()))
            throw std::runtime_error("NFO 必须只有一个 movie 根节点，且根节点外不能有正文");
    }
    nfo::parseFields(movie,result);
    if (original) *original = source;
    return result;
}
namespace {
void atomicWrite(const fs::path& path, const std::string& content, const std::string& expected) {
    const auto temporary=fs::path(path.wstring()+L".javm-"+wide(uuid())+L".tmp");
    try {
        std::ofstream output(temporary,std::ios::binary|std::ios::trunc);
        if (!output || !output.write(content.data(),static_cast<std::streamsize>(content.size())) || !output.flush())
            throw std::runtime_error("无法写入资料文件，请检查目录权限和磁盘空间");
        output.close();
        if (fs::exists(path)) {
            if (expected.empty() || reparse(path) || stamp(path)!=expected) throw std::runtime_error("资料文件已被其他程序修改，请重试");
            const auto backup=fs::path(path.wstring()+L".javm.bak");
            if (!fs::exists(backup)) fs::copy_file(path,backup,fs::copy_options::none);
        } else if (!expected.empty()) throw std::runtime_error("资料文件已被移除，请重试");
        if (!MoveFileExW(temporary.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("无法替换资料文件，原文件和备份保留");
    } catch (...) { std::error_code ec; fs::remove(temporary,ec); throw; }
}
}
fs::path saveScrapedArtwork(const fs::path& source, const fs::path& video) {
    if (source.empty()) return {};
    if (!fs::is_regular_file(source) || reparse(source) || fs::file_size(source)>20*1024*1024) throw std::runtime_error("封面文件无效或超过 20 MiB");
    std::ifstream input(source,std::ios::binary);
    std::string content(20*1024*1024+1,'\0');
    input.read(content.data(),static_cast<std::streamsize>(content.size()));
    if (input.bad() || input.gcount()>20*1024*1024) throw std::runtime_error("封面读取失败或超过 20 MiB");
    content.resize(static_cast<size_t>(input.gcount()));
    std::string suffix;
    if (content.size()>3 && static_cast<unsigned char>(content[0])==0xff && static_cast<unsigned char>(content[1])==0xd8 && static_cast<unsigned char>(content[2])==0xff) suffix=".jpg";
    else if (content.starts_with(std::string("\x89PNG\r\n\x1a\n",8))) suffix=".png";
    else if (content.size()>12 && content.starts_with("RIFF") && content.substr(8,4)=="WEBP") suffix=".webp";
    else throw std::runtime_error("封面响应不是支持的图片格式");
    auto target=video.parent_path()/wide(pathText(video.stem())+"-poster"+suffix);
    if (fs::exists(target)) {
        if (reparse(target) || !fs::is_regular_file(target)) throw std::runtime_error("封面路径已被占用");
        return target;
    }
    atomicWrite(target,content,"");
    return target;
}
namespace {
std::string renderNfo(pugi::xml_document& document, const Json& metadata, const Json& source) {
    auto movie=document.document_element();
    if (!movie) movie=document.append_child("movie");
    auto erase=[&](std::initializer_list<const char*> names) {
        for (auto node=movie.first_child();node;) { const auto next=node.next_sibling();
            for (const auto* name: names) if (nfo::tag(node)==name) { movie.remove_child(node); break; }
            node=next;
        }
    };
    auto set=[&](const char* name,const std::string& value) {
        erase({name}); if (!value.empty()) movie.append_child(name).text().set(value.c_str());
    };
    erase({"original_title","maker","publisher","number"});
    if (metadata.value("plot",std::string{}).empty()) erase({"outline","review"});
    for (const auto* name: {"title","originaltitle","plot","director","studio","label"}) set(name,metadata.value(name,std::string{}));
    erase({"premiered","releasedate","release","release_date"});
    set("premiered",metadata.value("premiered",std::string{}));
    set("num",metadata.value("num",std::string{}));
    erase({"set","series"}); set("set",metadata.value("series",std::string{}));
    const auto seconds=metadata.value("runtimeSeconds",int64_t{0});
    set("runtime",seconds>0 ? std::to_string(std::max<int64_t>(1,(seconds+30)/60)) : "");
    if (source.value("hasVideo",false)) {
    auto fileinfo=nfo::child(movie,"fileinfo"); if (!fileinfo) fileinfo=movie.append_child("fileinfo");
    auto streams=nfo::child(fileinfo,"streamdetails"); if (!streams) streams=fileinfo.append_child("streamdetails");
    auto video=nfo::child(streams,"video"); if (!video) video=streams.append_child("video");
    while (auto duration=nfo::child(video,"durationinseconds")) video.remove_child(duration);
    video.append_child("durationinseconds").text().set(seconds);
    }
    auto ratings=nfo::child(movie,"ratings");
    if (metadata.value("rating",0.0)>0 || ratings || nfo::child(movie,"rating")) {
        if (!ratings) ratings=movie.append_child("ratings");
        for (auto rating: ratings.children()) {
            if (std::string(rating.attribute("name").value())=="javm") { ratings.remove_child(rating); break; }
        }
        for (auto rating: ratings.children()) { auto attr=rating.attribute("default"); if (!attr) attr=rating.append_attribute("default"); attr.set_value("false"); }
        auto rating=ratings.append_child("rating"); rating.append_attribute("name")="javm"; rating.append_attribute("max")=10; rating.append_attribute("default")="true";
        rating.append_child("value").text().set(metadata["rating"].get<double>());
        set("rating",std::to_string(metadata["rating"].get<double>()));
    }
    for (const auto* name: {"actor","genre","tag"}) {
        const auto values=metadata.value(name,Json::array());
        // 未变化的演员保留角色、头像等子节点。
        Json current=Json::object(); nfo::parseFields(movie,current);
        if (current.value(name,Json::array())==values) continue;
        if (std::string(name)=="actor") erase({"actor","actors"});
        else if (std::string(name)=="genre") erase({"genre","genres"}); else erase({"tag","tags"});
        for (const auto& value: values) {
            auto node=movie.append_child(name);
            if (std::string(name)=="actor") node=node.append_child("name");
            node.text().set(value.get<std::string>().c_str());
        }
    }
    for (auto node=movie.first_child();node;) { auto next=node.next_sibling();
        if (nfo::tag(node)=="uniqueid" && (std::string(node.attribute("type").value())=="metatube" || std::string(node.attribute("type").value())=="javm-work")) movie.remove_child(node);
        node=next;
    }
    const auto sources=source.value("sources",Json::array({{{"provider",source.value("provider",std::string{})},{"id",source.value("id",std::string{})}}}));
    for(const auto& item:sources) if(!item.value("provider",std::string{}).empty() && !item.value("id",std::string{}).empty()) {
        auto unique=movie.append_child("uniqueid"); unique.append_attribute("type")="metatube";
        unique.text().set((item.at("provider").get<std::string>()+":"+item.at("id").get<std::string>()).c_str());
    }
    auto identity=movie.append_child("uniqueid"); identity.append_attribute("type")="javm-work";
    identity.text().set(source.at("workId").get<std::string>().c_str());
    const auto poster=metadata.value("poster",std::string{});
    if (!poster.empty()) {
        bool found=false;
        for (auto node: movie.children()) if (nfo::tag(node)=="thumb" && std::string(node.attribute("aspect").value())=="poster") { node.text().set(poster.c_str()); found=true; break; }
        if (!found) { auto thumb=movie.append_child("thumb"); thumb.append_attribute("aspect")="poster"; thumb.text().set(poster.c_str()); }
    }
    std::ostringstream output; document.save(output,"  ",pugi::format_default,pugi::encoding_utf8);
    const auto bytes=output.str();
    if (bytes.size()>2*1024*1024) throw std::runtime_error("生成的 NFO 超过 2 MiB");
    return bytes;
}
}
std::string serializeNfo(const Json& metadata,const Json& source) {
    pugi::xml_document document;
    return renderNfo(document,metadata,source);
}
std::string writeScrapedNfo(const fs::path& path,const Json& metadata,const Json& source,const std::string& expected) {
    pugi::xml_document document;
    if ((fs::exists(path) ? stamp(path) : std::string{})!=expected) throw std::runtime_error("NFO 已被修改，请重新刮削");
    if (fs::exists(path)) {
        if (reparse(path)) throw std::runtime_error("NFO 不支持符号链接");
        std::string original;
        auto ignored=readNfo(path,&original);
        auto content=nfo::repair(nfo::decode(original,ignored),ignored);
        if (!document.load_buffer(content.data(),content.size(),pugi::parse_default|pugi::parse_comments,pugi::encoding_utf8)) throw std::runtime_error("已有 NFO 无法解析，原文件保留");
    }
    const auto bytes=renderNfo(document,metadata,source);
    atomicWrite(path,bytes,expected);
    return bytes;
}
}
