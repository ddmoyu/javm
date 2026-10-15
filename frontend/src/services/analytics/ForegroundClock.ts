import { localStatDate } from "./contract";

/** 只统计主窗口可见时间。单调时钟防止调钟，长时间停顿按休眠处理。 */
export class ForegroundClock {
  private previous?: { wall: number; monotonic: number; visible: boolean };
  private fraction = 0;
  private fractionDate = "";
  constructor(
    private now: () => Date,
    private monotonic: () => number,
    private visible: () => boolean,
    private add: (date: string, seconds: number) => void,
  ) {}
  sample() {
    const current = {
      wall: this.now().getTime(),
      monotonic: this.monotonic(),
      visible: this.visible(),
    };
    const previous = this.previous;
    this.previous = current;
    if (!previous?.visible) return;
    const elapsed = current.monotonic - previous.monotonic;
    const wallElapsed = current.wall - previous.wall;
    // 15 秒心跳；超过 30 秒或墙钟跳变不把休眠/挂起时间算成使用时长。
    if (
      elapsed <= 0 ||
      elapsed > 30_000 ||
      wallElapsed <= 0 ||
      Math.abs(elapsed - wallElapsed) > 2_000
    )
      return;
    let start = previous.wall;
    while (start < current.wall) {
      const date = new Date(start);
      const key = localStatDate(date);
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      const end = Math.min(current.wall, midnight);
      if (this.fractionDate !== key) {
        this.fractionDate = key;
        this.fraction = 0;
      }
      const milliseconds = ((end - start) * elapsed) / wallElapsed + this.fraction;
      const seconds = Math.floor(milliseconds / 1000);
      this.fraction = milliseconds - seconds * 1000;
      if (seconds) this.add(key, seconds);
      start = end;
    }
  }
}
