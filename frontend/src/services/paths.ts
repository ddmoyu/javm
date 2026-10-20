// 业务层传递绝对路径；只有盘符 / UNC 路径采用 Windows 分隔符和大小写规则。
// POSIX 路径中的反斜杠是文件名的一部分，不能全局替换。
export function windowsPath(value: string) {
  return /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}
export function normalizedPath(value: string) {
  const path = windowsPath(value) ? value.replaceAll("\\", "/") : value;
  if (/^[a-z]:\/$/i.test(path)) return path;
  return path.replace(/\/+$/, "") || (path.startsWith("/") ? "/" : "");
}
export function pathComparisonKey(value: string) {
  const path = normalizedPath(value);
  return windowsPath(value) ? path.toLowerCase() : path;
}
export function pathRelativeTo(value: string, directory: string) {
  const path = normalizedPath(value),
    root = normalizedPath(directory);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const matches = windowsPath(directory)
    ? path.toLowerCase().startsWith(prefix.toLowerCase())
    : path.startsWith(prefix);
  if (!root || !matches) return undefined;
  const relative = path.slice(prefix.length);
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === ".."))
    return undefined;
  return relative;
}
