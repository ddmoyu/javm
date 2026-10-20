import { clipboard } from "@neutralinojs/lib";

export function copyText(value: string): Promise<void> {
  return "NL_PORT" in window ? clipboard.writeText(value) : navigator.clipboard.writeText(value);
}
