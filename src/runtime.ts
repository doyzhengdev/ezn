/**
 * @file 运行时布局探测与版本解析——纯文件系统判定，无网络 I/O。
 * @fileoverview
 * 为什么单独成模块：这几条判定是「要不要下载重装」的决策依据，判错就会误删/误装用户目录
 * （典型：把落位中断的半成品当就绪复用，缺的 npm 永远补不上）。故与下载/执行逻辑分开，
 * 便于离线单测逐条钉住（`test/flat-ensure.test.ts`、`test/node.test.ts` 直接 import 本模块；
 * 本模块不从包导出，公共 API 面只有 `Node`）。
 */

import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import NODE_VERSIONS from "./versions.json";

const IS_WIN = process.platform === "win32";

/**
 * 解析版本描述为内置表中的确切版本（如 v18.20.8）。
 *
 * 按组件级前缀匹配（"18.1" 不命中 18.20.x）。内置表（versions.json）覆盖主版本 18~26，各自
 * 最新一次发布的固定 patch 版本。
 *
 * @param spec - 版本描述："18" | "18.1" | "18.1.5"（1~3 段数字）
 * @returns 内置表中的确切版本，形如 v18.20.8
 * @throws 格式非法（非 1~3 段数字）或内置表无匹配时抛可操作错误
 */
export function matchNodeVersion(spec: string): string {
  if (typeof spec !== "string" || !/^\d+(\.\d+){0,2}$/.test(spec)) {
    throw new Error(`nodeVersion 应为 "18" | "18.1" | "18.1.5" 形式（1~3 段数字），收到：${spec}`);
  }
  const expected = spec.split(".").map(Number);
  const available = Object.entries(NODE_VERSIONS as Record<string, { version: string }>);
  const hit = available.find(([, entry]) => {
    const actual = entry.version.replace(/^v/, "").split(".").map(Number);
    return expected.every((n, i) => actual[i] === n);
  });
  if (!hit) {
    throw new Error(
      `ezllm-node 内置版本表无匹配 Node ${spec} 的版本（当前内置：` +
        `${available.map(([major, entry]) => `${major}=${entry.version}`).join("、")}）。` +
        `可改传主版本号（如 18），或经 scripts/update-node-assets.mjs 更新版本表。`,
    );
  }
  return hit[1].version;
}

/**
 * 运行时根下的 node 可执行文件路径。
 *
 * @param root - 运行时根目录
 * @returns Windows 为 `<root>/node.exe`，POSIX 为 `<root>/bin/node`
 */
export function nodeExecPath(root: string): string {
  return IS_WIN ? join(root, "node.exe") : join(root, "bin", "node");
}

/**
 * 当前平台键（`<platform>-<arch>`，如 `win32-x64`）。
 *
 * 用途：`n` 命令的缓存目录分段——运行时二进制不可跨平台/架构复用，本地缓存被漫游目录同步或
 * 被多机共享时，不带平台段会让异构机拿到错误的可执行文件。与 `installNode` 选择的发行包
 * （`./install.ts` 的 NODE_PLATFORMS）是同一套键。
 *
 * @returns 平台键
 */
export function nodePlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * 探测目录是否为运行时根。
 *
 * 依据是「文件在不在」而非探测能否执行（更快）；供 {@link isFlatRuntimeReady} 使用。
 *
 * @param dir - 待探测目录
 * @returns 运行时根绝对路径；缺 node 可执行文件时返回 null
 */
function detectFlatNode(dir: string): string | null {
  const root = resolve(dir);
  return existsSync(nodeExecPath(root)) ? root : null;
}

// 自带 npm/npx 在运行时根下的候选入口——官方发行包的 npm 位置随平台而异，两处都要认：
//   · Windows zip / npm 全局 prefix 布局：<root>/node_modules/npm/bin/<which>-cli.js
//   · POSIX 官方 tar.gz 布局：<root>/lib/node_modules/npm/bin/<which>-cli.js
// 包名恒为 npm：npx 随 npm 包一起发布（npx-cli.js 就在 npm 的 bin 下），不存在独立的 npx 包目录。
function bundledCliCandidates(root: string, which: "npm" | "npx"): string[] {
  return [
    join(root, "node_modules", "npm", "bin", `${which}-cli.js`),
    join(root, "lib", "node_modules", "npm", "bin", `${which}-cli.js`),
  ];
}

/**
 * 在运行时根下解析自带 npm / npx 的 CLI 入口（`node npm-cli.js` 形式，跨平台免 `.cmd` shim）。
 *
 * 以「文件是否在位」判定（不探测 node 能否执行），按 Windows → POSIX 官方包布局取第一个命中。
 *
 * @param root - 运行时根目录
 * @param which - 要解析的 CLI
 * @returns CLI 入口的绝对路径
 * @throws 缺自带 npm/npx 时抛可操作错误（列出全部候选路径与恢复方式）
 */
export function resolveBundledCli(root: string, which: "npm" | "npx"): string {
  const candidates = bundledCliCandidates(root, which);
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (!hit) {
    throw new Error(
      [
        `未找到自带 ${which}（该目录可能不是完整的 Node 运行时）。已查找以下位置：`,
        ...candidates.map((candidate) => `  - ${candidate}`),
        "可尝试的恢复方式：",
        "  1. 托管运行时（<appDir>/node）：删除该目录后重新启动服务，由引导重新落位完整运行时；",
        "  2. 手工安装的平铺运行时：请确认发行包完整（含自带 npm/npx），必要时重新解压放置。",
      ].join("\n"),
    );
  }
  return hit;
}

/**
 * 「就绪」判定：node 在运行时根且自带 npm 的 CLI 入口在位。
 *
 * 比「node 可执行 + 主版本达标」多一条 npm 检查，理由：落位逐条目进行、失败保留现场（不回滚），
 * 可能停在「node 已就位、自带 npm 还没搬进来」的半成品状态——只按 node 判定就会把它当就绪复用，
 * 缺的 npm 永远补不上（服务端首启引导依赖运行时自带 npm）。
 *
 * @param root - 运行时根目录
 * @returns 是否可当作就绪运行时复用
 */
export function isFlatRuntimeReady(root: string): boolean {
  return detectFlatNode(root) !== null && bundledCliCandidates(root, "npm").some((candidate) => existsSync(candidate));
}

// Windows 的可执行后缀，按 PATHEXT 惯例顺序（.cmd 优先于 .bat：npm/nve 的 shim 都是 .cmd）。
const WIN_EXEC_EXTS = [".cmd", ".bat", ".exe"] as const;

/**
 * 在运行时根下解析一个「命令名」为可执行文件绝对路径。
 *
 * 用途：`exec("nve -v")` 这类「执行运行时目录下的命令」——`npm i -g` 装的包会把 shim 落在运行时根
 * （如 `<rt>/nve`、`<rt>/nve.cmd`、`<rt>/nve.ps1`），故优先在 rt 下找，找到了就用它。
 *
 * 解析顺序（命中即返回）：
 * 1. Windows：`<rt>/<name>.cmd` → `.bat` → `.exe`；POSIX：`<rt>/<name>`
 * 2. `<rt>/node_modules/.bin/<name>`（npm 本地安装惯例位置，跨平台）
 *
 * @param root - 运行时根目录
 * @param name - 命令名；若已含路径分隔符（如 `"./foo"`、`"C:\\x\\y"`）则视为路径，不做解析
 * @returns 可执行文件绝对路径；未命中或 name 是路径时返回 null
 */
export function resolveRuntimeCommand(root: string, name: string): string | null {
  if (name.includes("/") || name.includes("\\")) return null; // 已是路径，非命令名
  const candidates = IS_WIN ? WIN_EXEC_EXTS.map((ext) => join(root, `${name}${ext}`)) : [join(root, name)];
  candidates.push(join(root, "node_modules", ".bin", name));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * 执行运行时目录下命令时用的 PATH 前缀。
 *
 * 把运行时根（及 Windows 的 `node_modules/.bin`）前置，使被执行的命令内部再调 node/npm 时命中本
 * 运行时的版本，而非宿主 PATH 上的。以 `path.delimiter` 结尾，便于调用方直接 `prefix + 原 PATH`。
 *
 * @param root - 运行时根目录
 * @returns 以 delimiter 结尾的 PATH 前缀
 */
export function runtimePathPrefix(root: string): string {
  const entries = IS_WIN ? [root, join(root, "node_modules", ".bin")] : [join(root, "bin"), root];
  return entries.join(delimiter) + delimiter;
}
