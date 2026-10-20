import { createHash } from "node:crypto";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
