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
    "static fileDropHandler_t filesDropped;",
    "static fileDropHandler_t filesDropped;\nstatic std::function<void(const std::string&)> captureMessage;\nstatic std::function<void()> requestApplicationExit;\nstatic bool applicationExitPending = false;",
  );
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
    "    GtkWidget *parentContainer = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);",
    `    if(isolated) {
      auto* manager = webkit_web_view_get_user_content_manager((WebKitWebView*)m_webview);
      auto registerHandler = reinterpret_cast<gboolean(*)(void*, const char*)>(dlsym(dlib, "webkit_user_content_manager_register_script_message_handler"));
      if(!registerHandler) { initCode = 1; return; }
      g_signal_connect(manager, "script-message-received::javmCapture", G_CALLBACK(+[](void*, void* result, void*) {
        auto getValue = reinterpret_cast<void*(*)(void*)>(dlsym(dlib, "webkit_javascript_result_get_js_value"));
        auto isString = reinterpret_cast<gboolean(*)(void*)>(dlsym(dlib, "jsc_value_is_string"));
        auto toString = reinterpret_cast<char*(*)(void*)>(dlsym(dlib, "jsc_value_to_string"));
        if(!captureMessage || !getValue || !isString || !toString) return;
        auto* value = getValue(result);
        if(!value || !isString(value)) return;
        char* text = toString(value);
        if(text && std::strlen(text) <= 160000) captureMessage(text);
        g_free(text);
      }), nullptr);
      if(!registerHandler(manager, "javmCapture")) { initCode = 1; return; }
    }
    GtkWidget *parentContainer = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);`,
  );
  replace(
    "    gtk_widget_show_all(m_window);",
    `    if(isolated) gtk_widget_realize(m_window); // Native handles exist without mapping a visible window.
    gtk_widget_show_all(parentContainer);
    if(!isolated) gtk_widget_show(m_window);`,
  );
  replace(
    'app, "setActivationPolicy:"_sel, NSApplicationActivationPolicyRegular);',
    'app, "setActivationPolicy:"_sel, args == "--javm-isolated" ? NSApplicationActivationPolicyAccessory : NSApplicationActivationPolicyRegular);',
  );
  replace(
    '    class_addProtocol(cls, objc_getProtocol("NSApplicationDelegate"));',
    `    class_addProtocol(cls, objc_getProtocol("NSApplicationDelegate"));
    class_addMethod(cls, "applicationShouldTerminate:"_sel,
      (IMP)(+[](id, SEL, id) -> unsigned long {
        if(!requestApplicationExit) return 1; // NSTerminateNow
        if(!applicationExitPending) {
          applicationExitPending = true;
          requestApplicationExit();
        }
        return 2; // NSTerminateLater: app.exit completes the asynchronous shutdown.
      }), "Q@:@");`,
  );
  replace(
    "  void terminate(int exitCode = 0) {\n    close();",
    `  void terminate(int exitCode = 0) {
    if(applicationExitPending) {
      id app = ((id(*)(id, SEL))objc_msgSend)("NSApplication"_cls, "sharedApplication"_sel);
      ((void(*)(id, SEL, BOOL))objc_msgSend)(app, "replyToApplicationShouldTerminate:"_sel, YES);
    }
    close();`,
  );
  replace(
    "    objc_registerClassPair(cls);",
    `    class_addProtocol(cls, objc_getProtocol("WKScriptMessageHandler"));
    class_addMethod(cls, "userContentController:didReceiveScriptMessage:"_sel,
      (IMP)(+[](id, SEL, id, id message) {
        if(!captureMessage) return;
        id name = ((id(*)(id, SEL))objc_msgSend)(message, "name"_sel);
        if(!((BOOL(*)(id, SEL, id))objc_msgSend)(name, "isEqualToString:"_sel, "javmCapture"_str)) return;
        id body = ((id(*)(id, SEL))objc_msgSend)(message, "body"_sel);
        if(!((BOOL(*)(id, SEL, Class))objc_msgSend)(body, "isKindOfClass:"_sel, "NSString"_cls)) return;
        if(((unsigned long(*)(id, SEL))objc_msgSend)(body, "length"_sel) > 160000) return;
        const char* text = ((const char*(*)(id, SEL))objc_msgSend)(body, "UTF8String"_sel);
        if(text && std::strlen(text) <= 160000) captureMessage(text);
      }), "v@:@@");
    objc_registerClassPair(cls);`,
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
    '        "external"_str);',
    `        "external"_str);
    if(m_isolated) ((void(*)(id, SEL, id, id))objc_msgSend)(
      m_manager, "addScriptMessageHandler:name:"_sel, delegate, "javmCapture"_str);`,
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
export function forwardCaptureMessages(source) {
  const anchor = "    if(windowProps.injectGlobals) ";
  assert.equal(source.split(anchor).length, 2, "宿主事件转发补丁位置已变化");
  return source.replace(
    anchor,
    `    if(windowProps.webviewArgs == "--javm-managed") {
        webview::requestApplicationExit = [] {
            events::dispatchToAllApps("mainMenuItemClicked", {{"id", "javm-quit"}});
        };
    }
    if(windowProps.webviewArgs == "--javm-isolated") {
        webview::captureMessage = [](const std::string& message) {
            static unsigned count = 0;
            if(message.size() > 160000 || count++ >= 128) return;
            try {
                auto data = json::parse(message, nullptr, false);
                if(data.is_object()) events::dispatchToAllApps("javmResolutionCandidate", data);
            } catch(...) { /* Remote pages cannot turn a capture into a native call. */ }
        };
    }
${anchor}`,
  );
}
export async function patchNeutralino(source, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const settings = path.join(source, "settings.cpp");
  await writeFile(settings, escapeGlobalStrings(await readFile(settings, "utf8")));
  const webview = path.join(source, "lib/webview/webview.h");
  await writeFile(webview, isolateWebview(await readFile(webview, "utf8")));
  const windowSource = path.join(source, "api/window/window.cpp");
  await writeFile(windowSource, forwardCaptureMessages(await readFile(windowSource, "utf8")));
  const cmake = path.join(source, "CMakeLists.txt");
  const original = await readFile(cmake, "utf8");
  const patched = original.replace(
    /execute_process\(\s*COMMAND git rev-parse HEAD[\s\S]*?\n\)/,
    `set(NEU_COMMIT "${commit}+javm-posix")`,
  );
  assert.notEqual(patched, original, "源码归档的版本标识补丁未应用");
  await writeFile(cmake, patched);
}
