import { os } from "@neutralinojs/lib";

export function openExternalLink(url: string) {
  return os.open(url);
}
