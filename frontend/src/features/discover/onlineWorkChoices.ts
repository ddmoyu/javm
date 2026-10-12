import type { AvwikiEntity } from "../../services/catalog/avwikiWorks";
import type { WorksDimension } from "../../services/catalog/javbusWorks";

function genreLane(entity: AvwikiEntity) {
  try {
    const url = new URL(entity.url);
    if (url.origin !== "https://www.javbus.com") return;
    const match = /^\/(uncensored\/)?genre\/[a-z0-9_-]{1,100}\/?$/i.exec(url.pathname);
    if (match) return match[1] ? "无码" : "有码";
  } catch {
    // 未识别的链接沿用普通同名选择，不猜测分区。
  }
}

export function onlineWorkChoices(dimension: WorksDimension, entities: AvwikiEntity[]) {
  const lanes = dimension === "genres" ? entities.map(genreLane) : [];
  const partitioned = lanes.length > 0 && lanes.every((lane) => lane !== undefined);
  const positions = new Map<string, number>();
  return {
    label: partitioned ? "选择分类分区" : "选择同名条目",
    description: partitioned
      ? "同名分类对应不同分区或链接，各条目的作品分别分页显示。"
      : "找到多个同名条目，选择后查看各自作品。",
    placeholder: partitioned ? "请选择分区或条目" : "请选择条目",
    data: entities.map((entity, index) => {
      let label = `${entity.name} · 条目 ${index + 1}`;
      if (partitioned) {
        const lane = lanes[index]!;
        const position = (positions.get(lane) ?? 0) + 1;
        positions.set(lane, position);
        label =
          lanes.filter((value) => value === lane).length > 1 ? `${lane} · 条目 ${position}` : lane;
      }
      return { value: entity.id, label };
    }),
  };
}
