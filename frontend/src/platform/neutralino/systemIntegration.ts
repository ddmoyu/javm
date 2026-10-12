import { filesystem, os } from "@neutralinojs/lib";
import type { Runtime } from "./bootstrap";
import { encodedPowerShell } from "./process";
import { Observable, serviceError } from "../../services/metadata/shared";
import { protocolScript } from "../../services/settings/systemProtocol";
import type { ProtocolOperation, ProtocolState } from "../../services/settings/systemProtocol";

class SystemIntegrationService extends Observable<{
  available: boolean;
  busy: boolean;
  error: string;
  result?: ProtocolState;
}> {
  constructor(private runtime: Runtime) {
    super({ available: runtime === "desktop", busy: false, error: "" });
  }
  async run(operation: ProtocolOperation, expected = "") {
    if (this.snapshot.busy || this.runtime !== "desktop") return;
    this.publish({ busy: true, error: "" });
    try {
      const entry = `${window.NL_PATH}/JAVM.exe`;
      if (!(await filesystem.getStats(entry).catch(() => null))?.isFile)
        throw new Error("请在完整便携版中设置链接关联。");
      const reply = await os.execCommand(
        encodedPowerShell(protocolScript(entry, operation, expected)),
      );
      const result = JSON.parse(reply.stdOut.trim()) as ProtocolState & { error?: string };
      if (reply.exitCode || result.error) throw new Error(result.error || "链接设置失败，请重试。");
      this.publish({ result });
    } catch (error) {
      this.publish({ error: serviceError(error) });
    } finally {
      this.publish({ busy: false });
    }
  }
}
let service: SystemIntegrationService | undefined;
export function systemIntegration(runtime: Runtime) {
  return (service ??= new SystemIntegrationService(runtime));
}
