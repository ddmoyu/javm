import type { PlaybackRequest } from "./source";
import type { PlaybackSnapshot } from "./PlaybackService";
import type { LogInput } from "../logging/events";

export type PlayerCommand =
  | { action: "play"; request: PlaybackRequest }
  | { action: "focus" }
  | { action: "close" };

export type PlayerWindowMessage =
  | { type: "log"; input: LogInput }
  | { type: "ready" | "closed" | "ping" | "pong" }
  | { type: "state"; snapshot: Omit<PlaybackSnapshot, "media"> }
  | { type: "command"; id: string; command: PlayerCommand }
  | { type: "result"; id: string; error?: string };

export const playerChannelName = (id: string) => `javm:player:${id}`;

export function playerWindowId(search = location.search) {
  const id = new URLSearchParams(search).get("javmPlayer");
  return id && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id) ? id : undefined;
}
