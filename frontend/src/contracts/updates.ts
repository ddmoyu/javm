export type UpdateChannel = "stable" | "beta";
export type UpdatePlatform = "windows-x64" | "macos-x64" | "macos-arm64" | "linux-x64";
export type UpdateKind = "portable" | "setup" | "app" | "appimage" | "deb";
export type UpdatePhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "ready"
  | "waiting"
  | "backing-up"
  | "installing"
  | "trial"
  | "committed"
  | "rolling-back"
  | "rolled-back"
  | "failed"
  | "cancelled";
export interface UpdateAsset {
  platform: UpdatePlatform;
  kind: UpdateKind;
  name: string;
  bytes: number;
  sha256: string;
}
export interface UpdateManifest {
  schema: 1;
  app: "net.ddmoyu.javm";
  version: string;
  channel: UpdateChannel;
  minimumUpdater: 1;
  assets: UpdateAsset[];
}
/** 对 payload 的原始 UTF-8 字节签名，禁止重新序列化后验签。 */
export interface SignedUpdateManifest {
  payload: string;
  signature: string;
}
export interface UpdateCandidate {
  version: string;
  url: string;
  notes: string;
  envelope: SignedUpdateManifest;
  asset: UpdateAsset;
}
export interface NativeUpdateStatus {
  phase: UpdatePhase;
  version?: string;
  bytes?: number;
  total?: number;
  error?: string;
  transaction?: string;
  source?: string;
}
export interface UpdateInstallation {
  available: boolean;
  reason?: string;
  kind?: UpdateKind;
  phase?: UpdatePhase;
  failedVersion?: string;
}
