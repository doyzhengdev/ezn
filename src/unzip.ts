/**
 * @file zip 解压（Windows 分支专用）：yauzl@3 直用，带字节级进度。
 * @fileoverview
 * 为什么不用 extract-zip：它锁 yauzl@2.10 → fd-slicer@1.1.0，而后者的 `new Buffer(n)`（无
 * allocUnsafe 守卫）让**每次**解压都打一条 Node 的 DEP0005 弃用警告，且这条链路自 2020 年后停更。
 * yauzl@3 把 fd-slicer 内联进包并改写为 `Buffer.allocUnsafe`，依赖只剩 pend；两者都经构建期
 * 内联进产物（见根 README 的依赖说明与 vite.config.mts 契约 3）。
 *
 * 为什么自己写落盘循环是安全的：**本模块只服务 Windows**（`NODE_PLATFORMS` 里 zip 仅 win32-*），
 * 不必处理 POSIX 软链接与执行位——那两块恰是自己写解压器最容易出错的地方，此处根本不存在。
 * 条目名的路径安全也不自己造：yauzl 在缺省 `decodeStrings` 下已对每个条目自动跑
 * `validateFileName()`（拒绝 `/`、`[A-Za-z]:/` 开头以及含 `..` 段或 `\` 的名字），本模块只补
 * 两道它不覆盖的兜底（NTFS 数据流冒号、解析后必须仍在目标目录内），见 entryDestPath。
 *
 * 与 extract-zip 的行为对齐项（不让落位层看到两套口径）：`__MACOSX/` 条目跳过且不计入进度；
 * 目录条目计入「项数」（判据见 isDirectoryEntry）。
 *
 * 进度按**字节**上报而非只报条目数：官方包里 89 MB 的 node.exe 占全部数据的 87%，只报条目数时
 * 那一行会长时间不动，与「进程已死」在屏幕上完全一样——这正是本轮改动要修的现象。
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { openPromise } from "yauzl";
import type { Entry } from "yauzl";

/** 解压进度快照（每次上报都是一个新对象，消费方可直接持有）。 */
export interface UnzipProgress {
  /** 已完成条目数（含目录条目，与「解压完成（N 项）」同口径） */
  readonly entries: number;
  /** 已落盘字节数，含当前条目已写入的部分；单调不减 */
  readonly bytes: number;
  /** 当前正在写盘的条目名；条目切换的间隙与全部完成时为 null */
  readonly current: string | null;
}

/** 进度回调（每个数据块触发一次；消费方只做赋值，无需节流）。 */
export type UnzipProgressHandler = (progress: UnzipProgress) => void;

// unix mode 位的「文件类型」掩码与「目录」取值（zip 的 externalFileAttributes 高 16 位）
const MODE_IFMT = 0xf000;
const MODE_IFDIR = 0x4000;
// 旧 DOS 打包器的目录标记：creator 高字节为 0 且外部属性恰为 16
const DOS_DIR_ATTRIBUTES = 16;

/**
 * 条目名 → 目标绝对路径（含两道越界兜底）。
 *
 * 1. 段内冒号——Windows 上 `a.txt:evil` 会写成 NTFS 替代数据流（ADS）而不是普通文件；
 * 2. 解析后的路径必须仍在 destDir 内——前缀比较不依赖条目名的书写形式，是最后一道判据。
 *
 * @param root - 目标目录的绝对路径（已 resolve）
 * @param entryName - zip 条目名（`/` 分隔）
 * @returns 落盘的绝对路径
 * @throws 条目名含冒号，或解析后越出目标目录
 */
function entryDestPath(root: string, entryName: string): string {
  const dest = resolve(root, entryName);
  if (!dest.startsWith(root + sep)) throw new Error(`zip 条目越出目标目录：${entryName}`);
  if (entryName.split("/").some((segment) => segment.includes(":"))) {
    throw new Error(`zip 条目名含非法字符「:」（NTFS 数据流形态）：${entryName}`);
  }
  return dest;
}

/**
 * 是否目录条目——三条判据与 extract-zip 保持一致，避免同一个包在两条实现下语义漂移。
 *
 * @param entry - yauzl 条目
 * @returns 目录条目为 true
 */
function isDirectoryEntry(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((mode & MODE_IFMT) === MODE_IFDIR) return true;
  if (entry.fileName.endsWith("/")) return true;
  return entry.versionMadeBy >>> 8 === 0 && entry.externalFileAttributes === DOS_DIR_ATTRIBUTES;
}

/**
 * 解压 zip 到目标目录（目录不存在则创建）。
 *
 * 条目逐个读、逐个写：上一条数据流写完（pipeline 结束）才读下一条，故内存占用与包大小无关
 * （89 MB 的 node.exe 也不会整块进内存）。失败一律抛出；已落盘的部分**不清理**——下载层
 * （./install.ts 的 downloadExtract）在换镜像源时会整体重置临时区。
 *
 * @param archivePath - zip 文件路径
 * @param destDir - 目标目录（相对路径会被 resolve 成绝对路径）
 * @param onProgress - 进度回调（可选）
 * @throws zip 打不开或损坏（yauzl 的错误原文）；条目名越界；写盘失败
 */
export async function extractZip(
  archivePath: string,
  destDir: string,
  onProgress?: UnzipProgressHandler,
): Promise<void> {
  const root = resolve(destDir);
  mkdirSync(root, { recursive: true });

  let finishedEntries = 0;
  let finishedBytes = 0;
  let currentEntry: string | null = null;
  /** 上报快照：bytes 恒为「已完成字节 + 当前条目已写字节」，故大文件内部也在涨 */
  const report = (inflight = 0): void => {
    onProgress?.({ entries: finishedEntries, bytes: finishedBytes + inflight, current: currentEntry });
  };

  const zipfile = await openPromise(archivePath);
  try {
    for await (const entry of zipfile.eachEntry()) {
      if (entry.fileName.startsWith("__MACOSX/")) continue; // 见文件头注：与 extract-zip 行为对齐

      const dest = entryDestPath(root, entry.fileName);
      if (isDirectoryEntry(entry)) {
        mkdirSync(dest, { recursive: true });
        finishedEntries += 1;
        report();
        continue;
      }

      mkdirSync(dirname(dest), { recursive: true });
      currentEntry = entry.fileName;
      report();

      let written = 0;
      const source = await zipfile.openReadStreamPromise(entry);
      source.on("data", (chunk: Buffer) => {
        written += chunk.length;
        report(written);
      });
      await pipeline(source, createWriteStream(dest));

      // validateEntrySizes 缺省开启，written 必等于 entry.uncompressedSize；按实际写入计更稳
      finishedBytes += written;
      finishedEntries += 1;
      currentEntry = null;
      report();
    }
  } finally {
    // 迭代正常走完由 autoClose 关闭；条目处理中途抛错时在这里兜底（close 对已关闭的包是 no-op）
    if (zipfile.isOpen) zipfile.close();
  }
}
