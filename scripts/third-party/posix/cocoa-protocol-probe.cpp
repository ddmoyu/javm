// CI-only observer loaded into the isolated blank-window host. Do not reference
// AppKit/WebKit @protocol literals here: that would register missing protocols
// before the host starts and hide the bug this probe is intended to detect.
#include <objc/message.h>
#include <objc/runtime.h>
#include <dispatch/dispatch.h>
#include <cstdio>
#include <cstdlib>

namespace {
void report(bool ok, const char* reason, unsigned entries, unsigned queries, bool touchBar) {
  const char* destination = std::getenv("JAVM_PROTOCOL_PROBE_FILE");
  if (!destination) return;
  if (FILE* file = std::fopen(destination, "w")) {
    std::fprintf(file,
      "{\"ok\":%s,\"reason\":\"%s\",\"classes\":3,\"protocolEntries\":%u,"
      "\"conformanceQueries\":%u,\"touchBarProtocolAvailable\":%s}\n",
      ok ? "true" : "false", reason, entries, queries, touchBar ? "true" : "false");
    std::fclose(file);
  }
}

void inspect(void*) {
  static unsigned attempts = 0;
  Class classes[] = {objc_lookUpClass("AppDelegate"), objc_lookUpClass("WindowDelegate"),
                     objc_lookUpClass("WebViewNavDelegate")};
  if (!classes[0] || !classes[1] || !classes[2]) {
    if (++attempts < 500)
      dispatch_after_f(dispatch_time(DISPATCH_TIME_NOW, 10000000), dispatch_get_main_queue(), nullptr, inspect);
    else report(false, "delegate-classes-unavailable", 0, 0, false);
    return;
  }
  unsigned entries = 0;
  for (Class cls : classes) {
    unsigned count = 0;
    Protocol** protocols = class_copyProtocolList(cls, &count);
    for (unsigned index = 0; index < count; ++index) {
      if (!protocols[index]) {
        std::free(protocols);
        report(false, "null-protocol-entry", entries, 0, false);
        return;
      }
      ++entries;
    }
    std::free(protocols);
  }
  // A valid, unadopted protocol forces a full traversal of every protocol list.
  Protocol* query = objc_allocateProtocol("JAVMSafeConformanceProbe");
  if (!query) { report(false, "query-protocol-unavailable", entries, 0, false); return; }
  objc_registerProtocol(query);
  unsigned queries = 0;
  for (Class cls : classes) {
    if (class_conformsToProtocol(cls, query)) {
      report(false, "unexpected-conformance", entries, queries, false);
      return;
    }
    ++queries;
  }
  id app = reinterpret_cast<id(*)(id, SEL)>(objc_msgSend)(
    reinterpret_cast<id>(objc_getClass("NSApplication")), sel_registerName("sharedApplication"));
  id delegate = reinterpret_cast<id(*)(id, SEL)>(objc_msgSend)(app, sel_registerName("delegate"));
  if (!delegate) { report(false, "app-delegate-unavailable", entries, queries, false); return; }
  if (reinterpret_cast<BOOL(*)(id, SEL, Protocol*)>(objc_msgSend)(
      delegate, sel_registerName("conformsToProtocol:"), query)) {
    report(false, "unexpected-delegate-conformance", entries, queries, false);
    return;
  }
  ++queries;
  Protocol* touchBar = objc_getProtocol("NSTouchBarProvider");
  if (touchBar) {
    reinterpret_cast<BOOL(*)(id, SEL, Protocol*)>(objc_msgSend)(
      delegate, sel_registerName("conformsToProtocol:"), touchBar);
    ++queries;
  }
  report(true, "", entries, queries, touchBar != nullptr);
}

__attribute__((constructor)) void begin() {
  if (std::getenv("JAVM_PROTOCOL_PROBE_FILE"))
    dispatch_async_f(dispatch_get_main_queue(), nullptr, inspect);
}
}
