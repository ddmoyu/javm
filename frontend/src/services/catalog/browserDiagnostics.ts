import type { CdpConnection, CdpEvent } from "../streamResolution/cdp";

export type CatalogBrowserFailure =
  | "http_denied"
  | "interaction_required"
  | "authentication_required"
  | "dialog_required"
  | "invalid_url"
  | "network_error"
  | "target_limit"
  | "request_limit"
  | "navigation_rejected"
  | "rate_limited"
  | "http_error"
  | "missing_target"
  | "response_too_large"
  | "read_interrupted";
export class CatalogBrowserError extends Error {
  constructor(
    readonly reason: CatalogBrowserFailure,
    message: string,
  ) {
    super(message);
  }
}
export class CatalogReadCancellation extends Error {
  constructor(readonly reason: "replaced" | "view_closed" | "shutdown") {
    super(reason);
  }
}
type TargetKind = "page" | "iframe" | "worker" | "shared_worker" | "service_worker" | "unknown";
interface RequestTrace {
  id: number;
  target: TargetKind;
  kind: string;
  type: string;
  event:
    | "pending"
    | "response"
    | "finished"
    | "failed"
    | "canceled"
    | "blocked"
    | "detached"
    | "redirect";
  status: number;
  error: string;
  afterMs: number;
}
interface PageState {
  target: string;
  webdriver: boolean | "unknown";
  visibility: string;
  focused: boolean | "unknown";
  storage: boolean | "unknown";
  siteData: boolean | "unknown";
  ready: string;
  checkboxes: number;
  visibleCheckboxes: number;
  password: boolean;
  captcha: boolean;
  afterMs: number;
}
export interface BrowserDiagnosticDetail {
  traces: RequestTrace[];
  pages: PageState[];
  pendingRequests: number;
  documents: number;
  commits: number;
  contextResets: number;
  idleMs: number;
  omitted: number;
  probeErrors: number;
  engine: string;
  lastCdpCommand: string;
  lastCdpTarget: TargetKind;
  turnstileCode: string;
  ray: string;
}

const targetKind = (value: string): TargetKind =>
  ["page", "iframe", "worker", "shared_worker", "service_worker"].includes(value)
    ? (value as TargetKind)
    : "unknown";
const resourceType = (value: unknown) =>
  typeof value === "string" &&
  ["Document", "Script", "XHR", "Fetch", "Image", "Media", "Font", "Stylesheet", "Other"].includes(
    value,
  )
    ? value
    : "Other";
const networkCode = (value: unknown) =>
  typeof value === "string" && /^(?:net::)?ERR_[A-Z0-9_]{1,80}$/.test(value)
    ? value.replace(/^net::/, "")
    : "NETWORK_FAILED";
const statusCode = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;

// 只返回固定状态、布尔值和计数，不读取正文、输入值或会话数据。
const pageProbe = `(()=>{ /* JAVM_DIAGNOSTIC */
  let storage=false;try{storage=typeof localStorage.length==='number'}catch{}
  const boxes=[...document.querySelectorAll('input[type="checkbox"]')].slice(0,8);
  return {webdriver:navigator.webdriver,visibility:document.visibilityState,focused:document.hasFocus(),
    storage,siteData:navigator.cookieEnabled,ready:document.readyState,checkboxes:boxes.length,
    visibleCheckboxes:boxes.filter(e=>{const s=getComputedStyle(e);return e.getClientRects().length>0&&s.visibility!=='hidden'&&s.display!=='none'}).length,
    password:!!document.querySelector('input[type="password"]'),captcha:!!document.querySelector('input[name="captcha"],.g-recaptcha')};
})()`;

/** 有界诊断旁路；不改变请求、验证或退出行为，任何采样失败都不能中断业务。 */
export class BrowserDiagnostics {
  private started: number;
  private lastActivity = 0;
  private nextSample = 0;
  private stopped = false;
  private serial = 0;
  private targetSerial = 0;
  private targets = new Map<string, { kind: TargetKind; label: string }>();
  private sampling = new Set<string>();
  private pending = new Map<string, RequestTrace>();
  private completed: RequestTrace[] = [];
  private pages = new Map<string, PageState>();
  private info = {
    documents: 0,
    commits: 0,
    contextResets: 0,
    omitted: 0,
    probeErrors: 0,
    engine: "unknown",
    lastCdpCommand: "",
    lastCdpTarget: "unknown" as TargetKind,
    turnstileCode: "",
    ray: "",
  };
  constructor(
    private origin: string,
    private now: () => number = () => performance.now(),
  ) {
    this.started = now();
  }
  private elapsed() {
    return Math.max(0, Math.round(this.now() - this.started));
  }
  target(id: string, kind: string) {
    if (this.stopped || this.targets.has(id) || this.targets.size >= 8) return;
    const safe = targetKind(kind);
    this.targets.set(id, { kind: safe, label: `${safe}-${++this.targetSerial}` });
  }
  commandFailed(method: string, id?: string) {
    if (this.stopped) return;
    this.info.lastCdpCommand = /^[A-Za-z]+\.[A-Za-z]{1,60}$/.test(method) ? method : "unknown";
    this.info.lastCdpTarget = this.targets.get(id ?? "")?.kind ?? "unknown";
  }
  engine(value: unknown) {
    if (this.stopped || typeof value !== "string") return;
    this.info.engine = /^(?:Edg|Chrome|Chromium)\/\d{1,4}(?:\.\d{1,6}){0,3}$/.test(value)
      ? value
      : "unknown";
  }
  private category(raw: unknown, type: string) {
    if (typeof raw !== "string" || raw.length > 8192) return "unknown";
    try {
      const url = new URL(raw);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "unknown";
      const own = url.origin === this.origin;
      const challenge =
        url.hostname === "challenges.cloudflare.com" ||
        (own && url.pathname.startsWith("/cdn-cgi/"));
      if (challenge) {
        if (/^\/cdn-cgi\/challenge-platform\/(?:[\w-]+\/)*pat\/[^/]+/.test(url.pathname))
          return "challenge_pat";
        if (url.pathname.includes("/flow/")) return "challenge_flow";
        if (type === "Document") return "challenge_frame";
        if (type === "Script") return "challenge_script";
        return "challenge_other";
      }
      if (
        url.hostname.endsWith(".challenges.cloudflare.com") ||
        url.hostname === "dnstest.dev" ||
        url.hostname.endsWith(".dnstest.dev")
      )
        return "challenge_probe";
      if (
        ["Image", "Media", "Font"].includes(type) ||
        /\.(?:ico|png|jpe?g|webp|gif|svg|avif)$/i.test(url.pathname)
      )
        return "media";
      if (own) return type === "Document" ? "source_document" : "source_resource";
      return "other";
    } catch {
      return "unknown";
    }
  }
  private keep(record: RequestTrace) {
    this.completed.push({ ...record });
    if (this.completed.length > 24) {
      this.completed.shift();
      this.info.omitted++;
    }
  }
  event({ method, params, sessionId }: CdpEvent) {
    if (this.stopped) return;
    if (method === "Target.detachedFromTarget") {
      const id = String(params.sessionId);
      for (const [key, record] of this.pending)
        if (key.startsWith(`${id}:`)) {
          this.keep({ ...record, event: "detached", afterMs: this.elapsed() });
          this.pending.delete(key);
        }
      this.targets.delete(id);
      return;
    }
    if (!sessionId || !this.targets.has(sessionId)) return;
    const target = this.targets.get(sessionId)!;
    if (method === "Page.frameNavigated") this.info.commits++;
    if (method === "Runtime.executionContextsCleared") this.info.contextResets++;
    if (method === "Runtime.consoleAPICalled" && ["page", "iframe"].includes(target.kind)) {
      const args = Array.isArray(params.args) ? params.args.slice(0, 4) : [];
      for (const arg of args) {
        const value: unknown = arg?.value;
        if (typeof value !== "string" || value.length > 128) continue;
        const code = /^\[Cloudflare Turnstile\] Error: ([1-6]\d{5})\.?$/.exec(value);
        if (code) this.info.turnstileCode = code[1]!;
      }
    }
    if (!method.startsWith("Network.")) return;
    const key = `${sessionId}:${String(params.requestId)}`;
    if (method === "Network.requestWillBeSent") {
      this.lastActivity = this.elapsed();
      if (params.redirectResponse && this.pending.has(key)) {
        const old = this.pending.get(key)!;
        this.keep({
          ...old,
          event: "redirect",
          status: statusCode((params.redirectResponse as { status?: unknown }).status),
          afterMs: this.elapsed(),
        });
        this.pending.delete(key);
      }
      if (this.pending.size >= 128 || this.serial >= 128) {
        this.info.omitted++;
        return;
      }
      const type = resourceType(params.type);
      if (type === "Document") this.info.documents++;
      this.pending.set(key, {
        id: ++this.serial,
        target: target.kind,
        kind: this.category((params.request as { url?: unknown })?.url, type),
        type,
        event: "pending",
        status: 0,
        error: "",
        afterMs: this.elapsed(),
      });
    }
    const record = this.pending.get(key);
    if (!record) return;
    if (method === "Network.responseReceived") {
      this.lastActivity = this.elapsed();
      const response = params.response as { status?: unknown; headers?: Record<string, unknown> };
      record.status = statusCode(response?.status);
      record.event = "response";
      record.afterMs = this.elapsed();
      if (record.type === "Document")
        for (const [name, value] of Object.entries(response?.headers ?? {})) {
          if (
            name.toLowerCase() === "cf-ray" &&
            typeof value === "string" &&
            /^[a-f0-9]{16}-[A-Z]{3}$/i.test(value)
          )
            this.info.ray = value;
        }
    }
    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      this.lastActivity = this.elapsed();
      record.afterMs = this.elapsed();
      record.event =
        method === "Network.loadingFinished"
          ? "finished"
          : params.blockedReason === "inspector" ||
              params.errorText === "net::ERR_BLOCKED_BY_CLIENT"
            ? "blocked"
            : params.canceled === true || params.errorText === "net::ERR_ABORTED"
              ? "canceled"
              : "failed";
      if (method === "Network.loadingFailed")
        record.error =
          record.event === "blocked" ? "ERR_BLOCKED_BY_CLIENT" : networkCode(params.errorText);
      this.keep(record);
      this.pending.delete(key);
    }
  }
  sample(cdp: Pick<CdpConnection, "send">, signal: AbortSignal) {
    if (this.stopped || signal.aborted || this.elapsed() < this.nextSample) return;
    this.nextSample = this.elapsed() + 1000;
    for (const [id, target] of this.targets) {
      if (!["page", "iframe"].includes(target.kind) || this.sampling.has(id)) continue;
      this.sampling.add(id);
      void cdp
        .send(
          "Runtime.evaluate",
          { expression: pageProbe, returnByValue: true, silent: true, timeout: 250 },
          id,
        )
        .then((result) => {
          if (this.stopped || signal.aborted || !this.targets.has(id)) return;
          const value = (result.result as { value?: Record<string, unknown> } | undefined)?.value;
          if (!value || typeof value !== "object") {
            this.info.probeErrors++;
            return;
          }
          const bool = (name: string) =>
            typeof value[name] === "boolean" ? (value[name] as boolean) : "unknown";
          const count = (name: string) =>
            typeof value[name] === "number" && Number.isInteger(value[name])
              ? Math.max(0, Math.min(8, value[name] as number))
              : 0;
          if (!this.pages.has(id) && this.pages.size >= 8)
            this.pages.delete(this.pages.keys().next().value!);
          this.pages.set(id, {
            target: target.label,
            webdriver: bool("webdriver"),
            visibility: ["visible", "hidden"].includes(String(value.visibility))
              ? String(value.visibility)
              : "unknown",
            focused: bool("focused"),
            storage: bool("storage"),
            siteData: bool("siteData"),
            ready: ["loading", "interactive", "complete"].includes(String(value.ready))
              ? String(value.ready)
              : "unknown",
            checkboxes: count("checkboxes"),
            visibleCheckboxes: count("visibleCheckboxes"),
            password: value.password === true,
            captcha: value.captcha === true,
            afterMs: this.elapsed(),
          });
        })
        .catch(() => {
          if (!this.stopped && !signal.aborted) this.info.probeErrors++;
        })
        .finally(() => this.sampling.delete(id));
    }
  }
  finish(): BrowserDiagnosticDetail {
    this.stopped = true;
    const traces = [...this.completed, ...this.pending.values()].sort((a, b) => a.id - b.id);
    return {
      ...this.info,
      traces: traces.slice(-24).map((r) => ({ ...r })),
      pages: [...this.pages.values()],
      pendingRequests: this.pending.size,
      idleMs: Math.max(0, this.elapsed() - this.lastActivity),
      omitted: this.info.omitted + Math.max(0, traces.length - 24),
    };
  }
}
