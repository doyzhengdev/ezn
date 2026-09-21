/** @file ezn 包内构建：产出标准 npm 包形态的 dist/（CJS/ESM 双入口）。
 * @fileoverview
 *
 * 为什么用 tsdown 而非 esbuild + tsc：统一打包与类型发射到同一引擎（底层 rolldown）。
 * 旧的 `esbuild 两趟 + tsc 子进程` 每次构建约 1.5s，其中近半是 tsc 的进程启动与全量声明发射；
 * tsdown 的 dts 由 rolldown-plugin-dts 同进程产出，实测约 0.8s（-46%）。
 *
 * 产物清单（与 package.json 的 exports 一一对应，改这里必须同步改那里）：
 *   dist/index.js    —— 公共 API，CJS（`require` 条件）
 *   dist/index.mjs   —— 公共 API，ESM（`import` 条件）
 *   dist/index.d.ts / dist/index.d.mts —— 对应两种形态的类型声明
 *   dist/ezn.js      —— `ezn` 命令（bin/ezn.js 动态加载）
 *
 * ⚠️ 三个与常规 tsdown 用法不同的地方，缺一不可：
 *   1. **分三个 config 而非一个多格式 config**：`outExtensions` 的 `js`/`dts` 是「扩展名」而非
 *      完整文件名，无法用它把两个格式落成不同基名；而 ezn 是 `type: "commonjs"` 的包，tsdown
 *      默认给 CJS 产 `.cjs`、ESM 产 `.mjs`，与 exports 契约要求的 `index.js`/`index.mjs` 不符。
 *      故按格式拆开，用 `entry: { 基名: 源文件 }` 的对象形式显式指定基名。
 *   2. **不要用 `outputOptions.entryFileNames` 改名**：dts 插件按自己的命名规则定位产物文件，
 *      被 entryFileNames 改名后两边对不上，dts 会**静默不产出**（只报 `0 files`，不报错）。
 *   3. **CLI 入口的 entry 键与 bin/ezn.js 的加载路径是一对契约**：产物名由 entry 键决定
 *      （此处键为 `cli` → `dist/cli.js`），而 bin/ezn.js 硬编码加载该文件名。改一处必须改另一处，
 *      否则构建照常成功、测试也全绿，CLI 却报「未找到构建产物」——test/node.test.ts 有断言钉住。
 *
 * 本文件用 `.mts` 后缀：包是 `type: "commonjs"`，`.ts` 会被 Node 按 CJS 加载而报
 * 「Cannot use import statement outside a module」。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

const pkgRoot: string = dirname(fileURLToPath(import.meta.url));
const pkg: { version: string; dependencies?: Record<string, string> } = JSON.parse(
  readFileSync(resolve(pkgRoot, "package.json"), "utf-8"),
);

/** 要保持 external 的运行时依赖：直接从 package.json 的 `dependencies` 派生。
 *
 *  为什么派生而非硬编码：两处各写一份必然漂移，而漂移的两个方向都是故障——漏写会让该依赖被
 *  打进产物（体积膨胀且与声明的依赖不一致），多写会让它不进包却在运行期被 require（找不到模块）。
 *  `dependencies` 本就是「运行期需要哪些包」的唯一事实源，此处直接消费它。 */
const NEVER_BUNDLE: string[] = Object.keys(pkg.dependencies ?? {});

export default defineConfig([
  // 公共 API —— CJS 形态（exports 的 require 条件）
  {
    entry: { index: "src/index.ts" },
    outDir: "dist",
    format: ["cjs"],
    platform: "node",
    target: "node16", // 壳包引导器语法基线，对应 engines.node >= 16
    deps: { neverBundle: NEVER_BUNDLE },
    dts: true,
    sourcemap: false,
    clean: false, // 三个 config 共写 dist/，任一都不许清空别人的产物
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  },
  // 公共 API —— ESM 形态（exports 的 import 条件）。
  // 与旧实现的根本差异：这里产出的是**真 ESM**（`export { Node }` 直接 re-export CJS 实现的具名导出），
  // 而非旧的 `createRequire` 包装。Node 与 bundler 都能静态解析它，消费端因此不必再配 alias
  // 绕开包装（旧包装被 rolldown 原样搬进产物会导致运行时报 Cannot find module './index.js'）。
  {
    entry: { index: "src/index.ts" },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "node16",
    deps: { neverBundle: NEVER_BUNDLE },
    dts: true,
    sourcemap: false,
    clean: false,
    outExtensions: () => ({ js: ".mjs", dts: ".d.mts" }),
  },
  // `ezn` 命令：target 抬到 node18——产物由 bin/ezn.js 动态 import，而启动器本身可能是被宿主
  // node 18 跑起来的（见 bin/ezn.js 头注），故不走 node16 基线；cli.ts 需要 node:fs / node:path
  // 之外的现代语法（可选链、逻辑赋值、URL 等）。版本号经 define 注入，免去产物在运行期回读
  // package.json（打包后相对路径不可靠）。
  {
    entry: { cli: "src/cli.ts" },
    outDir: "dist",
    format: ["cjs"],
    platform: "node",
    target: "node18",
    deps: { neverBundle: NEVER_BUNDLE },
    define: { __EZN_VERSION__: JSON.stringify(pkg.version) },
    dts: false,
    sourcemap: false,
    clean: false,
    outExtensions: () => ({ js: ".js" }),
  },
]);
