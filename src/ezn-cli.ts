/**
 * @file `ezn` 命令：在固定版本的托管 Node 上执行任意命令（`npx nve 22` 的自研替代（命令名 ezn，避免与 tj/n 混淆））。
 * @fileoverview
 * 只做两件事的拼接，**不引入任何新的下载/落位逻辑**：
 * 1. 版本解析 → `matchNodeVersion`（内置版本表，1~3 段数字按组件级前缀匹配）
 * 2. 运行时就绪 → `installNode`（逐条目落位、绝不误删既有文件）
 *
 * 落位布局（**项目根下的 node/，与 node 官方发行包同构**）：
 * ```
 * <项目>/node/node.exe            ← 目录名可用 ezn.dir 改写
 * ```
 * 项目根 = 向上就近找到的那个配置了 `ezn.node` 的 `package.json` 所在目录。默认与官方发行
 * 包、以及上游服务端托管运行时所用的同一套布局（`<appDir>/node/node.exe`）同构，
 * 故整个项目只有一处「托管 Node」概念，不再有版本目录层。
 *
 * 版本只在 `package.json` 的 `ezn.node` 里声明一次（自 cwd 向上就近查找），命令行不接
 * 版本参数——一个项目一个版本，故目录不按版本分层、也不存在「版本与命令撞名」的歧义。要换版本
 * 就改配置；换版本后 `installNode` 按逐条目安全语义覆盖（同名项备份后替换、共享目录按子项合并，
 * 绝不误删既有文件）。
 *
 * 为什么落在项目内（而非系统缓存）：开箱即用——clone 下来跑一次即可，运行时与项目同生命周期；
 * 也便于直接查看/清理（删掉 `node/` 即可）。代价是每个项目各一份，且**必须**在 .gitignore
 * 里忽略它（本包 README 已写明），否则约 100MB 的运行时会被 git 追踪。
 *
 * 本模块由 `bin/ezn.js` 动态加载（dist/ezn.js）；导出 `main(argv)` 供薄启动器与单测调用。
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { installNode } from "./install.js";
import { matchNodeVersion, nodeExecPath, nodePlatformKey, resolveBundledCli } from "./runtime.js";
import { shellSafe, spawnInherit } from "./spawn.js";

const IS_WIN = process.platform === "win32";

/** 构建期注入的本包版本号（见 scripts/build.mjs 的 define）。 */
declare const __EZN_VERSION__: string;

/** 冷缓存下并发抢锁的等待上限：超过即视为持锁进程已死，夺锁重试（毫秒）。 */
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;

/** 抢锁失败后的轮询间隔（毫秒）。 */
const LOCK_POLL_MS = 500;

/** 项目根下落位的默认目录名（与服务端托管运行时约定一致：`<appDir>/node`）。 */
const RUNTIME_DIR_NAME = "node";

/**
 * 项目根目录：运行时落位到它下面。
 *
 * 取自向上就近找到的那个配置了 `ezn` 的 package.json 所在目录；一路到盘根都没配置时
 * 回落到 startDir（此时 `parseInvocation` 会给出可操作错误，不会走到落位）。
 *
 * @param startDir - 起始目录（缺省 cwd；显式传入供单测隔离，避免落到真实仓库目录）
 * @returns 项目根目录绝对路径
 */
export function projectRoot(startDir: string = process.cwd()): string {
  const start = resolve(startDir);
  return resolveConfiguredNode(start)?.root ?? start;
}

/**
 * 解析出运行时目录（`<项目根>/<ezn.dir | "node">`）。
 *
 * 目录不随版本变化：`get-node`/nve 那种「缓存多版本」的形态在这里不需要——版本由
 * `ezn.node` 唯一定义，`installNode` 落位时按逐条目安全语义覆盖旧运行时即可。
 * `platformKey` 仍返回，供诊断与锁名区分异构目标。
 *
 * 目录名由 `ezn.dir` 决定（省略则用默认的 `node`）。**只接受相对路径**：绝对路径与 `..`
 * 逃逸都拒绝——安装位置恒在所配置项目内，与「运行时随项目走、删目录即清理」的取舍保持一致。
 *
 * @param spec - 版本描述（"22" | "22.13" | "22.13.0"）
 * @param startDir - 起始目录（缺省 cwd；显式传入供单测隔离，避免落到真实仓库目录）
 * @returns 精确版本、平台键与运行时目录
 * @throws 版本格式非法或内置表无匹配（透传 `matchNodeVersion` 的可操作错误）
 */
export function resolveRuntimeDir(
  spec: string,
  startDir: string = process.cwd(),
): { version: string; platformKey: string; dir: string } {
  const version = matchNodeVersion(spec);
  const platformKey = nodePlatformKey();
  const start = resolve(startDir);
  const configured = resolveConfiguredNode(start);
  const root = configured?.root ?? start;

  // 目录名合法性：只允许项目内的相对路径
  const name = configured?.config.dir;
  if (name && (isAbsolute(name) || name.split(/[\\/]/).includes(".."))) {
    throw new Error(
      `ezn.dir 只接受项目内的相对路径（如 "runtime" / ".node"），收到：${name}\n` +
        "运行时随项目走（删目录即清理），故不允许指向项目之外。",
    );
  }

  return { version, platformKey, dir: join(root, name ?? RUNTIME_DIR_NAME) };
}

/**
 * 运行时是否已就绪（可跳过落位直接复用）。
 *
 * 判据是 **node 可执行文件在位**（`<项目>/node/node.exe`，与 `Node.ensure` 扁平布局一致）；
 * 自带 npm 的完整性由 `Node.ensure` 的既有判定负责，此处不重复实现，免生两套漂移的判据。
 *
 * @param dir - 运行时目录
 * @returns 是否可直接复用
 */
export function isReady(dir: string): boolean {
  return existsSync(nodeExecPath(dir));
}

/**
 * 跨进程串行化落位：目录锁（`mkdir` 原子）。
 *
 * 为什么必须有：`pnpm -r test` 会同时拉起多个 `ezn`，冷缓存下它们并发落位**同一个**目录——
 * `installNode` 的逐条目落位遇到同名项是「备份后覆盖」，两进程交错会把对方刚搬进来的文件
 * 备份走，最终留下半成品。抢不到锁的进程轮询等待（持锁者装完即复用，不重复下载）。
 *
 * @param lockDir - 锁目录路径
 * @param nodeDir - 运行时目录
 * @param done - 就绪判据（轮询期间命中即可提前返回）；缺省为 `isReady`（node 是否在位）——
 *   装工具时须传入工具自己的判据，否则 node 一就绪就会立刻提前返回、等于没锁
 * @returns 拿到锁时 true；观察到就绪而提前返回时 false（无需自己落位）
 */
export async function acquireLock(
  lockDir: string,
  nodeDir: string,
  done: () => boolean = () => isReady(nodeDir),
): Promise<boolean> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  // 父目录（版本目录）首次运行时尚不存在，必须先建：否则下面的 mkdirSync 直接 ENOENT。
  // 父目录本身带 recursive（允许并发创建），锁目录**不带**——recursive 模式下「已存在」不再抛
  // EEXIST，原子性就没了（那正是抢锁的判据）。
  mkdirSync(dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir); // 原子：已存在则抛 EEXIST
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (done()) return false; // 持锁者已装完，直接复用
    if (Date.now() > deadline) {
      // 持锁进程疑似已死（正常落位远短于此）：夺锁重试，避免永久卡死
      console.error(`[ezn] 等待落位锁超时（${Math.round(LOCK_TIMEOUT_MS / 60000)} 分钟），夺锁重试 ...`);
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    await new Promise((tick) => setTimeout(tick, LOCK_POLL_MS));
  }
}

/**
 * 确保某个版本的托管 Node 就绪（复用 / 加锁落位），并按配置补齐 `ezn.tools` 声明的工具。
 *
 * 逃生口 `ezn.nodeBin`（与库的 `Node.ensure` 同一语义）：显式指定一个现成的 node 可执行文件，
 * 跳过复用判定与下载落位。此时的 `dir` 取该可执行文件所在目录——它决定子进程 PATH 的前缀，
 * 即「命令内部再调 node 时命中哪一份」。
 *
 * 工具装配（`ezn.tools`）在 node 就绪**之后**进行，且失败只警告不抛出——工具是锦上添花，
 * 断网不该让整个命令跑不起来（缺 pnpm 时 `resolveCommand` 仍会回落到宿主 PATH 的那份）。
 *
 * @param spec - 版本描述（"22" | "22.13" | "22.13.0"）
 * @param startDir - 起始目录（缺省 cwd；显式传入供单测隔离，避免落到真实仓库目录）
 * @returns 精确版本、运行时目录（PATH 前缀来源）、node 可执行文件绝对路径
 * @throws 版本非法/无匹配；`ezn.nodeBin` 指向的 node 不存在；平台不支持；下载失败；落位失败
 */
export async function ensureRuntime(
  spec: string,
  startDir: string = process.cwd(),
): Promise<{ version: string; dir: string; nodePath: string }> {
  const { version, dir } = resolveRuntimeDir(spec, startDir);
  const config = resolveConfiguredNode(resolve(startDir))?.config;
  const mirror = config?.mirror ?? null;

  const override = config?.nodeBin ?? null;
  if (override) {
    const nodePath = resolve(override);
    if (!existsSync(nodePath)) throw new Error(`ezn.nodeBin 指定的 Node 不存在：${nodePath}`);
    console.error(`[ezn] 使用 ezn.nodeBin 指定的 Node：${nodePath}`);
    await ensureTools(dir, config?.tools ?? {});
    return { version, dir: dirname(nodePath), nodePath };
  }

  const nodePath = nodeExecPath(dir);
  if (!isReady(dir)) {
    const lockDir = `${dir}.lock`; // 与运行时目录同级：并发落位共抢一把锁
    const gotLock = await acquireLock(lockDir, dir);
    try {
      // double-check：等锁期间别的进程可能已装好
      if (!isReady(dir)) {
        console.error(`[ezn] 正在准备 Node ${version}（安装到：${dir}）...`);
        // 传原始版本描述：installNode 内部自行解析（勿传已解析的 vX.Y.Z）
        await installNode(dir, spec, { mirror });
      }
    } finally {
      if (gotLock) rmSync(lockDir, { recursive: true, force: true });
    }
  }

  await ensureTools(dir, config?.tools ?? {});
  return { version, dir, nodePath };
}

/**
 * 补齐 `ezn.tools` 声明的工具（缺则用运行时自带 npm 装，版本不符则重装）。
 *
 * 为什么锁与 node 落位分开：本函数的判据是「工具是否已装」，而 `acquireLock` 的判据是
 * `isReady(dir)`（node 是否在位）——node 已就绪时复用同一把锁会**立刻提前返回**，
 * 等于没锁（`pnpm -r test` 并发拉起多个 ezn 会同时装同一个工具）。故另立 `<dir>.tools.lock`。
 *
 * 装法是 `node <npm-cli.js> install -g --prefix <dir>`：刻意避开 `<dir>/npm.cmd` shim（那个 shim
 * 会去查全局 prefix，宿主存在另一份 npm 时会被劫持），且装进运行时目录而非宿主全局目录。
 *
 * @param dir - 运行时目录（npm 的 `--prefix`，也是 ezn 命令解析的首候选）
 * @param tools - 包名 → 版本描述（来自 `ezn.tools`）
 * @returns 无（失败只警告，不抛出）
 */
async function ensureTools(dir: string, tools: Readonly<Record<string, string>>): Promise<void> {
  const entries = Object.entries(tools);
  if (entries.length === 0) return;

  const missing = entries.filter(([name, spec]) => !toolReady(dir, name, spec));
  if (missing.length === 0) return;

  const lockDir = `${dir}.tools.lock`;
  const gotLock = await acquireLock(lockDir, dir, () => missing.every(([name, spec]) => toolReady(dir, name, spec)));
  try {
    // double-check：等锁期间别的进程可能已装好
    for (const [name, spec] of missing) {
      if (toolReady(dir, name, spec)) continue;
      const args = ["install", "-g", "--prefix", dir, `${name}@${spec}`, "--ignore-scripts"];
      console.error(`[ezn] 正在安装工具 ${name}@${spec}（装到：${dir}）...`);
      try {
        const npmCli = resolveBundledCli(dir, "npm");
        await spawnInherit(nodeExecPath(dir), [npmCli, ...args], { env: { ...process.env, PATH: childPath(dir) } });
      } catch (err) {
        console.error(
          `[ezn] 工具 ${name}@${spec} 安装失败（不影响本次命令）：${err instanceof Error ? err.message : String(err)}`,
        );
        return; // 一个装不上就停：继续试别的只会重复报同类错误
      }
      if (!toolReady(dir, name, spec)) {
        console.error(`[ezn] 工具 ${name}@${spec} 安装后未就位（${toolPackageDir(dir, name)}），跳过`);
        return;
      }
      console.error(`[ezn] 工具 ${name}@${spec} 已就绪`);
    }
  } finally {
    if (gotLock) rmSync(lockDir, { recursive: true, force: true });
  }
}

/** 工具全局包在运行时目录下的落点（npm 全局 prefix 的平台差异，对照 `bundledCliCandidates`）。
 *  @param dir - 运行时目录
 *  @param name - 包名
 *  @returns 包目录绝对路径（优先 Windows 布局，不存在时返回该候选） */
function toolPackageDir(dir: string, name: string): string {
  const candidates = [join(dir, "node_modules", name), join(dir, "lib", "node_modules", name)];
  return candidates.find((candidate) => existsSync(candidate)) ?? (candidates[0] as string);
}

/**
 * 工具是否已按期望版本装好。
 *
 * 判据是**包清单的 version 精确相等**，而不是跑 `<tool> -v`：工具的 `--version` 未必报出自身版本
 * （pnpm 12 起会因 `package.json` 的 `packageManager` 字段自我切换、报出的是另一份），
 * 用 `-v` 核对会得到假阳性。对照 `hostedPackageReady` 的同款取舍。
 *
 * @param dir - 运行时目录
 * @param name - 包名
 * @param spec - 版本描述（`"10.34.5"` 精确匹配；`"^10"` / `"~10"` 按前缀放行）
 * @returns 已装且版本相符时为 true */
function toolReady(dir: string, name: string, spec: string): boolean {
  try {
    const pkgPath = join(toolPackageDir(dir, name), "package.json");
    if (!existsSync(pkgPath)) return false;
    const installed = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown }).version;
    if (typeof installed !== "string") return false;
    return spec.startsWith("^") || spec.startsWith("~")
      ? installed === spec.slice(1) || installed.startsWith(`${spec.slice(1)}.`)
      : installed === spec;
  } catch {
    return false;
  }
}

/**
 * 在运行时目录中查找命令可执行文件（`<dir>/<name>{.cmd,.bat,.exe}` 与 `<dir>/node_modules/.bin/`）。
 *
 * @param dir - 运行时目录
 * @param name - 命令名（不含路径分隔符）
 * @returns 可执行文件绝对路径；未命中返回 null
 */
function resolveInRuntime(dir: string, name: string): string | null {
  const suffixes = IS_WIN ? [".cmd", ".bat", ".exe"] : [""];
  const candidates = suffixes.map((suffix) => join(dir, `${name}${suffix}`));
  candidates.push(join(dir, "node_modules", ".bin", name));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * 从 cwd 起逐级向上查找 `node_modules/.bin/<name>`。
 *
 * 用途：`ezn vitest run` 里的 `vitest` 由**项目**安装，`ezn` 自身不依赖它。经包管理器脚本调用时
 * PATH 里已有 `<包>/node_modules/.bin` 与根 `.bin`（实测），本函数对那种场景是冗余的；但直接在
 * shell 里裸调（不经 pnpm）时 PATH 里没有，得靠这里兜住。
 *
 * @param startDir - 起始目录（通常为 cwd）
 * @param name - 命令名
 * @returns 可执行文件绝对路径；一路到盘根都没找到则返回 null
 */
export function resolveInAncestors(startDir: string, name: string): string | null {
  const suffixes = IS_WIN ? [".cmd", ".exe", ".bat", ""] : [""];
  let current = resolve(startDir);
  for (;;) {
    for (const suffix of suffixes) {
      const candidate = join(current, "node_modules", ".bin", `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null; // 已到盘根
    current = parent;
  }
}

/**
 * 在 PATH 各目录里查找命令，按平台约定补全可执行后缀。
 *
 * 为什么必须做这一步（而不是把裸名直接交给子进程去查 PATH）：**Windows 上 Node 的 spawn 只认
 * `.exe`**，不认 `.cmd`/`.bat`。宿主装的 `pnpm` 是 `pnpm.CMD`，若把裸名 "pnpm" 交给 spawn，
 * 会以 ENOENT 失败（实测：`ezn pnpm -r test` 报「找不到命令：pnpm」）。先在这里解析出真实文件
 * 路径，才能让上层按扩展名判定「要不要经 shell」（见 `./spawn.ts` 的 `shellSafe`）。
 *
 * @param name - 命令名（不含路径分隔符）
 * @returns 可执行文件绝对路径；PATH 上未命中返回 null
 */
function resolveInPath(name: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
  const suffixes = IS_WIN ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      if (existsSync(candidate) && (IS_WIN || isExecutable(candidate))) return candidate;
    }
  }
  return null;
}

/** POSIX 下判断文件是否可执行（Windows 无此概念，恒由调用方绕过）。 */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析要执行的命令。
 *
 * 顺序（命中即返回）：
 * 1. `node` / `npm` / `npx` → 本运行时（`node.exe` 本体 / `node <npm-cli.js>`）——**显式分发**，
 *    有意绕过运行时根下的 `npm.cmd` shim：那个 shim 会去查全局 prefix，宿主存在另一份 npm 时
 *    就会被劫持（`node.ts` 的同名注释记着这条实测教训）。`npx` 随 npm 包发布，入口同源解析。
 * 2. 含路径分隔符 → 视为路径原样执行
 * 3. 运行时目录下的同名可执行
 * 4. 从 cwd 逐级向上找 `node_modules/.bin/<name>`
 * 5. PATH 查找（补全 `.cmd`/`.bat`/`.exe` 后缀）——`pnpm`、`git` 这类宿主安装的命令靠这步，
 *    Windows 上尤其必要，理由见 {@link resolveInPath}
 * 6. 保持裸名兜底（交给子进程按自身规则解析）
 *
 * @param dir - 运行时目录
 * @param name - 命令名或路径
 * @returns `{ file, prefixArgs }`：可执行文件与固定前置参数（npm/npx 为其 CLI 入口）
 */
export function resolveCommand(dir: string, name: string): { file: string; prefixArgs: string[] } {
  if (name === "npm" || name === "npx") {
    // 自带 CLI 入口缺失时（精简发行版）回落到 PATH 解析——不因缺 npm 而整体不可用
    const cli = [join(dir, "node_modules", "npm", "bin", `${name}-cli.js`), join(dir, "lib", "node_modules", "npm", "bin", `${name}-cli.js`)].find(
      (candidate) => existsSync(candidate),
    );
    if (cli) return { file: nodeExecPath(dir), prefixArgs: [cli] };
  }
  if (name.includes("/") || name.includes("\\")) return { file: name, prefixArgs: [] };
  const hit = resolveInRuntime(dir, name) ?? resolveInAncestors(process.cwd(), name) ?? resolveInPath(name);
  return { file: hit ?? name, prefixArgs: [] };
}

/**
 * 派生子进程 PATH：运行时根（及 Windows 的 `node_modules/.bin`）前置，其余原样保留。
 *
 * 前置是「固定版本」的兑现处——命令内部再调 `node`/`npm` 时命中本运行时；保留原 PATH 则让
 * `pnpm run` 注入的 `<包>/node_modules/.bin` 与根 `.bin` 继续可见，故 `ezn vitest run` 能在
 * 仓库内解析到 vitest。
 *
 * @param dir - 运行时目录
 * @param basePath - 原始 PATH（缺省取 process.env；供单测注入）
 * @returns 前置了运行时路径的 PATH 字符串
 */
export function childPath(dir: string, basePath?: string): string {
  const entries = IS_WIN ? [dir, join(dir, "node_modules", ".bin")] : [join(dir, "bin"), dir];
  const base = basePath ?? process.env.PATH ?? process.env.Path ?? "";
  return entries.join(delimiter) + delimiter + base;
}

/** `package.json` 里 `ezn` 段的形态。 */
export interface PinnedNode {
  /** 版本描述：`"22"` | `"22.13"` | `"22.13.5"`（1~3 段数字，须在内置版本表内） */
  node: string;
  /** 运行时安装目录（相对于配置所在目录）；未配置时为 null，表示用默认的 `<配置所在目录>/node` */
  dir: string | null;
  /** 要装进运行时的工具（包名 → 版本描述）；未配置时为空对象 */
  tools: Readonly<Record<string, string>>;
  /** 下载镜像（目录结构同 nodejs.org/dist）；未配置时为 null，走内置默认镜像链 */
  mirror: string | null;
  /** 逃生口：跳过下载与落位，直接用这个 node 可执行文件；未配置时为 null */
  nodeBin: string | null;
}

/** 版本描述合法性：`"18"` | `"18.1"` | `"18.1.5"`（1~3 段数字，允许 `^` / `~` 前缀）。 */
const VERSION_DESC_RE = /^[~^]?\d+(\.\d+){0,2}$/;

/**
 * 读取 `package.json` 里的 ezn 配置。
 *
 * ```
 * "ezn": {
 *   "node": "24",
 *   "dir": "node",
 *   "tools": { "pnpm": "10.34.5" },
 *   "mirror": "https://registry.npmmirror.com/-/binary/node",
 *   "nodeBin": "/path/to/node"
 * }
 * ```
 *
 * 键名刻意**不用 `engines.node`**：那是「兼容范围」语义（本包自己就写着 `>=16` 的壳包基线），
 * 与「跑脚本时固定用哪个版本」是两回事；混用会让 `ezn` 在写了 `>=16` 的包里解析出 `16` 或直接报错。
 *
 * **只做形态解析，不做语义校验**（版本是否在内置表内、路径是否存在，由各自的消费点负责）——
 * 与 `node` 字段的既有分工一致：`readPinnedNode` 只取字符串，`matchNodeVersion` 才判合法性。
 * 但 `tools` 的版本描述在此就滤掉非法值：那个合法集（npm 版本范围）比 node 的宽，混着判会很难查。
 *
 * @param pkgPath - package.json 的绝对路径
 * @returns 配置；文件不存在、JSON 非法或未配置 node 时返回 null（静默忽略，不改调用方行为）
 */
export function readPinnedNode(pkgPath: string): PinnedNode | null {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { "ezn"?: Record<string, unknown> };
    const section = pkg["ezn"];
    const node = section?.["node"];
    if (typeof node === "string" && node.trim() !== "") {
      return {
        node: node.trim(),
        dir: readNonEmptyString(section, "dir"),
        tools: readTools(section?.["tools"]),
        mirror: readNonEmptyString(section, "mirror"),
        nodeBin: readNonEmptyString(section, "nodeBin"),
      };
    }
  } catch {
    // 文件不存在 / 非法 JSON（含注释的 jsonc）→ 视为未配置
  }
  return null;
}

/** 取配置段里某个字符串字段（去空白后非空才算配置了）；其余形态一律视作未配置。
 *  @param section - `ezn` 配置段
 *  @param key - 字段名
 *  @returns 去空白后的字符串；未配置/形态非法时为 null */
function readNonEmptyString(section: Record<string, unknown> | undefined, key: string): string | null {
  const value = section?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 取 `tools` 段（包名 → 版本描述），滤掉空名与非法版本描述。
 *  @param raw - `ezn.tools` 的原始值
 *  @returns 合法的工具表；未配置/形态非法时为空对象（调用方按「没配」处理） */
function readTools(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const tools: Record<string, string> = {};
  for (const [name, desc] of Object.entries(raw as Record<string, unknown>)) {
    if (name.trim() === "") continue;
    if (typeof desc !== "string") continue;
    const version = desc.trim();
    if (!VERSION_DESC_RE.test(version)) {
      console.error(`[ezn] 忽略非法的工具版本描述：ezn.tools["${name}"] = ${JSON.stringify(desc)}（应为 "1" | "1.2" | "1.2.3" 形式）`);
      continue;
    }
    tools[name] = version;
  }
  return tools;
}

/**
 * 从 startDir 起逐级向上查找 `package.json` 的 `ezn` 配置，返回**最近的一个**。
 *
 * 就近优先：`ezn vitest run` 在子包里执行时用该子包的配置，在仓库根执行时用根的配置——
 * 与 `.nvmrc` / `.node-version` 的查找语义一致。缺配置时继续向上找，一路到盘根都没有则返回 null。
 *
 * `root` 同时是**安装位置的基准**：配置写在哪个 package.json，运行时默认就装在它旁边的 `node/`
 * （可用 `dir` 改写）——版本与安装位置由此同源于一处配置。
 *
 * @param startDir - 起始目录（通常为 cwd）
 * @returns 配置与该配置所在的目录（绝对路径）；未找到返回 null
 */
export function resolveConfiguredNode(startDir: string): { config: PinnedNode; root: string } | null {
  let current = resolve(startDir);
  for (;;) {
    const config = readPinnedNode(join(current, "package.json"));
    if (config !== null) return { config, root: current };
    const parent = dirname(current);
    if (parent === current) return null; // 已到盘根
    current = parent;
  }
}

/** `ezn` 命令用法（中文直出，供 `--help` 与参数错误提示复用）。 */
const USAGE = [
  "用法：ezn <命令> [参数...]",
  "",
  "在项目固定版本的托管 Node 上执行命令（npx nve 22 的替代）。",
  "",
  "示例：",
  "  ezn vitest run               在项目固定的 Node 上跑 vitest",
  "  ezn node -v                  跑运行时自带的 node",
  "  ezn npm i -g some-cli        用运行时自带的 npm",
  "  ezn                          只打印本次会用的运行时信息，不执行命令",
  "  ezn --version                打印 ezn 自身版本",
  "",
  "配置（package.json，自当前目录向上就近查找）：",
  '  "ezn": { "node": "22", "dir": "node", "tools": { "pnpm": "10" } }',
  "  node    版本，只在此处声明一次——一个项目一个版本，命令行不接版本参数。",
  "  dir     安装目录名（相对项目根，可省略，默认 node）；须在 .gitignore 忽略。",
  "  tools   要装进运行时的工具（包名 → 版本，可省略）：缺则用运行时自带 npm 装，装进运行时目录。",
  "          版本写法同 node（1~3 段数字，可加 ^ / ~）。",
  "  mirror  下载镜像（目录结构同 nodejs.org/dist，可省略）；用于内网/加速。",
  "  nodeBin 逃生口：跳过下载与落位，直接用指定的 node 可执行文件（可省略）。",
  "  不复用 engines.node：那是兼容范围语义（本包壳包基线写着 >=16），混用会解析错版本。",
  "",
  "版本取值：18 | 18.1 | 18.1.5（1~3 段数字，须在内置版本表内）",
].join("\n");

/**
 * 定出本次要用的 node 版本描述与要执行的命令。
 *
 * 版本只能来自 `package.json` 的 `ezn.node`（自 cwd 向上就近查找）——一个项目一个版本，
 * 命令行不接版本参数，故不存在「版本与命令撞名」的歧义，也不需要 `--` 消歧。
 *
 * @param args - 已剔除 `--` / `--help` / `--version` 的参数
 * @param startDir - 起始目录（缺省 cwd；显式传入供单测隔离，避免落到真实仓库目录）
 * @returns 版本描述与命令参数
 * @throws 未配置 `ezn.node` 时的可操作错误
 */
export function parseInvocation(
  args: readonly string[],
  startDir: string = process.cwd(),
): { spec: string; rest: string[] } {
  // `--` 是习惯性的「选项结束」分隔符，剥掉一层后原样传下去
  const tokens = args[0] === "--" ? args.slice(1) : [...args];
  const configured = resolveConfiguredNode(startDir);
  if (configured === null) throw new Error(missingConfigMessage(startDir));
  return { spec: configured.config.node, rest: tokens };
}

/**
 * 未找到项目配置时的报错文案。
 *
 * 单独成函数是为了可测：该分支要求「自起点一路到盘根都没有 package.json」，
 * 而这在真实文件系统上无法稳定构造（上层目录里总可能有真实项目的 package.json）。
 *
 * @param startDir - 查找起点
 * @returns 面向用户的中文可操作错误
 */
export function missingConfigMessage(startDir: string): string {
  return [
    `未找到 node 版本配置：自 ${resolve(startDir)} 向上各级 package.json 均无 ezn.node。`,
    "请在项目 package.json 里声明（一个项目一个版本）：",
    '  "ezn": { "node": "22", "dir": "node" }',
    "  node  版本（必填）；dir 安装目录名（可省略，默认 node）。",
    "  另可配 tools（装进运行时的工具）、mirror（下载镜像）、nodeBin（逃生口）。",
    "注意不复用 engines.node——那是兼容范围语义（本包自身就写着 >=16）。",
  ].join("\n");
}

/**
 * `ezn` 命令主入口。
 *
 * @param argv - 命令行参数（不含 node 与脚本路径）
 * @returns 进程退出码（子命令的退出码原样透传）
 * @throws 版本非法/无匹配、运行时准备失败、命令无法执行——由薄启动器统一呈现
 */
export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(typeof __EZN_VERSION__ === "string" ? __EZN_VERSION__ : "unknown");
    return 0;
  }

  const { spec, rest } = parseInvocation(args);
  const { version, dir, nodePath } = await ensureRuntime(spec);
  if (rest.length === 0) {
    // 诊断模式：命令可省略，只报告本次会用的运行时
    console.error(`[ezn] Node 版本：${version}（配置 ezn.node = ${spec}）`);
    console.error(`[ezn] 运行时目录：${dir}`);
    console.error(`[ezn] node 可执行文件：${nodePath}`);
    return 0;
  }

  const [name, ...cmdRest] = rest as [string, ...string[]];
  // `node` 恒解析到本运行时的 node 本体（而非 PATH 上的宿主 node）——这是「固定版本」的核心承诺
  const { file, prefixArgs } = name === "node" ? { file: nodePath, prefixArgs: [] } : resolveCommand(dir, name);
  const shell = IS_WIN && /\.(cmd|bat)$/i.test(file);
  const [cmd, cmdArgs] = shellSafe(file, [...prefixArgs, ...cmdRest], shell);
  try {
    return await spawnInherit(cmd, cmdArgs, { shell, env: { ...process.env, PATH: childPath(dir) } });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `找不到命令：${name}\n` +
          `已查找：运行时目录（${dir}）、自当前目录向上各级 node_modules/.bin、以及子进程 PATH。\n` +
          "若是项目的本地依赖（vitest / tsc / vite …），请确认已在项目根执行过 npm/pnpm install。",
      );
    }
    throw err;
  }
}
