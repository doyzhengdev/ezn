// ezn 包内构建：产出标准 npm 包形态的 dist/（CJS/ESM 双入口）
//   dist/index.js   —— esbuild bundle（CJS、target node16）：versions.json 内联，got/tar/extract-zip 保持 external require
//   dist/index.mjs  —— ESM 包装入口：createRequire 走 CJS 加载实现后具名 re-export（规避 ESM 对 CJS
//                      具名导出的静态分析限制——esbuild __export 模式 cjs-module-lexer 识别不了）
//   dist/index.d.ts —— tsc 仅声明发射（rootDir=src，JSON 数据文件不产声明），require 形态类型
//   dist/index.d.mts—— 同上拷贝，import 形态类型（exports 条件导出按 publint 建议拆分 types）
//   dist/ezn.js       —— `ezn` 命令（bin/ezn.js 薄启动器动态加载；版本号经 define 注入）
// dist/ 是唯一编译事实源：工作区消费者与发布构建拿到的都是这份产物（npm 包经 prepack 重新产出）。
//
// 用法：npm run build（或 npm test，已串联）

import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf-8"));

await build({
  entryPoints: [resolve(pkgRoot, "src", "index.ts")],
  bundle: true, // 内联 versions.json
  platform: "node",
  target: "node16", // 壳包引导器语法基线
  format: "cjs",
  outfile: resolve(pkgRoot, "dist", "index.js"),
  sourcemap: false,
  external: ["got", "tar", "extract-zip"], // 运行时依赖保持 require
});

// `ezn` 命令（bin/ezn.js 动态加载本产物）。target 抬到 node18：产物由 bin/ezn.js 动态 import，而启动器
// 本身可能是被宿主 node 18 跑起来的（见 bin/ezn.js 头注），故不走 node16 基线——ezn-cli 需要
// node:fs / node:path 之外的现代语法（可选链、逻辑赋值、URL 等）。版本号经 define 注入，
// 免去产物在运行期回读 package.json（打包后相对路径不可靠）。
await build({
  entryPoints: [resolve(pkgRoot, "src", "ezn-cli.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: resolve(pkgRoot, "dist", "ezn.js"),
  sourcemap: false,
  external: ["got", "tar", "extract-zip"],
  define: { __EZN_VERSION__: JSON.stringify(pkg.version) },
});

// 说明：公共 API 面只有 Node 类（静态 ensure/probeMajor + 实例 exec/npm/npx）。
//
// ESM 包装入口（与 dist/index.js 同目录，相对 require 指向 CJS 实现）
// 名单是硬编码的，必须与 src/index.ts 的运行期具名导出保持一致——漏项时 ESM 消费者
// `import { x } from "@doyzheng/ezn"` 编译通过、运行期报 does not provide an export named；
// test/node.test.ts 有对齐断言把这类漂移钉住（新增导出时同步补这里 + 该断言会提醒）。
const esmWrapper = `// 本文件由 ezn 构建生成，请勿手改。ESM 入口：包装 CJS 实现并具名 re-export。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Node } = require("./index.js");
export { Node };
`;
writeFileSync(resolve(pkgRoot, "dist", "index.mjs"), esmWrapper, "utf-8");

execSync("npx tsc -p tsconfig.build.json", { cwd: pkgRoot, stdio: "inherit" });
// import 条件的类型声明：.d.ts 拷贝为 .d.mts（exports["."].import.types）
copyFileSync(resolve(pkgRoot, "dist", "index.d.ts"), resolve(pkgRoot, "dist", "index.d.mts"));
console.log(
  "[ezn] 构建完成：dist/index.js（CJS）+ dist/index.mjs（ESM 入口）+ dist/index.d.ts / .d.mts" +
    " + dist/ezn.js（`ezn` 命令）",
);
