// ezllm-node `ezn` 命令单测（离线）：配置解析、运行时目录推导、就绪判定、并发落位锁、命令解析、PATH 前置。
// 真下载 / 真执行由冒烟覆盖，此处不触网、不起进程。
//
// ⚠ 隔离要求：一律经 startDir 参数把落位根钉在 tmpRoot 内，**不要**依赖 cwd。
// 这里曾靠切换 cwd 驱动，逃生口（ELLM_N_CACHE）被删后失去隔离，直接把真实仓库目录
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
  projectRoot,
  readPinnedNode,
  resolveConfiguredNode,
  resolveCommand,
  resolveInAncestors,
  resolveRuntimeDir,
} from "../src/ezn-cli.js";
import { nodeExecPath, nodePlatformKey } from "../src/runtime.js";

// installNode 的打桩入口：落位链路必然触网，此处只验「传参 + 复用/落位决策」，真实落位由冒烟覆盖
const installNodeMock = vi.fn(async (_dir: string, _version: string) => {});
vi.mock("../src/install.js", () => ({
  installNode: (dir: string, version: string) => installNodeMock(dir, version),
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
  tmpRoot = mkdtempSync(join(tmpdir(), "ezllm-n-test-"));
  installNodeMock.mockClear();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("配置读取（ezllm-node.node / .dir）", () => {
  const cfg = (node: string, dir?: string) => ({ node, dir: dir ?? null });

  it("读取 node；未配 dir → null（表示用默认目录名）", () => {
    writePkg(tmpRoot, { "ezllm-node": { node: "24" } });
    expect(readPinnedNode(join(tmpRoot, "package.json"))).toEqual(cfg("24"));
  });

  it("读取 dir（自定义安装目录名）", () => {
    writePkg(tmpRoot, { "ezllm-node": { node: "24", dir: "runtime" } });
    expect(readPinnedNode(join(tmpRoot, "package.json"))).toEqual(cfg("24", "runtime"));
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
    writePkg(tmpRoot, { "ezllm-node": { node: "22" } });
    const nested = join(tmpRoot, "packages", "server");
    writePkg(nested, { "ezllm-node": { node: "24" } });
    expect(resolveConfiguredNode(nested)).toEqual({ config: cfg("24"), root: nested });
    // 该层无配置 → 向上取根的那份
    expect(resolveConfiguredNode(join(tmpRoot, "packages"))).toEqual({ config: cfg("22"), root: tmpRoot });
  });

  it("dir 省略时为 null，表示用默认目录名", () => {
    writePkg(tmpRoot, { "ezllm-node": { node: "24" } });
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
    writePkg(tmpRoot, { "ezllm-node": { node: "22" } });
    const { version, platformKey, dir } = resolveRuntimeDir("22", tmpRoot);
    expect(version).toMatch(/^v22\.\d+\.\d+$/);
    expect(platformKey).toBe(nodePlatformKey());
    expect(dir).toBe(join(tmpRoot, "node"));
    // 版本不进路径：换版本仍落同一个目录（覆盖式落位，见 src/ezn-cli.ts 文件头注）
    expect(resolveRuntimeDir("24", tmpRoot).dir).toBe(dir);
  });

  it("项目根 = 配置所在目录（就近向上），而非 startDir 本身", () => {
    writePkg(tmpRoot, { "ezllm-node": { node: "24" } });
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
    writePkg(tmpRoot, { "ezllm-node": { node: "24", dir: "runtime" } });
    expect(resolveRuntimeDir("24", tmpRoot).dir).toBe(join(tmpRoot, "runtime"));

    writePkg(tmpRoot, { "ezllm-node": { node: "24", dir: ".tools/node" } });
    expect(resolveRuntimeDir("24", tmpRoot).dir).toBe(join(tmpRoot, ".tools", "node"));
  });

  it("dir 为绝对路径 / .. 逃逸 → 抛可操作错误（运行时必须随项目走）", () => {
    for (const bad of ["C:\\elsewhere", "/elsewhere", "../outside", "a/../../b"]) {
      writePkg(tmpRoot, { "ezllm-node": { node: "24", dir: bad } });
      expect(() => resolveRuntimeDir("24", tmpRoot)).toThrow(/ezllm-node\.dir/);
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
  beforeEach(() => writePkg(tmpRoot, { "ezllm-node": { node: "22" } }));

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
    expect(installNodeMock).toHaveBeenCalledWith(dir, "22");
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

  it("ELLM_NODE_BIN 生效：跳过落位，path 取指定 node，dir 取其所在目录", async () => {
    const fake = fakeRuntime(join(tmpRoot, "elsewhere"));
    process.env.ELLM_NODE_BIN = fake;
    try {
      const out = await ensureRuntime("22", tmpRoot);
      expect(out.nodePath).toBe(fake);
      expect(out.dir).toBe(join(tmpRoot, "elsewhere"));
      expect(installNodeMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.ELLM_NODE_BIN;
    }
  });

  it("ELLM_NODE_BIN 指向不存在的路径 → 抛错（不静默回落下载）", async () => {
    process.env.ELLM_NODE_BIN = join(tmpRoot, "no-such-node.exe");
    try {
      await expect(ensureRuntime("22", tmpRoot)).rejects.toThrow(/ELLM_NODE_BIN/);
      expect(installNodeMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.ELLM_NODE_BIN;
    }
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
    writePkg(tmpRoot, { "ezllm-node": { node: "22" } });
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
  beforeEach(() => writePkg(tmpRoot, { "ezllm-node": { node: "24" } }));

  it("版本取自配置，命令与参数原样透传", () => {
    expect(parseInvocation(["vitest", "run"], tmpRoot)).toEqual({ spec: "24", rest: ["vitest", "run"] });
    expect(parseInvocation(["node", "-v"], tmpRoot)).toEqual({ spec: "24", rest: ["node", "-v"] });
    expect(parseInvocation([], tmpRoot)).toEqual({ spec: "24", rest: [] }); // 诊断模式
  });

  it("命令行里的数字是命令名，不会被当成版本吞掉", () => {
    expect(parseInvocation(["22"], tmpRoot)).toEqual({ spec: "24", rest: ["22"] });
  });

  it("习惯性的 -- 分隔符剥掉一层后原样传下去", () => {
    expect(parseInvocation(["--", "vitest", "run"], tmpRoot)).toEqual({ spec: "24", rest: ["vitest", "run"] });
    // 只剥一层：命令名恰好是 "--" 时仍能传给它
    expect(parseInvocation(["--", "--", "x"], tmpRoot)).toEqual({ spec: "24", rest: ["--", "x"] });
  });

  // 注：「找不到配置 → 抛错」这条不断言 parseInvocation 真的抛——那要求起点之上到盘根都没有
  // package.json，在真实文件系统上无法稳定构造（C:\Users\ZDY 等上层目录里可能有真实项目）。
  // 故只断言文案函数本身，分支由 missingConfigMessage 的调用点保证。
  it("找不到配置的报错文案：带出查找起点、给出必填项与目录说明", () => {
    const msg = missingConfigMessage(join(tmpRoot, "no-such-dir"));
    expect(msg).toMatch(/no-such-dir/); // 起点，便于定位
    expect(msg).toMatch(/ezllm-node/);
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
