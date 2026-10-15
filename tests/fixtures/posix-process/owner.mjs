import { spawn } from "node:child_process";

const [supervisor, payload] = process.argv.slice(2);
const child = spawn(supervisor, ["--owner", String(process.pid), "--payload", payload], {
  stdio: ["pipe", "ignore", "ignore"],
});
child.on("error", () => process.exit(1));
// IPC 仅属于 Node 测试夹具，应用不使用它。
process.send({ pid: child.pid });
setTimeout(() => process.exit(0), 15000);
