export const gfriendsIndexSources = [
  "https://cdn.jsdelivr.net/gh/xinxin8816/gfriends/Filetree.json",
  "https://raw.githubusercontent.com/gfriends/gfriends/master/Filetree.json",
] as const;
export const gfriendsImageBases = [
  "https://cdn.jsdelivr.net/gh/xinxin8816/gfriends/Content/",
  "https://raw.githubusercontent.com/gfriends/gfriends/master/Content/",
] as const;
export function validPortraitUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.href !== value) return false;
    if (url.origin === "https://pics.dmm.co.jp")
      return !url.search && /^\/mono\/actjpgs\/[a-z0-9_-]+\.jpg$/i.test(url.pathname);
    return (
      gfriendsImageBases.some((base) => value.startsWith(base)) &&
      (!url.search || /^\?t=\d+(?:\.\d+)?$/.test(url.search)) &&
      url.pathname.endsWith(".jpg") &&
      !decodeURIComponent(url.pathname)
        .split("/")
        .slice(1)
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.includes("\\") ||
            hasControlCharacters(part),
        )
    );
  } catch {
    return false;
  }
}
import { hasControlCharacters } from "./avwikiCsv";
