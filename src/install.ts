/**
 * @file Node 下载 + 解压 + 落位：把内置表指定版本的 Node 装进调用者给的目录。
 * @fileoverview
 * 只导出 `installNode(nodeDir, nodeVersion)`——「装到哪」由调用者决定（`Node.ensure` 传 `<appDir>/node`）。
 *
 * **落位一律逐条目进行**，绝不删除 nodeDir 内既有的、与本次安装无关的文件：运行时目录同时装着
 * npm 安装的托管包（`<nodeDir>/node_modules/ezllm`），整目录覆盖或清空会把包一并抹掉，服务随即
 * 找不到自身入口 `server.js`。共享目录（node 自带包与托管包同处一处）按子项合并，目标独有的子项
 * 原地不动。
 *
 * 为什么要「逐条目落位 + 共享目录按子项合并」——两种朴素做法都会坏事：
 * - 整目录备份/rename → npm 装好的托管包被一起挪进 `.old-<时间戳>`，服务随即找不到自身入口；
 * - 整目录跳过（认为「已有则不动」）→ 包先装、node 后落位时，自带 npm 永远装不进去。
 *
 * 共享目录 = node 官方包放自带包（npm/corepack）的地方，而 npm 又把托管包装进同一个目录：
 * - Windows zip：`<nodeDir>/node_modules`
 * - POSIX tar.gz：`<nodeDir>/lib/node_modules`（lib 只是路径前缀，故须下钻合并而非整体备份）
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import got from "got";
import * as tar from "tar";
import extractZip from "extract-zip";
import { matchNodeVersion, nodeExecPath, nodePlatformKey } from "./runtime.js";

// 平台 → 压缩包目录/扩展名（nodejs.org/dist 命名约定；zip 仅 Windows 系平台）。
const NODE_PLATFORMS = {
  "win32-x64": { dir: "win-x64", ext: "zip" },
  "win32-arm64": { dir: "win-arm64", ext: "zip" },
  "darwin-arm64": { dir: "darwin-arm64", ext: "tar.gz" },
  "darwin-x64": { dir: "darwin-x64", ext: "tar.gz" },
  "linux-x64": { dir: "linux-x64", ext: "tar.gz" },
  "linux-arm64": { dir: "linux-arm64", ext: "tar.gz" },
};

const IS_WIN = process.platform === "win32";

// 共享目录（须逐子项合并，不得整目录备份/跳过）。见文件头注。
const MERGE_PATHS: readonly (readonly string[])[] = IS_WIN ? [["node_modules"]] : [["lib", "node_modules"]];

/**
 * 下载 + 解压内置表指定版本的 Node，返回「已去掉顶层版本目录」的内容目录（位于 workDir 内）。
 *
 * - 镜像顺序：`ELLM_NODE_MIRROR` > registry.npmmirror.com > nodejs.org，逐个重试
 * - 临时区（压缩包 + 解压区）建在 workDir 下——与最终目标同盘，保证后续 rename 不跨盘 EXDEV
 * - 调用方把 src 搬走/落位后**必须**调用 `cleanup()`
 *
 * @param nodeVersion - 内置表中的确切版本（如 v24.21.0），由 `matchNodeVersion` 解析得到
 * @param workDir - 临时区所在目录（须与最终目标同盘）
 * @param opts - 目标路径与平台信息（仅用于错误提示中的手动放置指引）
 * @returns 解压就绪的内容目录 `src`，以及清理临时区的 `cleanup`
 * @throws 所有镜像源均不可用时抛可操作错误（此时内部已清理临时区）
 */
async function downloadExtract(
  nodeVersion: string,
  workDir: string,
  opts: { target: string; nodePath: string; platform: { dir: string; ext: string } },
): Promise<{ src: string; cleanup: () => void }> {
  const filename = `node-${nodeVersion}-${opts.platform.dir}.${opts.platform.ext}`;
  const tmpArchive = join(workDir, "node.download.tmp");
  const extractDir = join(workDir, "node.extract.tmp");
  const cleanup = (): void => {
    rmSync(tmpArchive, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  };

  const mirrors: string[] = [];
  const customMirror = process.env.ELLM_NODE_MIRROR;
  if (customMirror) mirrors.push(customMirror.replace(/\/+$/, ""));
  mirrors.push("https://registry.npmmirror.com/-/binary/node", "https://nodejs.org/dist");

  rmSync(tmpArchive, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  for (let i = 0; i < mirrors.length; i++) {
    const mirror = mirrors[i] as string;
    const url = `${mirror}/${nodeVersion}/${filename}`;
    console.error(`[ezllm-node] (${i + 1}/${mirrors.length}) 正在下载 ${filename}\n[ezllm-node]   来源：${mirror}`);
    try {
      // 流式下载（got@11 stream）：自动跟随重定向（≤10）、连接类错误自动重试；decompress 关闭保证
      // 字节原样落盘（.zip/.tar.gz 本体自含压缩，不能被 content-encoding 二次解压）；socket 60 秒
      // 静默即断，不限制总时长以兼容慢速大文件。
      let nextMark = 20 * 1024 * 1024;
      const source = got.stream(url, {
        decompress: false,
        timeout: { connect: 30000, response: 60000, socket: 60000 },
      });
      source.on("downloadProgress", (progress) => {
        if (progress.transferred >= nextMark) {
          console.error(`[ezllm-node]   已下载 ${Math.round(progress.transferred / 1048576)} MB ...`);
          nextMark += 20 * 1024 * 1024;
        }
      });
      await pipeline(source, createWriteStream(tmpArchive));

      console.error("[ezllm-node] 下载完成，正在解压 ...");
      // 解压：zip → extract-zip（yauzl 内核，条目路径防穿越）；tar.gz → tar@6（纯 JS，从文件读取
      // 时按内容嗅探 gzip，unix 下软链接与执行位照常保留）。按 NODE_PLATFORMS 声明的格式分流而非
      // 按扩展名——下载临时文件无扩展名。
      if (opts.platform.ext === "zip") {
        await extractZip(tmpArchive, { dir: extractDir });
      } else {
        await tar.x({ file: tmpArchive, cwd: extractDir });
      }

      // 上提一层去掉顶层版本目录（node-v24.9.0-win-x64/… → 内容直接落在 src 下）。
      const entries = readdirSync(extractDir);
      const src =
        entries.length === 1 && entries[0] !== undefined && statSync(join(extractDir, entries[0])).isDirectory()
          ? join(extractDir, entries[0])
          : extractDir;
      rmSync(tmpArchive, { force: true }); // 压缩包用完即删；解压区留给调用方搬运
      return { src, cleanup };
    } catch (err) {
      console.error(`[ezllm-node] 该源失败：${err instanceof Error ? err.message : String(err)}`);
      // 压缩包与解压区一并重置：否则上一源的半截解压内容会污染下一源的解压结果。
      rmSync(tmpArchive, { force: true });
      rmSync(extractDir, { recursive: true, force: true });
      mkdirSync(extractDir, { recursive: true });
    }
  }
  rmSync(extractDir, { recursive: true, force: true });
  const officialBase = mirrors[mirrors.length - 1] ?? "https://nodejs.org/dist";
  throw new Error(
    [
      "Node 运行时下载失败：所有镜像源均不可用。",
      "可尝试的恢复方式：",
      "  1. 检查网络后重试；",
      "  2. 设置私有镜像（目录结构需同 nodejs.org/dist）后重试，例如：",
      "       set ELLM_NODE_MIRROR=https://your-mirror.example/node-dist",
      `  3. 手动放置：下载 ${filename}（见 ${officialBase}/${nodeVersion}/），`,
      `     解压到 ${opts.target}（如带顶层版本目录请把其内容上移一层），`,
      `     确保可执行文件位于 ${opts.nodePath}。`,
    ].join("\n"),
  );
}

/**
 * 单条目落位：落在合并路径上的目录逐子项下钻，其余同名项备份后覆盖。
 *
 * 目标独有、源没有的子项不会被遍历到，因而原地保留（这正是托管包得以幸存的原因）。
 *
 * @param srcPath - 源路径（解压就绪的内容）
 * @param destPath - 目标路径
 * @param rel - srcPath 相对源根的路径段（用于判断是否落在合并路径上）
 * @param mergePaths - 共享目录（须原地合并，不得整目录备份）
 * @param stamp - 本次落位共用的时间戳（备份名后缀）
 */
function landEntry(
  srcPath: string,
  destPath: string,
  rel: readonly string[],
  mergePaths: readonly (readonly string[])[],
  stamp: number,
): void {
  // rel 是否落在某条合并路径上（与它相等或是它的前缀）——落在其上的目录必须原地合并，不能整目录备份
  const onMergePath = mergePaths.some((path) => rel.length <= path.length && rel.every((seg, i) => path[i] === seg));
  if (onMergePath && existsSync(destPath) && statSync(srcPath).isDirectory() && statSync(destPath).isDirectory()) {
    for (const name of readdirSync(srcPath)) {
      landEntry(join(srcPath, name), join(destPath, name), [...rel, name], mergePaths, stamp);
    }
    rmSync(srcPath, { recursive: true, force: true }); // 源目录已搬空，清掉空壳
    return;
  }
  if (existsSync(destPath)) {
    const backup = `${destPath}.old-${stamp}`;
    renameSync(destPath, backup);
    console.error(`[ezllm-node] 同名项已备份：${backup}`);
  }
  renameSync(srcPath, destPath); // 同盘 rename（src 在 dir 内），无 EXDEV
}

/**
 * 把内置表内 nodeVersion 描述的 Node 装进 nodeDir（目录自身即运行时根：Windows `<nodeDir>/node.exe`、
 * POSIX `<nodeDir>/bin/node`），自带 npm/npx/corepack 一并在位。
 *
 * nodeDir 已存在时**逐条目落位**：同名运行时条目备份为 `<名>.old-<时间戳>` 后覆盖，共享目录
 * （`<nodeDir>/node_modules`，POSIX 为 `<nodeDir>/lib/node_modules`）按子项合并，目标独有的子项
 * （如 npm 装进去的托管包）原地不动。即：**绝不删除与本次安装无关的既有文件**。
 * 失败时保留现场（不回滚——回滚可能删掉已被覆盖的文件）。
 *
 * @param nodeDir - 目标目录（相对路径会被 resolve 成绝对路径），目录不存在时会创建
 * @param nodeVersion - `"18"` | `"18.1"` | `"18.1.5"`（1~3 段数字），按组件级前缀匹配内置表
 * @throws 平台不支持；nodeVersion 格式非法或无匹配；所有镜像源均不可用时抛可操作错误
 */
export async function installNode(nodeDir: string, nodeVersion: string): Promise<void> {
  // 逐条目落位：把解压就绪的 src 内容搬进 dir（MERGE_PATHS 指定的共享目录按子项合并）。
  // 同名运行时条目先备份为 <名>.old-<时间戳>（同一次落位共用同一时间戳）再覆盖——覆盖的是
  // 损坏/不达标的旧运行时；目标独有的子项（npm 装进去的托管包）原地不动。
  // 失败时已搬入的部分保留现场（不回滚，避免误删已被覆盖的文件）。
  const materializeFlat = (src: string, dir: string): void => {
    const stamp = Date.now();
    for (const name of readdirSync(src)) {
      landEntry(join(src, name), join(dir, name), [name], MERGE_PATHS, stamp);
    }
  };

  const dir = resolve(nodeDir);
  const fullVersion = matchNodeVersion(nodeVersion);
  const nodePath = nodeExecPath(dir);

  const platformKey = nodePlatformKey();
  const platform = (NODE_PLATFORMS as Record<string, { dir: string; ext: string }>)[platformKey];
  if (!platform) {
    throw new Error(
      `暂不支持的平台：${platformKey}。` +
        `请手动放置 Node ${fullVersion} 到 ${dir}，确保可执行文件位于 ${nodePath}` +
        `（Windows 为 node.exe，Unix 为 bin/node）。`,
    );
  }

  mkdirSync(dir, { recursive: true }); // 目标目录可能尚不存在（首次装配）
  // 临时区取目标的父目录：与目标同盘，保证落位时的 rename 不跨盘（EXDEV）
  const workDir = dirname(dir);
  const { src, cleanup } = await downloadExtract(fullVersion, workDir, { target: dir, nodePath, platform });
  try {
    materializeFlat(src, dir);
  } finally {
    // 失败时保留 dir 现场已落位的部分供排查（不回滚——回滚可能删掉已被覆盖的文件）
    cleanup();
  }
  console.error(`[ezllm-node] Node ${fullVersion} 已就绪：${dir}`);
}
