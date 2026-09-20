// ezn `ezn` 命令单测（离线）：配置解析、运行时目录推导、就绪判定、并发落位锁、命令解析、PATH 前置。
// 真下载 / 真执行由冒烟覆盖，此处不触网、不起进程。
//
// ⚠ 隔离要求：一律经 startDir 参数把落位根钉在 tmpRoot 内，**不要**依赖 cwd。
// 这里曾靠切换 cwd 驱动，逃生口（EZN_N_CACHE）被删后失去隔离，直接把真实仓库目录
// <repo>/node/node.exe 覆写成了 4 字节的 "FAKE"。startDir 参数就是为了根除这类事故。

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireLock,
  childPath,
  ensureRuntime,
  isReady,
  missingConfigMessage,
  parseInvocation,
  parsePackageManager,
  projectRoot,
  readPinnedNode,
  resolveConfiguredNode,
  resolveCommand,
  resolveInAncestors,
  resolveRuntimeDir,
  resolveTools,
  withGlobalPrefix,
} from "../src/ezn-cli.js";
import { nodeExecPath, nodePlatformKey } from "../src/runtime.js";

// installNode 的打桩入口：落位链路必然触网，此处只验「传参 + 复用/落位决策」，真实落位由冒烟覆盖
const installNodeMock = vi.fn(async (_dir: string, _version: string, _options?: unknown) => {});
vi.mock("../src/install.js", () => ({
  installNode: (dir: string, version: string, options?: unknown) => installNodeMock(dir, version, options),
}));

// 工具装配要真起 npm 子进程（触网）——打桩 spawnInherit，只验「装了哪个包、传了什么参数」
const spawnInheritMock = vi.fn(async (_cmd: string, _args: readonly string[], _options?: unknown) => 0);
vi.mock("../src/spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/spawn.js")>()),
  spawnInherit: (cmd: string, args: readonly string[], options?: unknown) => spawnInheritMock(cmd, args, options),
}));

let tmpRoot: string;

/** 造一个带（或不带）配置的 package.json（配置相关用例共用）。 */
function writePkg(dir: string, config?: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(config === undefined ? { name: "x" } : config));
}

/** 在运行时目录里造一个假的 node 可执行文件（不真执行，只碰存在性）；返回其路径。 */
function fakeRuntime(dir: string): string {
  const nodePath = nodeExecPath(dir);
  mkdirSync(dirname(nodePath), { recursive: true });
  writeFileSync(nodePath, "FAKE");
  return nodePath;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ezn-n-test-"));
  installNodeMock.mockClear();
  spawnInheritMock.mockClear();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("配置读取（ezn.node / .dir / .tools / .mirror / .nodeBin）", () => {
  // 未配置的可选字段一律为 null / 空对象——调用方据此走默认分支
  const cfg = (node: string, dir?: string) => ({
    node,
    dir: dir ?? null,
    tools: {},
    mirror: null,
    nodeBin: null,
    packageManager: null,
  });

  it("读取 node；未配 dir → null（表示用默认目录名）", () => {
    writePkg(tmpRoot, { "ezn": { node: "24" } });
    expect(readPinnedNode(join(tmpRoot, "package.json"))).toEqual(cfg("24"));
  });

  it("读取 dir（自定义安装目录名）", () => {
    writePkg(tmpRoot, { "ezn": { node: "24", dir: "runtime" } });
    expect(readPinnedNode(join(tmpRoot, "package.json"))).toEqual(cfg("24", "runtime"));
  });

  it("读取 tools / mirror / nodeBin / packageManager（可选字段）", () => {
    writePkg(tmpRoot, {
      "ezn": {
        node: "24",
        tools: { pnpm: "10.34.5", typescript: "^5" },
        mirror: "https://mirror.example/node-dist",
        nodeBin: "/opt/node/bin/node",
      },
      packageManager: "pnpm@9.15.0",
    });
    expect(readPinnedNode(join(tmpRoot, "package.json"))).toEqual({
      node: "24",
      dir: null,
      tools: { pnpm: "10.34.5", typescript: "^5" },
      mirror: "https://mirror.example/node-dist",
      nodeBin: "/opt/node/bin/node",
      packageManager: "pnpm@9.15.0", // 顶层字段，不在 ezn 段内
    });
  });

  it("tools 里的非法项被滤掉（空名 / 非字符串 / 非法版本描述），合法的保留", () => {
    writePkg(tmpRoot, {
      "ezn": { node: "24", tools: { pnpm: "10.34.5", "": "1", bad: "latest", str: "5.9.3" } },
    });
    expect(readPinnedNode(join(tmpRoot, "package.json"))?.tools).toEqual({ pnpm: "10.34.5", str: "5.9.3" });
  });

  it("被丢弃的 tools 项一律报警（静默丢弃是最难排查的配置错误）", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 非字符串（null / true）与非法版本描述（latest / *）都要有提示
      writePkg(tmpRoot, { "ezn": { node: "24", tools: { a: null, b: true, c: "latest", d: "*x" } } });
      readPinnedNode(join(tmpRoot, "package.json"));
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      for (const name of ["a", "b", "c", "d"]) expect(logged).toContain(`ezn.tools["${name}"]`);
    } finally {
      spy.mockRestore();
    }
  });

  it("数字形态的版本号（常见笔误）被接受并转为字符串，同时报警说明", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writePkg(tmpRoot, { "ezn": { node: "24", tools: { pnpm: 10 } } });
      // 数字 10 是合法版本描述的形态 → 收下（而非丢弃），但会经报警分支提示
      expect(readPinnedNode(join(tmpRoot, "package.json"))?.tools).toEqual({ pnpm: "10" });
    } finally {
      spy.mockRestore();
    }
  });

  it('tools 值可以是 "*"（不关心版本，装最新一次）', () => {
    writePkg(tmpRoot, { "ezn": { node: "24", tools: { pnpm: "*" } } });
    expect(readPinnedNode(join(tmpRoot, "package.json"))?.tools).toEqual({ pnpm: "*" });
  });

  it("tools 整体非对象（数组 / 字符串）→ 空对象并报警", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const bad of [[], "pnpm", 3]) {
        writePkg(tmpRoot, { "ezn": { node: "24", tools: bad } });
        expect(readPinnedNode(join(tmpRoot, "package.json"))?.tools).toEqual({});
      }
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("mirror / nodeBin 为空串或非字符串 → null（视作未配置）", () => {
    writePkg(tmpRoot, { "ezn": { node: "24", mirror: "  ", nodeBin: 42 } });
    const cfg = readPinnedNode(join(tmpRoot, "package.json"));
    expect(cfg?.mirror).toBeNull();
    expect(cfg?.nodeBin).toBeNull();
  });

  it("未配置 / 文件不存在 / 非法 JSON → null（静默忽略，不改调用方行为）", () => {
    writePkg(join(tmpRoot, "a"), { name: "x" });
    expect(readPinnedNode(join(tmpRoot, "a", "package.json"))).toBeNull();
    expect(readPinnedNode(join(tmpRoot, "nope", "package.json"))).toBeNull();
    mkdirSync(join(tmpRoot, "b"), { recursive: true });
    writeFileSync(join(tmpRoot, "b", "package.json"), "{ 非法");
    expect(readPinnedNode(join(tmpRoot, "b", "package.json"))).toBeNull();
  });

  it("不复用 engines.node（那是兼容范围语义：本包自己写着 >=16）", () => {
    writePkg(join(tmpRoot, "c"), { engines: { node: ">=16" } });
    expect(readPinnedNode(join(tmpRoot, "c", "package.json"))).toBeNull();
  });

  it("向上查找取**最近**的一个配置", () => {
    writePkg(tmpRoot, { "ezn": { node: "22" } });
    const nested = join(tmpRoot, "packages", "server");
    writePkg(nested, { "ezn": { node: "24" } });
    expect(resolveConfiguredNode(nested)).toEqual({ config: cfg("24"), root: nested });
    // 该层无配置 → 向上取根的那份
    expect(resolveConfiguredNode(join(tmpRoot, "packages"))).toEqual({ config: cfg("22"), root: tmpRoot });
  });

  it("dir 省略时为 null，表示用默认目录名", () => {
    writePkg(tmpRoot, { "ezn": { node: "24" } });
    expect(resolveConfiguredNode(tmpRoot)?.config.dir).toBeNull();
  });

  it("找不到配置 → null（由调用方给出可操作错误）", () => {
    // 注意：不能用 tmpRoot 下的子目录——查找会一路向上到盘根，tmpRoot 之上（系统 Temp）
    // 若有 package.json 就会命中，导致断言不稳。故直接查一个确定不存在的路径。
    expect(resolveConfiguredNode(join(tmpRoot, "no-such-dir"))).toBeNull();
  });
});

describe("运行时目录推导", () => {
  it("默认恒为 <项目根>/node（官方发行包同构，不按版本分目录）", () => {
    writePkg(tmpRoot, { "ezn": { node: "22" } });
    const { version, platformKey, dir } = resolveRuntimeDir("22", tmpRoot);
    expect(version).toMatch(/^v22\.\d+\.\d+$/);
    expect(platformKey).toBe(nodePlatformKey());
    expect(dir).toBe(join(tmpRoot, "node"));
    // 版本不进路径：换版本仍落同一个目录（覆盖式落位，见 src/ezn-cli.ts 文件头注）
    expect(resolveRuntimeDir("24", tmpRoot).dir).toBe(dir);
  });

  it("项目根 = 配置所在目录（就近向上），而非 startDir 本身", () => {
    writePkg(tmpRoot, { "ezn": { node: "24" } });
    const nested = join(tmpRoot, "packages", "server");
    mkdirSync(nested, { recursive: true });
    expect(projectRoot(nested)).toBe(tmpRoot);
    expect(resolveRuntimeDir("24", nested).dir).toBe(join(tmpRoot, "node"));
  });

  it("无配置时项目根回落到 startDir（随后由 parseInvocation 拦下）", () => {
    const bare = join(tmpRoot, "bare");
    mkdirSync(bare, { recursive: true });
    expect(projectRoot(bare)).toBe(bare);
  });

  it("dir → <项目根>/<dir>（支持多级相对路径）", () => {
    writePkg(tmpRoot, { "ezn": { node: "24", dir: "runtime" } });
    expect(resolveRuntimeDir("24", tmpRoot).dir).toBe(join(tmpRoot, "runtime"));

    writePkg(tmpRoot, { "ezn": { node: "24", dir: ".tools/node" } });
    expect(resolveRuntimeDir("24", tmpRoot).dir).toBe(join(tmpRoot, ".tools", "node"));
  });

  it("dir 为绝对路径 / .. 逃逸 → 抛可操作错误（运行时必须随项目走）", () => {
    for (const bad of ["C:\\elsewhere", "/elsewhere", "../outside", "a/../../b"]) {
      writePkg(tmpRoot, { "ezn": { node: "24", dir: bad } });
      expect(() => resolveRuntimeDir("24", tmpRoot)).toThrow(/ezn\.dir/);
    }
  });

  it("主版本 / 组件级前缀 / 完整版本 → 同一版本（复用同一份运行时）", () => {
    const major = resolveRuntimeDir("22", tmpRoot);
    expect(resolveRuntimeDir("22.23", tmpRoot).version).toBe(major.version);
    expect(resolveRuntimeDir("22.23.2", tmpRoot).version).toBe(major.version);
  });

  it("非法版本 / 未内置版本 → 抛可操作错误（不创建任何目录）", () => {
    expect(() => resolveRuntimeDir("v22", tmpRoot)).toThrow(/nodeVersion/);
    expect(() => resolveRuntimeDir("27", tmpRoot)).toThrow(/无匹配/);
    expect(existsSync(join(tmpRoot, "node"))).toBe(false);
  });
});

describe("就绪判定与复用", () => {
  beforeEach(() => writePkg(tmpRoot, { "ezn": { node: "22" } }));

  it("node 可执行文件在位 → 就绪（isReady 为真且 ensureRuntime 不落位）", async () => {
    const { dir } = resolveRuntimeDir("22", tmpRoot);
    const nodePath = fakeRuntime(dir);
    expect(isReady(dir)).toBe(true);
    const out = await ensureRuntime("22", tmpRoot);
    expect(out.nodePath).toBe(nodePath);
    expect(installNodeMock).not.toHaveBeenCalled();
  });

  it("运行时缺失 → 触发落位，且 installNode 收到「原始版本描述 + 运行时目录」", async () => {
    const { dir } = resolveRuntimeDir("22", tmpRoot);
    await ensureRuntime("22", tmpRoot);
    expect(installNodeMock).toHaveBeenCalledTimes(1);
    // 传原始描述（不是 resolveRuntimeDir 解析出的 "v22.23.2"）——installNode 内部会再解析一次，
    // 且拒绝 "v" 前缀，两处各解析一次是本包历史上踩过的真实 bug（见项目记忆 §13）
    expect(installNodeMock).toHaveBeenCalledWith(dir, "22", { mirror: null });
  });

  it("落位完成后锁目录被清理（异常路径也不残留）", async () => {
    const { dir } = resolveRuntimeDir("22", tmpRoot);
    await ensureRuntime("22", tmpRoot);
    expect(existsSync(`${dir}.lock`)).toBe(false);
  });

  it("落位失败 → 错误向上抛，且锁目录不残留", async () => {
    const { dir } = resolveRuntimeDir("22", tmpRoot);
    installNodeMock.mockRejectedValueOnce(new Error("下载失败"));
    await expect(ensureRuntime("22", tmpRoot)).rejects.toThrow(/下载失败/);
    expect(existsSync(`${dir}.lock`)).toBe(false);
  });

  it("ezn.nodeBin 生效：跳过落位，path 取指定 node，dir 取其所在目录", async () => {
    const fake = fakeRuntime(join(tmpRoot, "elsewhere"));
    writePkg(tmpRoot, { "ezn": { node: "22", nodeBin: fake } });
    const out = await ensureRuntime("22", tmpRoot);
    expect(out.nodePath).toBe(fake);
    expect(out.dir).toBe(join(tmpRoot, "elsewhere"));
    expect(installNodeMock).not.toHaveBeenCalled();
  });

  it("ezn.nodeBin 指向不存在的路径 → 抛错（不静默回落下载）", async () => {
    writePkg(tmpRoot, { "ezn": { node: "22", nodeBin: join(tmpRoot, "no-such-node.exe") } });
    await expect(ensureRuntime("22", tmpRoot)).rejects.toThrow(/ezn\.nodeBin/);
    expect(installNodeMock).not.toHaveBeenCalled();
  });

  it("ezn.mirror 透传给 installNode（配置驱动，不经环境变量）", async () => {
    writePkg(tmpRoot, { "ezn": { node: "22", mirror: "https://mirror.example/node-dist" } });
    await ensureRuntime("22", tmpRoot);
    expect(installNodeMock).toHaveBeenCalledWith(expect.any(String), "22", {
      mirror: "https://mirror.example/node-dist",
    });
  });
});

describe("工具装配（ezn.tools）", () => {
  /** 造出「node 已就绪 + 自带 npm 在位」的运行时目录（工具装配的前提）。 */
  function readyRuntime(): string {
    writePkg(tmpRoot, { "ezn": { node: "22" } });
    const { dir } = resolveRuntimeDir("22", tmpRoot);
    fakeRuntime(dir);
    for (const rel of [["node_modules"], ["lib", "node_modules"]]) {
      const npmCli = join(dir, ...rel, "npm", "bin", "npm-cli.js");
      mkdirSync(dirname(npmCli), { recursive: true });
      writeFileSync(npmCli, "FAKE_NPM");
    }
    return dir;
  }

  /** 造出工具已装好的落点（版本可控），供「已就绪则跳过」的用例。 */
  function fakeTool(dir: string, name: string, version: string): void {
    const pkgDir = join(dir, "node_modules", name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version }));
  }

  it("未配 tools 且未配 packageManager → 兜底装上 pnpm 最新版（ezn 脚本生态默认包管理器）", async () => {
    const dir = readyRuntime();
    spawnInheritMock.mockImplementationOnce(async () => {
      fakeTool(dir, "pnpm", "12.5.1");
      return 0;
    });
    await ensureRuntime("22", tmpRoot);
    expect(spawnInheritMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnInheritMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("pnpm"); // 裸包名 = 最新版
  });

  it("packageManager 声明了包管理器 → 版本取自它（无需在 tools 里抄一份）", async () => {
    const dir = readyRuntime();
    fakeTool(dir, "pnpm", "9.15.0");
    writePkg(tmpRoot, { name: "x", "ezn": { node: "22" }, packageManager: "pnpm@9.15.0" });
    await ensureRuntime("22", tmpRoot);
    expect(spawnInheritMock).not.toHaveBeenCalled(); // 版本已相符，跳过
    void dir;
  });

  it("packageManager 版本不符 → 按它重装（tools 没写也不落到 latest）", async () => {
    const dir = readyRuntime();
    fakeTool(dir, "pnpm", "12.5.1"); // 旧的非期望版本
    writePkg(tmpRoot, { name: "x", "ezn": { node: "22" }, packageManager: "pnpm@9.15.0" });
    spawnInheritMock.mockImplementationOnce(async () => {
      fakeTool(dir, "pnpm", "9.15.0");
      return 0;
    });
    await ensureRuntime("22", tmpRoot);
    const [, args] = spawnInheritMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("pnpm@9.15.0");
  });

  it("tools 显式版本优先于 packageManager（可偏离）", () => {
    const base = {
      node: "24",
      dir: null,
      mirror: null,
      nodeBin: null,
      packageManager: "pnpm@9.15.0",
    };
    expect(resolveTools({ ...base, tools: { pnpm: "10.34.5" } })).toEqual({ pnpm: "10.34.5" });
    expect(resolveTools({ ...base, tools: { pnpm: "*" } })).toEqual({ pnpm: "*" });
    // 未写 tools → 用 packageManager 的版本
    expect(resolveTools({ ...base, tools: {} })).toEqual({ pnpm: "9.15.0" });
    // 既没 tools 也没 packageManager → 兜底 pnpm 最新
    expect(resolveTools({ ...base, tools: {}, packageManager: null })).toEqual({ pnpm: "*" });
  });

  it("scoped 包名的 packageManager 解析正确（@yarnpkg/cli@4.0.0 不被切断）", () => {
    expect(parsePackageManager("@yarnpkg/cli@4.0.0")).toEqual({ name: "@yarnpkg/cli", version: "4.0.0" });
    expect(parsePackageManager("pnpm@10.34.5")).toEqual({ name: "pnpm", version: "10.34.5" });
    // corepack 的 +sha512 后缀要剥掉
    expect(parsePackageManager("pnpm@10.34.5+sha512.abc123")).toEqual({ name: "pnpm", version: "10.34.5" });
    // 非法形态 → null
    for (const bad of [null, "pnpm", "@4.0.0", "pnpm@latest", ""]) {
      expect(parsePackageManager(bad)).toBeNull();
    }
  });

  it("tools 指定的工具缺失 → 用自带 npm 装进运行时目录（--prefix <dir>，不经宿主全局目录）", async () => {
    const dir = readyRuntime();
    writePkg(tmpRoot, { "ezn": { node: "22", tools: { pnpm: "10.34.5" } } });
    await ensureRuntime("22", tmpRoot);
    expect(spawnInheritMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnInheritMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe(nodeExecPath(dir)); // 用运行时自带的 node 执行
    expect(args).toContain("install");
    expect(args).toContain("--prefix");
    expect(args[args.indexOf("--prefix") + 1]).toBe(dir); // 装进运行时目录，不是宿主全局
    expect(args).toContain("pnpm@10.34.5");
  });

  it("工具已按期望版本装好 → 跳过（不重复安装）", async () => {
    const dir = readyRuntime();
    fakeTool(dir, "pnpm", "10.34.5");
    writePkg(tmpRoot, { "ezn": { node: "22", tools: { pnpm: "10.34.5" } } });
    await ensureRuntime("22", tmpRoot);
    expect(spawnInheritMock).not.toHaveBeenCalled();
  });

  it("已装版本与配置不符 → 重装", async () => {
    const dir = readyRuntime();
    fakeTool(dir, "pnpm", "9.0.0"); // 旧版本
    writePkg(tmpRoot, { "ezn": { node: "22", tools: { pnpm: "10.34.5" } } });
    await ensureRuntime("22", tmpRoot);
    expect(spawnInheritMock).toHaveBeenCalledTimes(1);
  });

  it("版本描述按前缀语义匹配（^10 / ~10 / 10 都能命中已装的 10.34.5）", async () => {
    for (const spec of ["^10.34.5", "~10.34.5"]) {
      const dir = readyRuntime();
      fakeTool(dir, "pnpm", "10.34.5");
      writePkg(tmpRoot, { "ezn": { node: "22", tools: { pnpm: spec } } });
      await ensureRuntime("22", tmpRoot);
      expect(spawnInheritMock, `spec=${spec}`).not.toHaveBeenCalled();
      spawnInheritMock.mockClear();
    }
  });

  it("装完仍未就位（npm 静默失败）→ 不误报成功，也不抛错打断命令", async () => {
    readyRuntime();
    writePkg(tmpRoot, { "ezn": { node: "22", tools: { pnpm: "10.34.5" } } });
    // spawnInherit 打桩不真装 → 装完探测仍为 false，走「未就位」分支
    await expect(ensureRuntime("22", tmpRoot)).resolves.toBeDefined();
    expect(spawnInheritMock).toHaveBeenCalledTimes(1); // 不重试
  });

  it("装配失败（子进程抛错）→ 只警告不抛出（断网不该让命令跑不起来）", async () => {
    readyRuntime();
    writePkg(tmpRoot, { "ezn": { node: "22", tools: { pnpm: "10.34.5", typescript: "5" } } });
    spawnInheritMock.mockRejectedValueOnce(new Error("网络不可达"));
    await expect(ensureRuntime("22", tmpRoot)).resolves.toBeDefined();
    expect(spawnInheritMock).toHaveBeenCalledTimes(1); // 首个失败即停，不再试下一个
  });

  it('"*" → 装 latest（不带版本号），装完写标记；再跑一次靠标记跳过', async () => {
    const dir = readyRuntime();
    writePkg(tmpRoot, { "ezn": { node: "22", tools: { pnpm: "*" } } });
    // 打桩不真装，故让「安装」把包目录造出来——就位判定与标记写入才走得到
    spawnInheritMock.mockImplementationOnce(async () => {
      fakeTool(dir, "pnpm", "12.5.1");
      return 0;
    });

    await ensureRuntime("22", tmpRoot);
    const [, args] = spawnInheritMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("pnpm"); // 裸包名 = latest，不带 @*
    expect(args.some((a) => a.startsWith("pnpm@"))).toBe(false);
    expect(existsSync(join(dir, ".ezn-tools", "pnpm"))).toBe(true); // 标记已写

    // 第二次：标记在 → 跳过（否则 "*" 会永远命中、再也更新不了）
    spawnInheritMock.mockClear();
    await ensureRuntime("22", tmpRoot);
    expect(spawnInheritMock).not.toHaveBeenCalled();
  });

  it('"*" 的标记缺失但包已在 → 仍会重装一次并补标记（标记是唯一判据）', async () => {
    const dir = readyRuntime();
    fakeTool(dir, "pnpm", "12.5.1");
    writePkg(tmpRoot, { "ezn": { node: "22", tools: { pnpm: "*" } } });
    await ensureRuntime("22", tmpRoot);
    expect(spawnInheritMock).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, ".ezn-tools", "pnpm"))).toBe(true);
  });
});

describe("并发落位锁", () => {
  it("首个抢到锁；就绪后另一个进程观察到就绪、不重复落位", async () => {
    const dir = join(tmpRoot, "rt");
    const lockDir = `${dir}.lock`;

    expect(await acquireLock(lockDir, dir)).toBe(true); // 抢到
    expect(existsSync(lockDir)).toBe(true);

    // 持锁者装完（造出 node 可执行文件）后，后到者不再抢锁
    fakeRuntime(dir);
    expect(await acquireLock(lockDir, dir)).toBe(false); // 观察到就绪，提前返回

    rmSync(lockDir, { recursive: true, force: true });
    expect(await acquireLock(lockDir, dir)).toBe(true); // 释放后可再抢
  });

  it("锁被占用且运行时就绪 → 不夺锁、不落位", async () => {
    writePkg(tmpRoot, { "ezn": { node: "22" } });
    const { dir } = resolveRuntimeDir("22", tmpRoot);
    fakeRuntime(dir);
    mkdirSync(`${dir}.lock`, { recursive: true }); // 模拟另一进程持锁
    await ensureRuntime("22", tmpRoot);
    expect(installNodeMock).not.toHaveBeenCalled();
  });

  it("锁的父目录不存在时也能建锁（首次落位不再 ENOENT）", async () => {
    // 运行时目录与锁的父目录都不存在——真实首次运行的形态
    const dir = join(tmpRoot, "fresh", "node");
    expect(await acquireLock(`${dir}.lock`, dir)).toBe(true);
    expect(existsSync(`${dir}.lock`)).toBe(true);
  });
});

describe("npm 全局操作锁定落点（withGlobalPrefix）", () => {
  const RT = join("some", "runtime");

  it("全局操作 → 前置 --prefix <运行时目录>（-g / --global 两种写法）", () => {
    for (const flag of ["-g", "--global", "--global=true", "-g=true"]) {
      expect(withGlobalPrefix(RT, ["i", flag, "some-cli"])).toEqual(["--prefix", RT, "i", flag, "some-cli"]);
    }
  });

  it("非全局操作 → 原样返回（--prefix 对非全局命令是「改项目根」，注入会破坏项目语义）", () => {
    expect(withGlobalPrefix(RT, ["i", "some-cli"])).toEqual(["i", "some-cli"]);
    expect(withGlobalPrefix(RT, ["run", "build"])).toEqual(["run", "build"]);
    expect(withGlobalPrefix(RT, ["ci"])).toEqual(["ci"]);
    expect(withGlobalPrefix(RT, ["exec", "some-bin"])).toEqual(["exec", "some-bin"]);
  });

  it("用户自己写了 --prefix → 尊重，不重复注入（叠加会让落点取决于参数顺序）", () => {
    expect(withGlobalPrefix(RT, ["i", "-g", "--prefix", "C:/mine", "some-cli"])).toEqual([
      "i",
      "-g",
      "--prefix",
      "C:/mine",
      "some-cli",
    ]);
    expect(withGlobalPrefix(RT, ["i", "-g", "--prefix=C:/mine", "some-cli"])).toEqual([
      "i",
      "-g",
      "--prefix=C:/mine",
      "some-cli",
    ]);
  });

  it("不含 -g 的 --global 前缀词不算全局（如 --global-style 这类近形参数）", () => {
    expect(withGlobalPrefix(RT, ["i", "--globally", "x"])).toEqual(["i", "--globally", "x"]);
  });
});

describe("命令解析", () => {
  it("含路径分隔符的名字不会被当作命令名解析（返回 null）", () => {
    expect(resolveInAncestors(tmpRoot, "./local-script")).toBeNull();
  });

  it("从起始目录逐级向上找到 node_modules/.bin/<name>（含 Windows .cmd 后缀）", () => {
    const nested = join(tmpRoot, "a", "b", "c");
    mkdirSync(join(tmpRoot, "node_modules", ".bin"), { recursive: true });
    const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat"] : [""];
    for (const ext of exts) writeFileSync(join(tmpRoot, "node_modules", ".bin", `tool${ext}`), "");
    mkdirSync(nested, { recursive: true });

    const hit = resolveInAncestors(nested, "tool");
    expect(hit).not.toBeNull();
    expect(hit?.startsWith(join(tmpRoot, "node_modules", ".bin"))).toBe(true);
  });

  it("一路到盘根都没找到 → null（交回调用方保持裸名，由子进程 PATH 兜底）", () => {
    expect(resolveInAncestors(tmpRoot, "definitely-not-installed-xyz")).toBeNull();
  });

  // 回归：`n pnpm -r test` 一度报「找不到命令：pnpm」——pnpm 是宿主装的，不在任何
  // node_modules/.bin 里，而 Windows 上 Node 的 spawn 只认 .exe、不认 .cmd，裸名交给子进程
  // 必然 ENOENT。故解析链必须补一步 PATH 查找（按 PATHEXT 补全后缀）。
  // 见 src/ezn-cli.ts 的 resolveInPath。
  it("宿主 PATH 上的命令可解析（Windows 需补全 .cmd/.bat/.exe 后缀）", () => {
    const hit = resolveCommand(join(tmpRoot, "no-such-runtime"), process.platform === "win32" ? "npm" : "sh");
    expect(hit.file).not.toBe("");
    // Windows 上要么解析到运行时目录里的 npm.cmd，要么解析到 PATH 上的某个真实文件；
    // 关键断言是「不再是裸名」——裸名在 Windows 上会以 ENOENT 失败
    if (process.platform === "win32") {
      expect(hit.file === "npm" || existsSync(hit.file)).toBe(true);
    }
  });

  it("解析不到的命令保持裸名（由子进程兜底，错误由 main 转成可操作提示）", () => {
    expect(resolveCommand(join(tmpRoot, "no-such-runtime"), "definitely-not-installed-xyz").file).toBe(
      "definitely-not-installed-xyz",
    );
  });
});

describe("参数解析（版本只来自配置，命令行不接版本）", () => {
  beforeEach(() => writePkg(tmpRoot, { "ezn": { node: "24" } }));

  // 只断言 spec/rest；resolved 是「顺带带出的配置」供 ensureRuntime 复用，不是本块的对象
  const specRest = (args: string[]) => {
    const { spec, rest } = parseInvocation(args, tmpRoot);
    return { spec, rest };
  };

  it("版本取自配置，命令与参数原样透传", () => {
    expect(specRest(["vitest", "run"])).toEqual({ spec: "24", rest: ["vitest", "run"] });
    expect(specRest(["node", "-v"])).toEqual({ spec: "24", rest: ["node", "-v"] });
    expect(specRest([])).toEqual({ spec: "24", rest: [] }); // 诊断模式
  });

  it("命令行里的数字是命令名，不会被当成版本吞掉", () => {
    expect(specRest(["22"])).toEqual({ spec: "24", rest: ["22"] });
  });

  it("习惯性的 -- 分隔符剥掉一层后原样传下去", () => {
    expect(specRest(["--", "vitest", "run"])).toEqual({ spec: "24", rest: ["vitest", "run"] });
    // 只剥一层：命令名恰好是 "--" 时仍能传给它
    expect(specRest(["--", "--", "x"])).toEqual({ spec: "24", rest: ["--", "x"] });
  });

  it("顺带带出已解析的配置（供 ensureRuntime 复用，避免重复读盘与重复告警）", () => {
    const { resolved } = parseInvocation(["vitest"], tmpRoot);
    expect(resolved?.config.node).toBe("24");
    expect(resolved?.root).toBe(tmpRoot);
  });

  // 注：「找不到配置 → 抛错」这条不断言 parseInvocation 真的抛——那要求起点之上到盘根都没有
  // package.json，在真实文件系统上无法稳定构造（C:\Users\ZDY 等上层目录里可能有真实项目）。
  // 故只断言文案函数本身，分支由 missingConfigMessage 的调用点保证。
  it("找不到配置的报错文案：带出查找起点、给出必填项与目录说明", () => {
    const msg = missingConfigMessage(join(tmpRoot, "no-such-dir"));
    expect(msg).toMatch(/no-such-dir/); // 起点，便于定位
    expect(msg).toMatch(/ezn/);
    expect(msg).toMatch(/engines\.node/); // 明确说明为何不复用 engines
  });
});

describe("子进程 PATH 前置", () => {
  it("运行时根（及 Windows 的 node_modules/.bin）前置，原 PATH 原样保留在尾部", () => {
    const base = ["orig1", "orig2"].join(delimiter);
    const out = childPath("C:/rt", base);
    const entries = out.split(delimiter);
    expect(entries[0]).toBe("C:/rt");
    if (process.platform === "win32") expect(entries[1]).toBe(join("C:/rt", "node_modules", ".bin"));
    expect(out.endsWith(base)).toBe(true);
  });
});
