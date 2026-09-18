/**
 * @file Node 运行时工具类（ezllm 内部包 ezllm-node 的实现主体）。
 * @fileoverview
 * 单一布局：运行时根恒为 `<appDir>/node`（nvm 同构，无版本目录层），无状态幂等。该目录同时是
 * **包的安装位置**（Windows `<rt>/node_modules/ezllm`、POSIX `<rt>/lib/node_modules/ezllm`），
 * 与 node 自带包同处一个共享目录——故落位一律逐条目进行、共享目录按子项合并，**绝不整目录
 * 让位或清空**（否则已装的托管包被抹掉，服务随即找不到自身入口 `server.js`）。落位见 `./install.ts`。
 *
 * `nodeVersion` 与 args 的语义、环境变量、PATH 注入等约定，见各方法自身的 JSDoc。
 *
 * 进度与过程提示 `console.error` 中文直出（调用方为唯一消费方）；失败一律 throw，由调用方统一呈现。
 */

import { execFileSync, spawnSync } from "node:child_process";
import type { SpawnOptions, SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { installNode } from "./install.js";
import { shellSafe, spawnAsync } from "./spawn.js";
import {
  isFlatRuntimeReady,
  matchNodeVersion,
  nodeExecPath,
  resolveBundledCli,
  resolveRuntimeCommand,
  runtimePathPrefix,
} from "./runtime.js";

// 执行原语已下沉到 ./spawn.ts（`n` 命令共用同一套 shell 引用与输出收集语义）；此处原样再导出，
// 使公共 API 面（src/index.ts 只从本文件导出）与其导入路径保持不变。
import type { SpawnAsyncResult } from "./spawn.js";
export type { SpawnAsyncResult };

const IS_WIN = process.platform === "win32";

/**
 * 把 args 归一为 token 数组。
 *
 * @param args - 字符串（命令行写法，按空白拆分）或数组（精确 argv，原样复制）
 * @returns token 数组（字符串形式已滤除空项）
 */
function splitTokens(args: string | readonly string[]): string[] {
  if (typeof args !== "string") return [...args];
  return args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * 某个 Node 运行时的执行封装。
 *
 * 实例由 {@link Node.ensure} 装配（或直接 `new Node(nodePath, rt)` 用于测试）。除 `path`/`rt` 外的
 * 属性与方法语义见各自 JSDoc。
 */
export class Node {
  /** node 可执行文件绝对路径 */
  path: string;
  /** 运行时根：决定 `npmCliPath`/`npxCliPath` 的解析位置，也用于前置子进程 PATH */
  rt: string;

  /**
   * @param nodePath - node 可执行文件绝对路径
   * @param rt - 运行时根目录
   */
  constructor(nodePath: string, rt: string) {
    this.path = nodePath;
    this.rt = rt;
  }

  /**
   * 自带 npm 的 CLI 入口（`node npm-cli.js` 形式，跨平台免 `.cmd` shim）。
   *
   * 刻意不走 `<rt>/npm.cmd`：该 shim 会查全局 prefix，若宿主存在另一份 npm 就会被劫持
   * （实测宿主 nvm 环境下 `.cmd` 跑到 10.9.3，而本运行时自带的是 11.19.0）。
   * 入口路径按平台布局解析：Windows 在 `<rt>/node_modules/npm`，POSIX 在 `<rt>/lib/node_modules/npm`。
   *
   * @returns npm-cli.js 的绝对路径
   * @throws 该运行时缺自带 npm 时抛可操作错误（列出候选路径与恢复方式）
   */
  get npmCliPath(): string {
    return resolveBundledCli(this.rt, "npm");
  }

  /** 自带 npx 的 CLI 入口（与 {@link npmCliPath} 同源，npx 随 npm 包发布）。 */
  get npxCliPath(): string {
    return resolveBundledCli(this.rt, "npx");
  }

  /**
   * 执行 `node -v` 解析主版本。
   *
   * @returns 主版本号；不可执行时返回 null（不抛错）
   */
  get major(): number | null {
    return Node.probeMajor(this.path);
  }

  /**
   * 把 args 解析为 argv（可执行恒为本运行时的 node 本体；npm/npx 经 node + 自带 `*-cli.js` 形式执行）。
   *
   * 字符串形式 = 命令行写法：按空白拆分，首 token 为 `node`/`npm`/`npx` 时切换到对应 CLI 并去掉该
   * token，其余情况整串作为 `fallbackCli` 的参数；数组形式 = 精确 argv（每项一个参数，不做分发）。
   * 含空格/引号的参数请用数组形式。
   *
   * @param args - 上述两种形式的任一
   * @param fallbackCli - 首 token 未被识别时使用的默认可执行（null = 本运行时 node 本体）
   * @returns 传给 spawn 的参数数组
   * @throws args 为空（无有效 token）时抛错
   */
  private resolveArgs(args: string | readonly string[], fallbackCli: string | null): string[] {
    const tokens = splitTokens(args);
    if (tokens.length === 0) throw new Error("命令为空");
    const first = tokens[0] as string; // tokens 非空，元素必为 string（splitTokens 已滤空）
    const rest = tokens.slice(1);
    if (first === "node") return rest;
    if (first === "npm") return [this.npmCliPath, ...rest];
    if (first === "npx") return [this.npxCliPath, ...rest];
    return fallbackCli === null ? tokens : [fallbackCli, ...tokens];
  }

  /**
   * 解析 `exec`/`execSync` 的执行目标。首 token 为命令名，按下列顺序解析：
   *
   * 1. `node` / `npm` / `npx` → 本运行时的对应可执行（npm/npx 走 node + 自带 `*-cli.js`）
   * 2. 其余名字 → 先在**运行时目录**下找同名可执行（`npm i -g` 装的 shim 落在 `<rt>/nve`、
   *    `<rt>/nve.cmd`），找到就直接执行它——这正是 `exec("nve -v")` 能跑通的依据
   * 3. 都没命中 → 回落到原语义：以本运行时 node 本体执行，全部 token 作为 node 的参数
   *    （保住 `exec(["-e", "..."])`、`exec("-v")` 这类用法）
   *
   * Windows 的 `.cmd`/`.bat` 必须经 shell（Node 20+ 直接 spawn 报 `EINVAL`，属安全策略），shell
   * 模式下参数需自行引用；并把 rt 前置进 PATH，使命令内部调 node/npm 时命中本运行时。
   *
   * @param args - 字符串或数组形式（语义同 {@link resolveArgs}）
   * @param options - 调用方的 spawn 选项（仅取 `env` 用于派生 PATH）
   * @returns `{ file, argv, shell, env }`，直接喂给 spawn/spawnSync
   * @throws args 为空时抛错
   */
  private resolveExec(args: string | readonly string[], options: SpawnOptions | SpawnSyncOptions) {
    const tokens = splitTokens(args);
    if (tokens.length === 0) throw new Error("命令为空");
    const first = tokens[0] as string; // 长度已校验非空
    const rest = tokens.slice(1);
    const env = this.childEnv(options.env);

    if (first === "node") return { file: this.path, argv: rest, shell: false, env };
    if (first === "npm") return { file: this.path, argv: [this.npmCliPath, ...rest], shell: false, env };
    if (first === "npx") return { file: this.path, argv: [this.npxCliPath, ...rest], shell: false, env };

    const hit = resolveRuntimeCommand(this.rt, first);
    if (hit !== null) {
      // Windows 的 .cmd/.bat 经 shell 执行；.exe 与 POSIX 脚本直接 spawn（免一层 shell 开销）
      const shell = IS_WIN && /\.(cmd|bat)$/i.test(hit);
      const [file, argv] = shellSafe(hit, rest, shell);
      return { file, argv, shell, env };
    }
    return { file: this.path, argv: tokens, shell: false, env };
  }

  /**
   * 派生子进程 env：把运行时根前置到 PATH（Windows 另含 `<rt>/node_modules/.bin`），使被执行的
   * 命令内部再调 node/npm 时命中本运行时的版本。
   *
   * @param explicit - 调用方显式传入的 env；缺省用 `process.env`
   * @returns 前置了运行时 PATH 的新 env 对象（不修改 `explicit`）
   */
  private childEnv(explicit?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const base = explicit ?? process.env;
    return { ...base, PATH: runtimePathPrefix(this.rt) + (base.PATH ?? base.Path ?? "") };
  }

  // —— node 本体（运行时目录下有同名命令时优先执行它，见 resolveExec）——

  /**
   * 同步执行命令（同步版；执行目标解析见 {@link resolveExec}）。
   *
   * @param args - 字符串或数组形式
   * @param options - spawnSync 选项（`windowsHide`、`encoding:"utf8"` 默认开启）
   * @returns spawnSync 结果对象；`stdout` 默认按 utf8 解码（可用 `encoding:"buffer"` 覆盖）
   */
  execSync(args: string | readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string> {
    const { file, argv, shell, env } = this.resolveExec(args, options ?? {});
    return spawnSync(file, argv, {
      windowsHide: true,
      encoding: "utf8",
      ...options,
      shell,
      env,
    }) as SpawnSyncReturns<string>;
  }

  /**
   * 异步执行命令（异步版；执行目标解析见 {@link resolveExec}）。
   *
   * @param args - 字符串或数组形式
   * @param options - spawn 选项
   * @returns 输出收集完后的结果（stdio 非 pipe 时为 null）
   */
  exec(args: string | readonly string[], options?: SpawnOptions): Promise<SpawnAsyncResult> {
    const { file, argv, shell, env } = this.resolveExec(args, options ?? {});
    return spawnAsync(file, argv, { ...options, shell, env });
  }

  // —— 自带 npm / npx ——

  /**
   * 以自带 npm 同步执行（`node npm-cli.js` 形式，避开 `.cmd` shim 的 prefix 劫持）。
   *
   * @param args - 字符串或数组形式；首 token 为 `npm` 时会被去掉
   * @param options - spawnSync 选项
   * @returns spawnSync 结果对象
   */
  npmSync(args: string | readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string> {
    return spawnSync(this.path, this.resolveArgs(args, this.npmCliPath), {
      windowsHide: true,
      encoding: "utf8",
      ...options,
    }) as SpawnSyncReturns<string>;
  }

  /**
   * 以自带 npm 异步执行。
   *
   * @param args - 字符串或数组形式
   * @param options - spawn 选项
   * @returns 输出收集完后的结果
   */
  npm(args: string | readonly string[], options?: SpawnOptions): Promise<SpawnAsyncResult> {
    return spawnAsync(this.path, this.resolveArgs(args, this.npmCliPath), options);
  }

  /**
   * 以自带 npx 同步执行。
   *
   * @param args - 字符串或数组形式
   * @param options - spawnSync 选项
   * @returns spawnSync 结果对象
   */
  npxSync(args: string | readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string> {
    return spawnSync(this.path, this.resolveArgs(args, this.npxCliPath), {
      windowsHide: true,
      encoding: "utf8",
      ...options,
    }) as SpawnSyncReturns<string>;
  }

  /**
   * 以自带 npx 异步执行。
   *
   * @param args - 字符串或数组形式
   * @param options - spawn 选项
   * @returns 输出收集完后的结果
   */
  npx(args: string | readonly string[], options?: SpawnOptions): Promise<SpawnAsyncResult> {
    return spawnAsync(this.path, this.resolveArgs(args, this.npxCliPath), options);
  }

  /**
   * 执行 `node -v` 解析主版本。
   *
   * @param nodePath - node 可执行文件路径
   * @returns 主版本号；不可执行（不存在/非可执行/超时）时返回 null
   */
  static probeMajor(nodePath: string): number | null {
    try {
      const out = execFileSync(nodePath, ["-v"], { encoding: "utf8", timeout: 15000, windowsHide: true });
      const m = String(out)
        .trim()
        .match(/^v(\d+)\./);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  /**
   * 总入口：确保自带 Node 运行时就绪（探测 / 复用 / 重装 / 下载安装），返回实例。
   *
   * 单一布局，运行时根恒为 `<appDir>/node`（nvm 同构）。已达标（node 在位 + 自带 npm 在位）则直接
   * 复用、零落位；否则交由 `installNode` 逐条目落位、共享目录按子项合并——**绝不整目录让位或清空**
   * （rt 内躺着 npm 装好的托管包，挪走就等于让服务找不到自身入口，详见文件头注）。
   *
   * 环境变量 `ELLM_NODE_BIN` 为逃生口：指定一个现成的 Node 可执行文件，跳过下载与重装（返回实例的
   * `rt` 仍为 `<appDir>/node`，即 CLI 解析位置不变）。`ELLM_NODE_MIRROR` 指定私有镜像。
   *
   * @param appDir - 应用根目录（运行时落在其下的 `node/`），相对路径会被 resolve 成绝对路径
   * @param nodeVersion - `"18"` | `"18.1"` | `"18.1.5"`（1~3 段数字），在内置表内按组件级前缀匹配
   * @returns 就绪的 {@link Node} 实例
   * @throws nodeVersion 格式非法或无匹配；`ELLM_NODE_BIN` 指向的 Node 不存在或不可执行；下载/落位失败
   */
  static async ensure(appDir: string, nodeVersion: string): Promise<Node> {
    const dir = resolve(appDir); // 相对路径统一转绝对（解压器要求绝对目标目录）
    const fullVersion = matchNodeVersion(nodeVersion);
    const major = Number(fullVersion.replace(/^v/, "").split(".")[0]);
    const rt = join(dir, "node");
    const nodePath = nodeExecPath(rt);

    const override = process.env.ELLM_NODE_BIN;
    if (override) {
      if (!existsSync(override)) throw new Error(`ELLM_NODE_BIN 指定的 Node 不存在：${override}`);
      const overrideMajor = Node.probeMajor(override);
      if (overrideMajor === null) throw new Error(`ELLM_NODE_BIN 指定的 Node 无法执行：${override}`);
      if (overrideMajor < major) {
        console.error(
          `[ezllm-node] 警告：ELLM_NODE_BIN 的 Node 主版本为 ${overrideMajor}，低于建议值 ${major}，按用户指定继续。`,
        );
      }
      console.error(`[ezllm-node] Node 运行时（ELLM_NODE_BIN）：${override}`);
      return new Node(override, rt);
    }

    if (existsSync(nodePath)) {
      const current = Node.probeMajor(nodePath);
      // 还要求自带 npm 在位：落位是逐条目进行的、失败保留现场（不回滚），可能停在「node 已就位、
      // 自带 npm 还没搬进来」的半成品状态——只按 node 判定就会把它当就绪复用，缺的 npm 永远补不上。
      const ready = current !== null && current >= major && isFlatRuntimeReady(rt);
      if (ready) {
        console.error(`[ezllm-node] Node 运行时就绪：${nodePath}`);
        return new Node(nodePath, rt);
      }
      if (current === null) {
        console.error("[ezllm-node] 已有 Node 运行时无法执行（疑似损坏），准备重新安装 ...");
      } else if (current < major) {
        console.error(`[ezllm-node] 已有 Node 运行时主版本为 ${current}，低于要求 ${major}，准备重装 ...`);
      } else {
        console.error("[ezllm-node] 已有 Node 运行时缺少自带 npm（上次落位可能中断），准备补齐 ...");
      }
      // 不整目录让位/清空——rt 内躺着 npm 装好的托管包，挪走就等于让服务找不到自身入口；
      // 由 installNode 逐条目落位、共享目录按子项合并兜底（见 ./install.ts）。
    }
    await installNode(rt, nodeVersion);
    return new Node(nodePath, rt);
  }
}
