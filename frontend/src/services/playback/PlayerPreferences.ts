import type { WindowDisplay } from "../../contracts/window";
import type { PlaybackStore } from "./PlaybackSettingsService";

export interface PlayerPosition {
  x: number;
  y: number;
}
export interface PlayerPreferencesValue {
  volume: number;
  position?: PlayerPosition;
}
export interface PlayerPreferencesPort {
  read(): Promise<PlayerPreferencesValue>;
  update(patch: Partial<PlayerPreferencesValue>): Promise<PlayerPreferencesValue>;
}

export function playerPosition(value: unknown): PlayerPosition {
  const position = value as Partial<PlayerPosition> | null;
  if (
    !position ||
    !Number.isSafeInteger(position.x) ||
    !Number.isSafeInteger(position.y) ||
    Math.abs(position.x!) > 1_000_000 ||
    Math.abs(position.y!) > 1_000_000
  )
    throw new Error("播放器窗口位置格式无效，原设置已保留。");
  return { x: position.x!, y: position.y! };
}

function validate(value: unknown): PlayerPreferencesValue {
  const input = value as Partial<PlayerPreferencesValue> | null;
  if (
    !input ||
    typeof input.volume !== "number" ||
    !Number.isFinite(input.volume) ||
    input.volume < 0 ||
    input.volume > 1
  )
    throw new Error("播放器音量格式无效，原设置已保留。");
  return {
    volume: input.volume,
    ...(input.position !== undefined ? { position: playerPosition(input.position) } : {}),
  };
}

/** 主窗口和子窗口各保留一个在途请求、一个合并后的待保存修改。 */
export class PlayerPreferences implements PlayerPreferencesPort {
  private pending?: Partial<PlayerPreferencesValue>;
  private saving?: Promise<PlayerPreferencesValue>;
  constructor(private port: PlayerPreferencesPort) {}

  async read() {
    await this.flush();
    return this.port.read();
  }

  update(patch: Partial<PlayerPreferencesValue>): Promise<PlayerPreferencesValue> {
    if (!patch || typeof patch !== "object")
      return Promise.reject(new Error("播放器设置格式无效。"));
    const value = validate({ volume: 1, ...patch });
    this.pending = {
      ...this.pending,
      ...(patch.volume !== undefined ? { volume: value.volume } : {}),
      ...(patch.position !== undefined ? { position: value.position } : {}),
    };
    return (this.saving ??= (async () => {
      try {
        let result!: PlayerPreferencesValue;
        while (this.pending) {
          const next = this.pending;
          this.pending = undefined;
          result = await this.port.update(next);
        }
        return result;
      } catch (error) {
        this.pending = undefined;
        throw error;
      } finally {
        this.saving = undefined;
      }
    })());
  }

  async flush() {
    await this.saving;
  }
}

/** 只有主窗口写官方存储；补丁基于最新提交值合并，不覆盖其他窗口的字段。 */
export function storedPlayerPreferences(store: PlaybackStore<PlayerPreferencesValue>) {
  let current: PlayerPreferencesValue;
  let initialized: Promise<void> | undefined;
  const read = async () => {
    await (initialized ??= (async () => {
      const raw = await store.read();
      current = raw === null ? { volume: 1 } : validate(raw);
    })().catch((error: unknown) => {
      initialized = undefined;
      throw error;
    }));
    return current;
  };
  return new PlayerPreferences({
    read,
    async update(patch) {
      const value = validate({ ...(await read()), ...patch });
      await store.write(value);
      current = value;
      return value;
    },
  });
}

/** 与原生窗口相同的物理坐标；副屏可使用负坐标，离屏记录恢复到主屏。 */
export function fitPlayerPosition(position: PlayerPosition, displays: WindowDisplay[]) {
  const screens = displays.filter(
    ({ workArea }) =>
      Object.values(workArea).every(Number.isFinite) && workArea.width > 0 && workArea.height > 0,
  );
  let selected: WindowDisplay | undefined;
  let area = 0;
  for (const display of screens) {
    const rect = display.workArea;
    const overlap =
      Math.max(0, Math.min(position.x + 960, rect.x + rect.width) - Math.max(position.x, rect.x)) *
      Math.max(0, Math.min(position.y + 600, rect.y + rect.height) - Math.max(position.y, rect.y));
    if (overlap > area) {
      area = overlap;
      selected = display;
    }
  }
  const screen = selected ?? screens.find((display) => display.primary) ?? screens[0];
  if (!screen) throw new Error("无法读取显示器范围，播放器将使用默认位置。");
  const rect = screen.workArea;
  const x = selected ? position.x : rect.x + (rect.width - 960) / 2;
  const y = selected ? position.y : rect.y + (rect.height - 600) / 2;
  return {
    x: Math.round(Math.max(rect.x, Math.min(x, rect.x + Math.max(0, rect.width - 960)))),
    y: Math.round(Math.max(rect.y, Math.min(y, rect.y + Math.max(0, rect.height - 600)))),
  };
}
