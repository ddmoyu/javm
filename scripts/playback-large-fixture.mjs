import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";

// 仅用于合成测试：将真实音视频数据移到 4 GiB 之后，co64 指向真实数据。
// 中间 free box 使用 NTFS 稀疏区，避免写入 4 GiB 零字节。
export async function createLargePlaybackFixture(source, target) {
  const input = await fs.readFile(source);
  const atoms = (buffer) => {
    const values = [];
    for (let pos = 0; pos < buffer.length;) {
      const size = buffer.readUInt32BE(pos);
      if (size < 8 || pos + size > buffer.length) throw new Error("合成 MP4 atom 无效");
      values.push({
        type: buffer.toString("ascii", pos + 4, pos + 8),
        pos,
        data: buffer.subarray(pos, pos + size),
      });
      pos += size;
    }
    return values;
  };
  const boxes = atoms(input);
  const ftyp = boxes.find((atom) => atom.type === "ftyp").data;
  const originalMoov = boxes.find((atom) => atom.type === "moov").data;
  const mdat = boxes.find((atom) => atom.type === "mdat");
  const dataOffset = 2 ** 32 + 4096;
  const delta = BigInt(dataOffset - mdat.pos);
  const containerTypes = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
  const convert = (buffer) =>
    Buffer.concat(
      atoms(buffer).map((atom) => {
        if (atom.type === "stco") {
          const count = atom.data.readUInt32BE(12);
          const replacement = Buffer.alloc(16 + count * 8);
          replacement.writeUInt32BE(replacement.length);
          replacement.write("co64", 4);
          atom.data.copy(replacement, 8, 8, 16);
          for (let i = 0; i < count; i++)
            replacement.writeBigUInt64BE(
              BigInt(atom.data.readUInt32BE(16 + i * 4)) + delta,
              16 + i * 8,
            );
          return replacement;
        }
        if (!containerTypes.has(atom.type)) return atom.data;
        const body = convert(atom.data.subarray(8));
        const header = Buffer.from(atom.data.subarray(0, 8));
        header.writeUInt32BE(body.length + 8);
        return Buffer.concat([header, body]);
      }),
    );
  const moov = convert(originalMoov);
  const handle = await fs.open(target, "wx");
  try {
    execFileSync("fsutil.exe", ["sparse", "setflag", target], { windowsHide: true, stdio: "pipe" });
    await handle.write(ftyp, 0, ftyp.length, 0);
    await handle.write(moov, 0, moov.length, ftyp.length);
    const padding = Buffer.alloc(8);
    padding.writeUInt32BE(dataOffset - ftyp.length - moov.length);
    padding.write("free", 4);
    await handle.write(padding, 0, 8, ftyp.length + moov.length);
    await handle.write(mdat.data, 0, mdat.data.length, dataOffset);
  } finally {
    await handle.close();
  }
}
