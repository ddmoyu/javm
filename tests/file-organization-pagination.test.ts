import { describe, it, expect } from "vite-plus/test";
import { FileOrganizationService } from "../frontend/src/services/library/FileOrganizationService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";

describe("离线路径恢复分页", () => {
  it("首批 500 个不匹配资源不会挡住后续可恢复资源", async () => {
    const first = Array.from({ length: 500 }, (_, index) => ({
      id: String(index).padStart(4, "0"),
      path: "old/" + index,
      target: "new/" + index,
      matched: false,
    }));
    const later = { id: "0500", path: "old/500", target: "new/500", matched: true };
    const linked: string[] = [];
    const request: LibraryPort["request"] = async <T>(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> => {
      if (method === "library.files.relinkPreview")
        return (params?.after === "0499" ? [later] : first) as T;
      if (method === "library.files.relink") linked.push(String(params?.id));
      return [] as T;
    };
    const service = new FileOrganizationService(
      { request },
      { read: async () => new ArrayBuffer(0), append: async () => {} },
      async () => {},
    );
    await service.preview("old", "new");
    expect(service.getSnapshot().nextCandidate).toBe("0499");
    await service.preview("old", "new", service.getSnapshot().nextCandidate);
    expect(service.getSnapshot().nextCandidate).toBe("");
    expect(service.getSnapshot().candidates).toEqual([later]);
    await service.relink(service.getSnapshot().candidates);
    expect(linked).toEqual(["0500"]);
    await service.shutdown();
  });
});
