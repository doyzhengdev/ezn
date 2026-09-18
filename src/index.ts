/**
 * @file 包入口（ezn）：只做导出编排，不含任何实现。
 * @fileoverview
 * 公共 API 面只有 `Node` 类与 `SpawnAsyncResult`（Node 实例方法见 `./node.ts`）。包内实现分层：
 * - `./node.ts`——Node 类本体（运行时探测/复用决策、exec/npm/npx 执行封装）
 * - `./install.ts`——下载 + 解压 + 落位（`installNode(nodeDir, nodeVersion)`）
 * - `./runtime.ts`——运行时探测与版本解析（版本表匹配、自带 npm/npx 入口解析、就绪判定）
 *
 * `dist/` 构建产物（CJS/ESM 双入口）以本文件为 esbuild 入口；ESM 包装名单见 `scripts/build.mjs`。
 */

export { Node } from "./node.js";
export type { SpawnAsyncResult } from "./node.js";
