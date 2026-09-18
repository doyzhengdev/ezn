#!/usr/bin/env node
/**
 * `ezn` 命令薄启动器：把控制权交给构建产物 dist/ezn.js。
 *
 * 为什么需要这一层而不是让 bin 直接指 dist/ezn.js：
 * - `dist/` 是 gitignore 的构建产物，全新 clone 后不存在（npm 安装的包则始终带着它，见 package.json
 *   的 files 与 prepack）。直接指向它，源码 clone 后用户敲 `ezn vitest run` 只会得到 Node 的
 *   `Cannot find module`；经这一层可以给出「先跑 npm run build」的可操作指引。
 * - 版本表（versions.json）与 got/tar/extract-zip 都要经 esbuild 打进产物，启动器自身保持零依赖。
 *
 * 本文件可能被**任意版本**的 node 执行（挂在宿主 node 18 上跑是常态），故只用 CommonJS 语法，
 * 动态加载走 `import()`，不用顶层 await / ESM 语法。
 */

"use strict";

const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const entry = join(__dirname, "..", "dist", "ezn.js");

if (!existsSync(entry)) {
  console.error(
    [
      "[ezn] 未找到构建产物：dist/ezn.js",
      "可尝试的恢复方式：",
      "  1. 在仓库根执行：npm run build",
      "  2. 或用 npx 直接跑发布版（无需本地构建）：npx @doyzheng/ezn <命令>",
      "（dist/ 是构建产物、不入库，从源码 clone 后需先构建一次。）",
    ].join("\n"),
  );
  process.exit(1);
}

import(pathToFileURL(entry).href)
  .then((mod) => mod.main(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[ezn] ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });
