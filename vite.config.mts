/** @file ezn 发布版构建配置（vite 8 / rolldown）：产出标准 npm 包形态的 dist/（CJS/ESM 双入口 + CLI bundle）。
 * @fileoverview
 *
 * 为什么用 vite 而非 tsdown：两者底层同为 rolldown（Rust）——迁移不改变产物语义，收益是工具链
 * 统一：与仓库其余包（app/cli 等）共用同一打包引擎与同一套配置模式。vite 8 起生产打包已是
 * rolldown，本包三个产物实测构建在百毫秒级。
 *
 * **三个产物各自一次构建**（`EZN_BUNDLE` 环境变量切换，构建期变量、不是产品配置）：
 *   `lib-cjs`（缺省）  src/index.ts → dist/index.js    公共 API，CJS（exports 的 require 条件）
 *   `lib-esm`          src/index.ts → dist/index.mjs   公共 API，ESM（exports 的 import 条件）
 *   `cli`              src/cli.ts   → dist/cli.js      `ezn` 命令（bin/ezn.js 动态加载）
 * 为什么不做成一次多入口/多格式：rolldown 关闭 code splitting 时只接受单入口，而「每个产物
 * 自包含」是发布契约（见下 2）；故每个入口一次构建、共用这一份配置。驱动方是 scripts/build.mts。
 *
 * 关键契约（缺一不可；改这里必须同步改 package.json 的 exports/types 与 bin/ezn.js）：
 *   1. **产物名由入口基名固定推导**（entryFileNames 用 `[name]` 模板）：入口路径在下面的
 *      TARGETS 里写死（src/index.ts / src/cli.ts），故产物名恒为 index.js / index.mjs /
 *      cli.js——package.json 的 exports/types 与 bin/ezn.js 硬编码加载的路径都钉着它们。
 *      ⚠️ 不能把 entryFileNames 写成具体的文件名（如 "cli.js"）：dts 插件靠这个模板推导声明
 *      产物名，无 `[name]` 占位符时会推错（实测产出 index.mts 而非 index.d.mts）。产物是否
 *      齐全由 scripts/build.mts 统一校验，名字一旦漂移构建即失败。
 *   2. **单入口 + 关闭 code splitting**：不关的话共享代码会被抽成独立 chunk，破坏「每个产物
 *      自包含」；rolldown 要求单入口才能关。
 *   3. **全量内联（`ssr.noExternal: true`）**：发布契约是「零依赖自包含」——bin/ezn.js 加载的
 *      产物不引用包外任何文件（node 内置模块除外，由 ssr 构建自动 external）。故 package.json
 *      的 dependencies 为空：got/tar/yauzl（含传递依赖）在构建期打进产物，消费者不再
 *      单独安装它们（三个包只列在 devDependencies，供构建使用）。
 *   4. **版本号经 define 烧进产物**（`__EZN_VERSION__`）：`ezn --version` 读的就是它。发布脚本
 *      因此必须「先 bump 再构建」——见 scripts/release.mts 的顺序约束。
 *   5. **类型声明由 rolldown-plugin-dts 生成**（vite 自身不做 dts），且只在 ESM 目标生成：
 *      插件拒绝 CJS 输出格式（其 README 的 Limitations），而声明内容本无格式之分。产
 *      dist/index.d.mts；dist/index.d.ts（exports 的 require 条件的 types）由编排脚本按同
 *      内容复制而来。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dts } from "rolldown-plugin-dts";
import { defineConfig, type ConfigEnv, type UserConfig } from "vite";

const pkgRoot: string = dirname(fileURLToPath(import.meta.url));
const pkg: { version: string } = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf-8"));

/** 一个构建目标的静态描述。 */
interface BundleTarget {
  /** 入口源文件（相对包根） */
  entry: string;
  /** 产物模块格式：与 package.json exports 条件、bin/ezn.js 的加载方式一一对应 */
  format: "cjs" | "es";
  /** 产物名模板（`[name]` = 入口文件基名），见契约 1 */
  outName: string;
  /** 语法降级基线：lib 按壳包基线 node16；CLI 由宿主 node 加载，取 node18 */
  target: "node16" | "node18";
  /** 是否生成类型声明（只有公共 API 需要；且只能在 ESM 目标生成，见契约 5） */
  withDts: boolean;
}

/** 三个产物 → 构建参数（`EZN_BUNDLE` 按名字选择，见文件头）。 */
const TARGETS: Record<string, BundleTarget> = {
  "lib-cjs": { entry: "src/index.ts", format: "cjs", outName: "[name].js", target: "node16", withDts: false },
  "lib-esm": { entry: "src/index.ts", format: "es", outName: "[name].mjs", target: "node16", withDts: true },
  cli: { entry: "src/cli.ts", format: "cjs", outName: "[name].js", target: "node18", withDts: false },
};

/** 取本次要构建的目标；未设置或拼错时给出可操作的报错（而非静默产一个无关产物）。 */
function selectedTarget(): BundleTarget {
  const name: string = process.env["EZN_BUNDLE"] ?? "lib-cjs";
  const target = TARGETS[name];
  if (!target) {
    throw new Error(
      `[ezn] 未知的构建目标 EZN_BUNDLE=${JSON.stringify(process.env["EZN_BUNDLE"])}\n` +
        `  可选值：${Object.keys(TARGETS).join(" | ")}（缺省 lib-cjs）\n` +
        "  构建请走 `npm run build`（scripts/build.mts 会依次驱动三个目标，勿单独裸跑 vite build）。",
    );
  }
  return target;
}

/**
 * 配置导出为**函数**：仅为拿到 vite 的 `command` 以拦截误用（见下）；build 段本身是静态的。
 */
export default defineConfig((env: ConfigEnv): UserConfig => {
  // 本包**没有 web 入口**：vite 只用来构建 Node bundle（dist/index.js / index.mjs / cli.js），
  // 那份契约全在下面返回的 build 段里——而 `vite`（dev 命令，即 command === "serve"）**不读 build 段**，
  // 裸跑只会把本包当浏览器项目起一个 localhost:5173 的空 dev server（不含任何库/CLI 代码）。
  // 故在此拦截：免得误以为「正在开发」而实际什么都没跑。改库源码后直接跑测试即可（测试
  // 经 src/ 源码导入，无需先构建）；跑 CLI 用 `node bin/ezn.js`（需先构建一次）。
  if (env.command === "serve") {
    throw new Error(
      "[ezn] 本包无 web 入口，vite 只用于 `vite build`（由 scripts/build.mts 驱动）。请用：npm run build",
    );
  }
  const target = selectedTarget();
  return {
    ssr: {
      target: "node",
      // 全量内联（见契约 3）：默认规则只把 dependencies external 掉，而本包依赖为空、产物
      // 必须自包含——故显式 noExternal: true，不让发布形态依赖 vite 默认行为的稳定性。
      noExternal: true,
    },
    // 版本号注入（契约 4）：对 lib 产物是无副作用的 no-op（源码里没有该标识符）。
    define: { __EZN_VERSION__: JSON.stringify(pkg.version) },
    // oxc 转换要跳过声明文件：dts 插件会在构建里把生成的 .d.ts 当模块加载，而 vite 默认的
    // 转换 include（/\.(m?ts|[jt]sx)$/）恰好也匹配 .d.ts——`declare class` 等类型层语句经
    // 转换后整体消失，声明 bundle 随即报 MISSING_EXPORT（实测踩过）。exclude 会**整体替换**
    // 默认值，故把 vite 默认排除的 /\.js$/ 一并写上（同 rolldown-plugin-dts README 的提示）。
    oxc: { exclude: [/\.js$/, /\.d\.[cm]?ts$/] },
    plugins: target.withDts
      ? [
          dts({
            // 生成器用默认（未开 isolatedDeclarations 时为 tsc）；entry 取 rolldown 入口
            // （src/index.ts），声明名由上面的 entryFileNames 模板推导出 index.d.mts；
            // index.d.ts 的复制见 scripts/build.mts（契约 5）。
          }),
        ]
      : [],
    build: {
      ssr: resolve(pkgRoot, target.entry),
      outDir: resolve(pkgRoot, "dist"),
      // 三个目标共写 dist/，任一都不许清空别人的产物（清理由编排脚本统一负责）
      emptyOutDir: false,
      target: target.target,
      sourcemap: false,
      // 内联后必须 minify（vite 的 SSR 构建默认 false）：依赖代码（got/tar/yauzl 及其
      // 传递依赖）会打进**每个**产物，不压缩时三个产物合计约 1.4MB，压缩后约 690KB。产物里
      // 本包自身代码占比很小，报错栈可读性的让位是有意的。
      minify: true,
      rolldownOptions: {
        output: {
          format: target.format,
          entryFileNames: target.outName,
          codeSplitting: false, // 单入口下合法（见契约 2）
        },
      },
    },
  };
});
