import { maintenancePageSize } from "../../contracts/maintenance";
import type {
  MaintenanceCommand,
  MaintenancePage,
  MaintenanceRow,
  MaintenanceVideo,
  MaintenanceMode,
  AdRules,
} from "../../contracts/maintenance";
import {
  adRows,
  duplicateRows,
  healthRows,
  retainedCopies,
  retentionKey,
  usableCopy,
} from "./maintenanceRules";

let videos: MaintenanceVideo[] = [],
  rows: MaintenanceRow[] = [];
let mode: MaintenanceMode = "duplicates",
  rules: AdRules,
  page = 1,
  unhashed = 0;
const selected = new Set<string>();
function snapshot(): MaintenancePage {
  page = Math.min(Math.max(1, page), Math.max(1, Math.ceil(rows.length / maintenancePageSize)));
  const retained = mode === "duplicates" ? retainedCopies(rows, selected) : null;
  return {
    rows: rows
      .slice((page - 1) * maintenancePageSize, page * maintenancePageSize)
      .map((row) => ({ ...row, selected: selected.has(row.id) })),
    total: rows.length,
    groups: mode === "duplicates" ? new Set(rows.map((row) => row.groupId)).size : 0,
    selected: selected.size,
    suggested: rows.reduce((count, row) => count + Number(row.suggested), 0),
    suggestedBytes: rows.reduce(
      (bytes, row) => bytes + (row.suggested && !row.missing ? Math.max(0, row.size ?? 0) : 0),
      0,
    ),
    selectedBytes: rows.reduce(
      (bytes, row) =>
        bytes + (selected.has(row.id) && !row.missing ? Math.max(0, row.size ?? 0) : 0),
      0,
    ),
    review: rows.reduce((count, row) => count + Number(!!row.review), 0),
    unprotected: retained
      ? rows.filter(
          (row) => selected.has(row.id) && usableCopy(row) && !retained.has(retentionKey(row)),
        ).length
      : 0,
    unhashed,
    page,
  };
}
self.onmessage = (event: MessageEvent<{ id: number; command: MaintenanceCommand }>) => {
  const { id, command } = event.data;
  try {
    let result: unknown;
    switch (command.type) {
      case "reset":
        videos = [];
        rows = [];
        selected.clear();
        page = 1;
        unhashed = 0;
        mode = command.mode;
        rules = command.rules;
        break;
      case "append":
        for (const video of command.rows) videos.push(video);
        break;
      case "finish":
        unhashed = videos.reduce((count, video) => count + Number(!video.hash), 0);
        rows =
          mode === "duplicates"
            ? duplicateRows(videos)
            : mode === "ads"
              ? adRows(videos, rules)
              : healthRows(videos, mode === "all");
        videos = [];
        result = snapshot();
        break;
      case "page":
        page = command.page;
        result = snapshot();
        break;
      case "select":
        if (command.choice !== "toggle") selected.clear();
        if (command.choice === "toggle")
          for (const value of command.ids ?? []) {
            if (selected.has(value)) selected.delete(value);
            else if (rows.some((row) => row.id === value)) selected.add(value);
          }
        else if (command.choice !== "none")
          for (const row of rows)
            if (command.choice === "all" || row.suggested) selected.add(row.id);
        result = snapshot();
        break;
      case "selected": {
        const retained = mode === "duplicates" ? retainedCopies(rows, selected) : null;
        result = rows
          .filter((row) => selected.has(row.id))
          .slice(command.after, command.after + 30)
          .map((row) => ({
            id: row.id,
            path: row.path,
            retained: retained?.get(retentionKey(row)),
          }));
        break;
      }
      case "removed": {
        const ids = new Set(command.ids);
        rows = rows.filter((row) => !ids.has(row.id));
        for (const value of ids) selected.delete(value);
        result = snapshot();
        break;
      }
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "检查失败" });
  }
};
