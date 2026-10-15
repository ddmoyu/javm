import type { CdpConnection } from "../streamResolution/cdp";

type BrowserConnection = Pick<CdpConnection, "send">;
interface AccessibleNode {
  ignored?: boolean;
  role?: { value?: unknown };
  backendDOMNodeId?: number;
}

// 仅在正在验证的官方子页面中读取交互状态，不提取或记录标签文字、输入值或验证令牌。
const challengePage =
  "location.origin==='https://challenges.cloudflare.com'&&location.pathname.startsWith('/cdn-cgi/challenge-platform/')";
const checkboxState = `function(){
  if(!(${challengePage})||this.tagName!=='INPUT'||this.type!=='checkbox'||this.checked||this.disabled)return false;
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})};
  // 定制控件可以将 input 设为透明，由关联 label 绘制；隐藏/禁用/已勾选的控件不算人工验证。
  const r=this.getBoundingClientRect();
  return r.width>0&&r.height>0&&this.checkVisibility({checkVisibilityCSS:true})&&
    (visible(this)||Array.from(this.labels||[]).slice(0,4).some(visible));
}`;

/** Accessibility 可观察封闭 Shadow DOM；只读检查，不聚焦、滚动或点击控件。 */
export async function inspectChallengeInteraction(
  cdp: BrowserConnection,
  session: string,
  signal: AbortSignal,
): Promise<"required" | "none" | "unavailable"> {
  try {
    signal.throwIfAborted();
    const location = await cdp.send(
      "Runtime.evaluate",
      { expression: challengePage, returnByValue: true, silent: true, timeout: 250 },
      session,
    );
    signal.throwIfAborted();
    if ((location.result as { value?: unknown } | undefined)?.value !== true) return "none";
    const tree = await cdp.send("Accessibility.getFullAXTree", { depth: 16 }, session);
    signal.throwIfAborted();
    if (!Array.isArray(tree.nodes) || tree.nodes.length > 512) return "unavailable";
    const checkboxes = (tree.nodes as AccessibleNode[])
      .filter(
        (node) =>
          node.ignored === false &&
          node.role?.value === "checkbox" &&
          Number.isSafeInteger(node.backendDOMNodeId) &&
          node.backendDOMNodeId! > 0,
      )
      .slice(0, 4);
    for (const node of checkboxes) {
      signal.throwIfAborted();
      const resolved = await cdp.send(
        "DOM.resolveNode",
        { backendNodeId: node.backendDOMNodeId },
        session,
      );
      const objectId = (resolved.object as { objectId?: unknown } | undefined)?.objectId;
      if (typeof objectId !== "string" || !objectId) continue;
      try {
        signal.throwIfAborted();
        const state = await cdp.send(
          "Runtime.callFunctionOn",
          { objectId, functionDeclaration: checkboxState, returnByValue: true, silent: true },
          session,
        );
        signal.throwIfAborted();
        if ((state.result as { value?: unknown } | undefined)?.value === true) return "required";
      } finally {
        // 宿主退出会释放全部远程对象，取消后不再向已关闭连接发送命令。
        if (!signal.aborted)
          await cdp.send("Runtime.releaseObject", { objectId }, session).catch(() => {});
      }
    }
    return "none";
  } catch {
    // 页面重载或不支持 Accessibility 时继续原有有界读取，不因诊断能力缺失而失败。
    return "unavailable";
  }
}
