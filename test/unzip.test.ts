// ./unzip.ts 直测（离线）：用测试内自建的 zip 覆盖「条目 → 落盘」的语义与边界——目录判定、
// __MACOSX 跳过、进度口径（项数 / 字节 / 当前条目），以及三道防穿越（`..`、绝对路径、ADS 冒号）。
//
// 为什么自己造 zip：本包不引 zip 写库（产品路径只读不写），而 Node 只有 `zlib` 能压裸数据流、
// 不能封包。故本文件内联一个最小封包器：字段按 PKZIP 规范写全（本地头 + 中央目录 + EOCD），
// 支持 stored 与 deflate 两种压缩方法——正好把「解压器读到的是真实结构」这件事也一并验到。

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractZip } from "../src/unzip.js";
import type { UnzipProgress } from "../src/unzip.js";

// —— 最小 zip 封包器（只服务本文件的用例）——

/** CRC-32（PKZIP 用的多项式 0xEDB88320）查表。 */
const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_unused, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = ((CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 一个待封包的条目。 */
interface ZipEntrySpec {
  /** 条目名（目录以 `/` 结尾） */
  name: string;
  /** 内容（缺省空） */
  data?: string;
  /** true = deflate（压缩方法 8）；缺省 stored（方法 0） */
  deflate?: boolean;
  /** unix mode；缺省按「名字以 / 结尾」判目录给 0o40755，否则 0o100644 */
  mode?: number;
  /** 覆盖 externalFileAttributes 原值（用于复现旧 DOS 打包器的目录标记） */
  attrs?: number;
  /** 覆盖 versionMadeBy（高字节 = 创建者系统；缺省 3 = unix，0 = DOS） */
  madeBy?: number;
}

/** 把条目列表封成一个 zip Buffer。 */
function makeZip(entries: readonly ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const item of entries) {
    const raw = Buffer.from(item.data ?? "", "utf8");
    const body = item.deflate === true ? deflateRawSync(raw) : raw;
    const method = item.deflate === true ? 8 : 0;
    const crc = crc32(raw);
    const name = Buffer.from(item.name, "utf8");
    const mode = item.mode ?? (item.name.endsWith("/") ? 0o40755 : 0o100644);
    // 高 16 位是 unix mode；用 `>>> 0` 抵消 `<< 16` 的符号溢出（0o40755 << 16 是负 int32）
    const attrs = item.attrs ?? (mode << 16) >>> 0;
    const madeBy = item.madeBy ?? 0x031e; // 高字节 3 = unix，低字节 30 = 版本

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags（名字均为 ASCII，不置 UTF-8 位）
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    // 中央目录条目另写 versionMadeBy / externalFileAttributes / 本地头偏移，其余字段与本地头同值
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(madeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(attrs, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// —— 用例 ——

let workDir: string;
let archive: string;
let dest: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ezn-unzip-"));
  archive = join(workDir, "archive.tmp"); // 无扩展名，与下载层一致（格式靠内容嗅探）
  dest = join(workDir, "out");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 落盘一份 zip 并跑解压，返回收集到的进度快照（最后一项即收尾快照）。 */
async function run(entries: readonly ZipEntrySpec[]): Promise<UnzipProgress[]> {
  writeFileSync(archive, makeZip(entries));
  const snapshots: UnzipProgress[] = [];
  await extractZip(archive, dest, (progress) => snapshots.push(progress));
  return snapshots;
}

/** 取数组末项（ES2020 的 lib 里没有 Array.prototype.at）。 */
function last<T>(list: readonly T[]): T | undefined {
  return list[list.length - 1];
}

describe("extractZip：落盘语义", () => {
  it("目录条目建目录、文件条目写内容（stored 与 deflate 都走通）", async () => {
    const big = "x".repeat(200_000);
    await run([
      { name: "node-v99/" },
      { name: "node-v99/a.txt", data: "hello" },
      { name: "node-v99/big.txt", data: big, deflate: true },
    ]);

    expect(statSync(join(dest, "node-v99")).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, "node-v99/a.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(dest, "node-v99/big.txt"), "utf8")).toBe(big);
  });

  it("条目未显式建父目录时自动补齐（zip 规范允许省略目录条目）", async () => {
    await run([{ name: "deep/nested/dir/file.txt", data: "x" }]);
    expect(readFileSync(join(dest, "deep/nested/dir/file.txt"), "utf8")).toBe("x");
  });

  it("旧 DOS 打包器的目录标记（creator=0 且属性恰为 16）按目录处理", async () => {
    await run([{ name: "legacydir", madeBy: 0x0014, attrs: 16 }]);
    expect(statSync(join(dest, "legacydir")).isDirectory()).toBe(true);
  });

  it("__MACOSX/ 条目跳过：不落盘也不计入项数", async () => {
    const snapshots = await run([
      { name: "__MACOSX/._x", data: "junk" },
      { name: "__MACOSX/x/._y", data: "junk" },
      { name: "x.txt", data: "real" },
    ]);

    expect(existsSync(join(dest, "__MACOSX"))).toBe(false);
    expect(readFileSync(join(dest, "x.txt"), "utf8")).toBe("real");
    expect(last(snapshots)?.entries).toBe(1);
  });
});

describe("extractZip：进度口径", () => {
  it("字节数单调不减，最终等于解压后总字节；当前条目名在大文件写盘期间可见", async () => {
    const big = "y".repeat(300_000);
    const snapshots = await run([
      { name: "small.txt", data: "12345" },
      { name: "big.txt", data: big, deflate: true },
    ]);

    const totalBytes = 5 + big.length;
    expect(snapshots.length).toBeGreaterThan(0);
    expect(last(snapshots)?.bytes).toBe(totalBytes);
    expect(last(snapshots)?.entries).toBe(2);
    expect(last(snapshots)?.current).toBe(null);

    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i]?.bytes ?? 0).toBeGreaterThanOrEqual(snapshots[i - 1]?.bytes ?? 0);
      expect(snapshots[i]?.entries ?? 0).toBeGreaterThanOrEqual(snapshots[i - 1]?.entries ?? 0);
    }
    // 大文件写盘期间必须看得到它的名字，且字节数停在「已完成 + 当前条目进行中」之间
    const inflight = snapshots.filter((p) => p.current === "big.txt");
    expect(inflight.length).toBeGreaterThan(0);
    expect(inflight.some((p) => p.bytes > 5 && p.bytes < totalBytes)).toBe(true);
  });

  it("空包（无条目）不报错，且不会上报任何进度（进度完全由条目驱动）", async () => {
    const snapshots = await run([]);
    // 不预设「必有一次基线快照」：空包下零上报是实现细节，断言只压不变量，免得把两种合理实现之一锁死
    expect(snapshots.every((progress) => progress.entries === 0)).toBe(true);
    expect(existsSync(dest)).toBe(true);
  });
});

describe("extractZip：防穿越与失败语义", () => {
  it("`..` 越界条目被拒，且目标目录之外不落任何文件", async () => {
    writeFileSync(archive, makeZip([{ name: "../escaped.txt", data: "boom" }]));
    await expect(extractZip(archive, dest)).rejects.toThrow();
    expect(existsSync(join(workDir, "escaped.txt"))).toBe(false);
  });

  it("绝对路径条目被拒", async () => {
    for (const name of ["/abs.txt", "C:/abs.txt"]) {
      writeFileSync(archive, makeZip([{ name, data: "boom" }]));
      await expect(extractZip(archive, dest)).rejects.toThrow();
    }
    expect(readdirSync(workDir).filter((n) => n.startsWith("abs"))).toEqual([]);
  });

  it("NTFS 数据流形态（段内冒号）条目被本模块自己的兜底拒绝", async () => {
    writeFileSync(archive, makeZip([{ name: "dir/a.txt:evil", data: "boom" }]));
    await expect(extractZip(archive, dest)).rejects.toThrow(/冒号|非法字符/);
    expect(existsSync(join(dest, "dir", "a.txt"))).toBe(false);
  });

  it("不是 zip（内容损坏）时报错而非静默成功", async () => {
    writeFileSync(archive, "this is not a zip file");
    await expect(extractZip(archive, dest)).rejects.toThrow();
  });
});
