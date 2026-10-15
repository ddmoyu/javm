#pragma once
#include "common.hpp"
#include <pugixml.hpp>
#include <charconv>
#include <optional>
#include <set>

namespace media::nfo {
using Node = pugi::xml_node;
std::string tag(Node node);
Node child(Node node, const char* name);
std::string text(Node node);
std::string first(Node node, std::initializer_list<const char*> names);
std::optional<double> number(const std::string& value);
void warn(Json& result, const std::string& message);
std::string decode(const std::string& bytes, Json& result);
std::string repair(const std::string& source, Json& result);
void parseFields(Node movie, Json& result);
}
