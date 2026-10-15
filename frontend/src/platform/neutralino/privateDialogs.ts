import { os } from "@neutralinojs/lib";
import { createPrivacyService } from "./privacy";
import { privacyNative } from "./privacyNative";
import { assertPlaybackAllowed, privacyRevision } from "../../services/privacy/session";

export async function showOpenDialog(
  title: string,
  options: Parameters<typeof os.showOpenDialog>[1] = {},
) {
  assertPlaybackAllowed();
  const revision = privacyRevision();
  const result =
    window.NL_OS === "Windows"
      ? await privacyNative.request<string[]>("privacy.pick", {
          title,
          ...options,
          folder: false,
          protectRecentFiles:
            createPrivacyService("desktop").getSnapshot().settings.protectRecentFiles,
        })
      : await os.showOpenDialog(title, options);
  assertPlaybackAllowed(revision);
  return result;
}
export async function showFolderDialog(
  title: string,
  options: Parameters<typeof os.showFolderDialog>[1] = {},
) {
  assertPlaybackAllowed();
  const revision = privacyRevision();
  const result =
    window.NL_OS === "Windows"
      ? ((
          await privacyNative.request<string[]>("privacy.pick", {
            title,
            ...options,
            folder: true,
            protectRecentFiles:
              createPrivacyService("desktop").getSnapshot().settings.protectRecentFiles,
          })
        )[0] ?? "")
      : await os.showFolderDialog(title, options);
  assertPlaybackAllowed(revision);
  return result;
}
