/** @file ezn 构建编排：驱动 vite 依次构建三个产物，并做派生产物与齐全性校验。
 * @fileoverview
 *
 * 用法：`npm run build`（= tsx scripts/build.mts）。
 *
 * 为什么要编排而不是在 vite.config.mts 里一趟构建完：rolldown 关闭 code splitting 时只接受
 * 单入口（见 vite.config.mts 契约 2），三个产物只能三次构建；`EZN_BUNDLE` 是构建期变量，
 * 由本脚本逐个设置后复用同一份配置（与 app/cli 的 scripts/lib/bundles.ts 同构——vite 的
 * `viteBuild({ configFile })` 每次都重新加载配置，函数式 config 因而能读到当前目标）。
 *
 * 为什么清空 dist：三个目标共写 dist/，各目标自身不许清空别人的产物；统一清理放在这里，
 * 保证「dist 内容 = 本次构建产物」。否则改过产物名后旧文件会残留——dist 列在 package.json
 * 的 files 里，残留会直接混进发布包。
 *
 * 为什么复制 index.d.ts：dts 插件只产 index.d.mts（且拒绝 CJS 输出格式，见 vite.config.mts
 * 契约 5），而 package.json 的 exports.require.types 指着 index.d.ts。声明内容与模块格式无关，
 * 同一份内容两个扩展名——两条 exports 条件各自要一份。
 *
 * 为什么做产物齐全性校验：产物名由 entryFileNames 的 `[name]` 模板从入口基名推导，这条链
 * （入口路径 → 模板 → dts 插件的声明命名）任一处漂移都不会报错、只会静默少一个文件——那种
 * 故障要到 npm 安装后才暴露。故构建末尾按清单逐个断言，缺一个就失败在本地。
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";

const pkgRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configFile: string = resolve(pkgRoot, "vite.config.mts");
const distDir: string = resolve(pkgRoot, "dist");

/** 依次构建的目标：与 vite.config.mts 的 TARGETS 键一一对应（顺序即构建顺序）。 */
const BUNDLES: readonly string[] = ["lib-cjs", "lib-esm", "cli"];

/** 构建完成后 dist/ 必须存在的产物清单（对照 package.json 的 exports/types 与 bin/ezn.js）。 */
const REQUIRED: readonly string[] = ["index.js", "index.mjs", "index.d.ts", "index.d.mts", "cli.js"];

/** 构建全部产物；任何一步失败（含产物缺失）都以非零码退出，不留下半成品交付。 */
async function buildAll(): Promise<void> {
  rmSync(distDir, { recursive: true, force: true });
  for (const bundle of BUNDLES) {
    process.env["EZN_BUNDLE"] = bundle;
    console.error(`[ezn] 构建 ${bundle} ...`);
    await viteBuild({ configFile });
  }

  // 派生：index.d.mts → index.d.ts（exports.require.types；内容同源，见文件头）
  copyFileSync(resolve(distDir, "index.d.mts"), resolve(distDir, "index.d.ts"));

  const missing = REQUIRED.filter((name) => !existsSync(resolve(distDir, name)));
  if (missing.length > 0) {
    throw new Error(
      `[ezn] 构建产物缺失：${missing.join("、")}\n` +
        `  dist/ 应有：${REQUIRED.join("、")}\n` +
        "  产物名与入口基名（entryFileNames 的 [name]）、dts 命名规则绑定，改过请同步 `npm run build` 的校验清单。",
    );
  }
  console.error(`[ezn] 构建完成：${REQUIRED.join("、")}`);
}

await buildAll();
