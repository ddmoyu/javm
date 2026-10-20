export type LaunchAction =
  | { kind: "activate" }
  | { kind: "search"; code: string }
  | { kind: "work"; id: string }
  | { kind: "download"; url: string; name: string };
export function parseLaunchArguments(args: string[]): LaunchAction[] {
  if (args.length > 32 || args.join("").length > 16384) throw new Error("启动参数过长");
  const links = args.filter((arg) => /^javm:/i.test(arg));
  if (!links.length) return [{ kind: "activate" }];
  return links.map((link) => {
    const url = new URL(link);
    if (
      url.protocol !== "javm:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      (url.pathname && url.pathname !== "/")
    )
      throw new Error("JAVM 链接格式无效");
    const required = (key: string) => {
      const value = url.searchParams.get(key);
      if (!value || /[\0-\x1f]/.test(value)) throw new Error("JAVM 链接缺少有效参数");
      return value;
    };
    if (url.hostname === "search") {
      const code = required("code");
      if (!/^[a-z0-9][a-z0-9 _-]{1,79}$/i.test(code)) throw new Error("链接中的番号无效");
      return { kind: "search", code };
    }
    if (url.hostname === "work") {
      const id = required("id");
      if (!/^[\w-]{1,100}$/.test(id)) throw new Error("链接中的作品标识无效");
      return { kind: "work", id };
    }
    if (url.hostname === "download") {
      const source = new URL(required("url"));
      if (
        !/^https?:$/.test(source.protocol) ||
        source.username ||
        source.password ||
        source.href.length > 8192
      )
        throw new Error("下载链接无效");
      return {
        kind: "download",
        url: source.href,
        name: (url.searchParams.get("name") ?? "").slice(0, 120),
      };
    }
    throw new Error("不支持的 JAVM 链接操作");
  });
}
