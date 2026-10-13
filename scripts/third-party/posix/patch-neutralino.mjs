import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function escapeGlobalStrings(source) {
  let count = 0;
  const result = source
    .replace(/("var NL_[A-Z_]+=)'" \+ (.+?) \+ "';"/g, (_match, prefix, expression) => {
      ++count;
      return `${prefix}" + helpers::jsonToString(json(${expression})) + ";"`;
    })
    .replace(
      '"=JSON.parse(\'" + helpers::jsonToString(it.value()) + "\');"',
      '"=" + helpers::jsonToString(it.value()) + ";"',
    );
  assert.equal(count, 15, "官方宿主全局变量实现已变化，需要重新审查补丁");
  return result;
}

// These public WebKit APIs only affect the dedicated resolver host. The regular
// application retains upstream behavior and the official API/Extension protocol.
export function isolateWebview(source) {
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, "WebView 隔离补丁的上游位置已变化");
    source = source.replace(before, after);
  };
  replace(
    "    m_webview = webkit_web_view_new();",
    `    const bool isolated = args == "--javm-isolated";
    if(isolated) {
      auto getType = reinterpret_cast<GType(*)()>(dlsym(dlib, "webkit_web_view_get_type"));
      if(!getType) { initCode = 1; return; }
      m_webview = GTK_WIDGET(g_object_new(getType(), "is-ephemeral", TRUE, "is-muted", TRUE, nullptr));
      g_signal_connect(m_webview, "permission-request", G_CALLBACK(+[](void*, void* request, void*) -> gboolean {
        auto deny = reinterpret_cast<void(*)(void*)>(dlsym(dlib, "webkit_permission_request_deny"));
        if(deny) deny(request);
        return TRUE;
      }), nullptr);
    } else m_webview = webkit_web_view_new();`,
  );
  replace(
    "webkit_settings_set_javascript_can_access_clipboard(settings, true);",
    "webkit_settings_set_javascript_can_access_clipboard(settings, !isolated);",
  );
  replace(
    "    gtk_widget_show_all(m_window);",
    `    gtk_widget_show_all(parentContainer);
    if(!isolated) gtk_widget_show(m_window);`,
  );
  replace(
    'app, "setActivationPolicy:"_sel, NSApplicationActivationPolicyRegular);',
    'app, "setActivationPolicy:"_sel, args == "--javm-isolated" ? NSApplicationActivationPolicyAccessory : NSApplicationActivationPolicyRegular);',
  );
  replace(
    '    m_manager =\n        ((id(*)(id, SEL))objc_msgSend)(config, "userContentController"_sel);',
    `    m_isolated = args == "--javm-isolated";
    if(m_isolated) {
      id dataStore = ((id(*)(id, SEL))objc_msgSend)("WKWebsiteDataStore"_cls, "nonPersistentDataStore"_sel);
      ((void(*)(id, SEL, id))objc_msgSend)(config, "setWebsiteDataStore:"_sel, dataStore);
    }
    m_manager =
        ((id(*)(id, SEL))objc_msgSend)(config, "userContentController"_sel);`,
  );
  replace(
    '    ((void (*)(id, SEL, id))objc_msgSend)(m_window, "makeKeyAndOrderFront:"_sel,',
    '    if(!m_isolated) ((void (*)(id, SEL, id))objc_msgSend)(m_window, "makeKeyAndOrderFront:"_sel,',
  );
  replace(
    "    dispatch([&]() {\n      ((void (*)(id, SEL, BOOL))objc_msgSend)(",
    "    if(!m_isolated) dispatch([&]() {\n      ((void (*)(id, SEL, BOOL))objc_msgSend)(",
  );
  replace(
    "            WKUserScriptInjectionTimeAtDocumentStart, 1));",
    "            WKUserScriptInjectionTimeAtDocumentStart, m_isolated ? 0 : 1));",
  );
  replace("  id m_webview;", "  bool m_isolated = false;\n  id m_webview;");
  return source;
}
export async function patchNeutralino(source, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const settings = path.join(source, "settings.cpp");
  await writeFile(settings, escapeGlobalStrings(await readFile(settings, "utf8")));
  const webview = path.join(source, "lib/webview/webview.h");
  await writeFile(webview, isolateWebview(await readFile(webview, "utf8")));
  const cmake = path.join(source, "CMakeLists.txt");
  const original = await readFile(cmake, "utf8");
  const patched = original.replace(
    /execute_process\(\s*COMMAND git rev-parse HEAD[\s\S]*?\n\)/,
    `set(NEU_COMMIT "${commit}+javm-posix")`,
  );
  assert.notEqual(patched, original, "源码归档的版本标识补丁未应用");
  await writeFile(cmake, patched);
}
