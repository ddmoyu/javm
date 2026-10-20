import { describe, expect, it, vi } from "vite-plus/test";
import {
  LibraryDocumentsService,
  parseStrm,
} from "../frontend/src/services/library/LibraryDocumentsService";
import type { DocumentFiles } from "../frontend/src/services/library/LibraryDocumentsService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";

describe("资料文件任务（安全 mock）", () => {
  it("STRM 只接受有界单行 HTTP 地址，拒绝命令、凭据与多行", () => {
    expect(parseStrm("\uFEFFhttps://safe.example.invalid/a.m3u8\r\n")).toBe(
      "https://safe.example.invalid/a.m3u8",
    );
    for (const input of [
      "file:///C:/private",
      "javascript:alert(1)",
      "https://user:key@safe.example.invalid/a",
      "https://safe.example.invalid/a\nhttps://safe.example.invalid/b",
      "a".repeat(8193),
    ])
      expect(() => parseStrm(input)).toThrow();
  });
  it("分页导出遇到单项写入失败仍继续，导出路径不会穿越目标目录", async () => {
    const files: DocumentFiles = {
      createDirectory: async () => {},
      readStream: async () => "",
      writeNew: vi.fn(async (path) => {
        if (path.includes("_bad_")) throw new Error("已存在，保留原文件");
      }),
    };
    const request: LibraryPort["request"] = async <T>(method: string, params?: unknown) => {
      const input = params as { id: string };
      return (
        method === "library.documents.list"
          ? [{ id: "../bad/" }, { id: "safe" }]
          : { id: input.id, code: "SAFE-001", content: "<movie/>" }
      ) as T;
    };
    const service = new LibraryDocumentsService({ request }, files, async () => {});
    try {
      await service.exportNfo("C:/fixture/export");
      expect(service.getSnapshot()).toMatchObject({
        processed: 2,
        succeeded: 1,
        failed: 1,
        running: false,
      });
      expect(
        vi
          .mocked(files.writeNew)
          .mock.calls.every(
            ([path]) => path.startsWith("C:/fixture/export/JAVM-export-") && !path.includes(".."),
          ),
      ).toBe(true);
    } finally {
      await service.shutdown();
    }
  });
  it("取消阻止迟到的资料响应继续写入", async () => {
    let finish: (data: unknown) => void = () => {};
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ) as unknown as LibraryPort["request"];
    const files: DocumentFiles = {
      createDirectory: async () => {},
      readStream: async () => "",
      writeNew: vi.fn(async () => {}),
    };
    const service = new LibraryDocumentsService({ request }, files, async () => {});
    try {
      const pending = service.exportNfo("C:/fixture", "safe");
      await vi.waitFor(() => expect(request).toHaveBeenCalled());
      service.cancel();
      finish({ id: "safe", code: "SAFE-001", content: "<movie/>" });
      await pending;
      expect(files.writeNew).not.toHaveBeenCalled();
      expect(service.getSnapshot().succeeded).toBe(0);
    } finally {
      await service.shutdown();
    }
  });
});
