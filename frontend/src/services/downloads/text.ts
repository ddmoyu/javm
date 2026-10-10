// JavaScript strings use UTF-16; a bounded tail must not start with half an emoji.
export function keepTextTail(text: string, limit: number) {
  let start = Math.max(0, text.length - limit);
  const first = text.charCodeAt(start);
  const previous = text.charCodeAt(start - 1);
  if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start++;
  return text.slice(start);
}
