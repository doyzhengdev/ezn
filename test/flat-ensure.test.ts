// ezn 落位单测（离线）：Node.ensure 的复用判定，以及「逐条目落位 + 共享目录按子项合并」
// 的落位语义——核心安全要求是该目录内由 npm 安装的包（<rt>/node_modules/ezn，POSIX 为
// <rt>/lib/node_modules/ezn）不被挪走、不被覆盖，同时 node 自带 npm/corepack 仍能装进去。
//
// 不做网络 I/O：**只 mock 掉最外层三个 I/O 依赖**（got / tar / extract-zip），落位逻辑本身
// （installNode → downloadExtract → materializeFlat）全是真实执行——覆盖比过去「直接调内部
// materializeFlat」更完整（连 mkdir / 临时区 / cleanup 一并验到）。mock 的 extractArchive 把
// 「解压就绪的源目录」铺进解压区，等价于真实解压结果。
//
// 合并路径按平台在模块加载时确定（src/install.ts 的 MERGE_PATHS），故 POSIX 形态用
// `vi.resetModules()` + 覆写 process.platform 后重新加载模块来测。

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFlatRuntimeReady, resolveBundledCli } from "../src/runtime.js";
import { Node } from "../src/index.js";

// —— 最外层 I/O 依赖打桩：下载写成空文件，解压把预置的源内容铺进目标目录 ——
// 源内容由用例通过 setExtractSource() 预置（键为相对路径，值为文件内容）。
let extractSource: Record<string, string> = {};

vi.mock("got", async () => {
  const { Readable } = await import("node:stream");
  // 真实空流：pipeline 能用，downloadProgress 监听注册后永不触发（无害）
  return { default: { stream: () => Readable.from([]) } };
});

vi.mock("tar", () => ({
  x: async ({ cwd }: { cwd: string }) => {
    materializeSource(cwd);
  },
}));

vi.mock("extract-zip", () => ({
  default: async (_archive: string, opts: { dir: string }) => {
    materializeSource(opts.dir);
  },
}));

/** 把 extractSource 铺进解压目录，并套一层「顶层版本目录」——真实 Node 官方包解开后即如此，
 *  downloadExtract 会上提一层去掉它，正好一并验到。 */
function materializeSource(dir: string): void {
  const top = join(dir, "node-v99.0.0-win-x64");
  for (const [rel, content] of Object.entries(extractSource)) {
    const target = join(top, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** 伪造成 Node 官方包解开后的内容（Windows zip 形态）。 */
function setExtractSource(files: Record<string, string>): void {
  extractSource = files;
}

// 默认源：node 官方包顶层条目 + 自带 npm/corepack
const DEFAULT_SRC: Record<string, string> = {
  "node.exe": "NODE_BIN",
  "README.md": "NODE_README",
  LICENSE: "NODE_LICENSE",
  "npm.cmd": "NPM_SHIM",
  "node_modules/npm/bin/npm-cli.js": "RUNTIME_NPM_CLI",
  "node_modules/corepack/dist/corepack.js": "RUNTIME_COREPACK",
};

// 递归收集目录内全部相对路径（目录以 / 结尾），用于断言「零落位 / 原封不动」
function listTree(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(root, name)).isDirectory()) {
      out.push(`${rel}/`);
      out.push(...listTree(join(root, name), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

// 伪造运行时根：按给定布局（Windows: "node_modules" / POSIX: "lib/node_modules"）放好自带
// npm/npx 的 CLI 入口——CLI 解析只认「文件在不在」，不依赖真实 node 安装。
// npm 与 npx 的 CLI 同在 npm 包目录下（官方发行包如此：npx 随 npm 包发布）。
function makeRuntimeRoot(relBase: string): string {
  const root = mkdtempSync(join(tmpdir(), "ezn-cli-"));
  for (const which of ["npm", "npx"]) {
    const cli = join(root, relBase, "npm", "bin", `${which}-cli.js`);
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, `${which.toUpperCase()}_CLI`);
  }
  return root;
}

// 当前进程主版本须落在内置表（18~26）内才会走到复用分支
function currentMajorInTable(): number | null {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 18 && major <= 26 ? major : null;
}

describe("Node.ensure 复用分支（不落位）", () => {
  let appDir: string;
  let savedNodeBin: string | undefined;

  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), "ezn-flat-app-"));
    // 本机可能通过逃生口设置了 EZN_NODE_BIN（会短路掉探测分支），逐例隔离
    savedNodeBin = process.env.EZN_NODE_BIN;
    delete process.env.EZN_NODE_BIN;
  });

  afterEach(() => {
    if (savedNodeBin === undefined) delete process.env.EZN_NODE_BIN;
    else process.env.EZN_NODE_BIN = savedNodeBin;
    rmSync(appDir, { recursive: true, force: true });
  });

  it("达标 node 在位 → 复用：rt = <appDir>/node，目录内文件集合前后完全一致（零落位）", async () => {
    const major = currentMajorInTable();
    if (major === null) return;
    const rt = join(appDir, "node");
    const nodePath = join(rt, process.platform === "win32" ? "node.exe" : join("bin", "node"));
    mkdirSync(dirname(nodePath), { recursive: true });
    // 复制当前 node 冒充已装运行时（ensure 只探测主版本，不校验具体构建）
    copyFileSync(process.execPath, nodePath);
    // 目录内的已装包与无关杂物：复用分支不得触碰它们
    mkdirSync(join(rt, "node_modules", "ezn"), { recursive: true });
    writeFileSync(join(rt, "node_modules", "ezn", "package.json"), '{"name":"ezn"}');
    writeFileSync(join(rt, "stray.txt"), "KEEP");
    // 已装运行时的自带 npm（两种布局都放，保证任一本机平台都能判为就绪）
    for (const rel of [["node_modules"], ["lib", "node_modules"]]) {
      const npmCli = join(rt, ...rel, "npm", "bin", "npm-cli.js");
      mkdirSync(dirname(npmCli), { recursive: true });
      writeFileSync(npmCli, "FAKE_NPM");
    }
    const before = listTree(rt);

    const node = await Node.ensure(appDir, String(major));

    expect(node.path).toBe(nodePath);
    expect(node.rt).toBe(rt);
    // rt 决定 npm/npx 自带 CLI 的解析位置（node 官方包内置于此）
    expect(node.npmCliPath).toBe(join(rt, "node_modules", "npm", "bin", "npm-cli.js"));
    expect(listTree(rt)).toEqual(before); // 未新增/删除/备份任何条目
    expect(readdirSync(rt).some((n) => n.includes(".old-"))).toBe(false);
  });

  it("EZN_NODE_BIN 逃生口 → path 取显式 Node，rt 仍为 <appDir>/node（决定 CLI 解析位置），零落位", async () => {
    // 预置 POSIX 布局的自带 npm：rt 语义由「解析命中哪里」体现（而非探测进程 node 自己的目录）
    const rt = join(appDir, "node");
    const npmCli = join(rt, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, "FAKE_NPM");
    const before = listTree(appDir);

    process.env.EZN_NODE_BIN = process.execPath;
    const node = await Node.ensure(appDir, "18");

    expect(node.path).toBe(process.execPath);
    expect(node.rt).toBe(rt);
    expect(node.npmCliPath).toBe(npmCli);
    expect(listTree(appDir)).toEqual(before); // 复用/逃生口分支不做任何落位
  });
});

describe("自带 npm/npx CLI 入口解析（Windows / POSIX 布局，离线）", () => {
  let winRoot: string;
  let posixRoot: string;
  let emptyRoot: string;

  beforeEach(() => {
    winRoot = makeRuntimeRoot("node_modules");
    posixRoot = makeRuntimeRoot(join("lib", "node_modules"));
    emptyRoot = mkdtempSync(join(tmpdir(), "ezn-cli-empty-"));
  });

  afterEach(() => {
    for (const root of [winRoot, posixRoot, emptyRoot]) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Windows 官方包布局 → 命中 <root>/node_modules；与 POSIX 布局并存时仍取第一候选", () => {
    expect(resolveBundledCli(winRoot, "npm")).toBe(join(winRoot, "node_modules", "npm", "bin", "npm-cli.js"));
    // npx 的 CLI 也在 npm 包目录下（官方发行包如此）
    expect(resolveBundledCli(winRoot, "npx")).toBe(join(winRoot, "node_modules", "npm", "bin", "npx-cli.js"));
    const libCli = join(winRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(dirname(libCli), { recursive: true });
    writeFileSync(libCli, "OTHER");
    expect(resolveBundledCli(winRoot, "npm")).toBe(join(winRoot, "node_modules", "npm", "bin", "npm-cli.js"));
  });

  it("POSIX 官方 tar.gz 布局 → 命中 <root>/lib/node_modules/npm（npm/npx 皆是）", () => {
    expect(resolveBundledCli(posixRoot, "npm")).toBe(
      join(posixRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );
    expect(resolveBundledCli(posixRoot, "npx")).toBe(
      join(posixRoot, "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    );
  });

  it("两种布局都缺 → 抛可操作错误：列出候选路径 + 布局无关的恢复方式", () => {
    let err: Error | null = null;
    try {
      resolveBundledCli(emptyRoot, "npm");
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain("npm");
    expect(err?.message).toContain(join(emptyRoot, "node_modules", "npm", "bin", "npm-cli.js"));
    expect(err?.message).toContain(join(emptyRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"));
    // 恢复指引不退化为裸错误
    expect(err?.message).toContain("可尝试的恢复方式");
    expect(err?.message).toContain("重新启动服务");
  });

  it("Node 实例 getter 复用同一解析（伪造 rt；缺 CLI 抛同一错误）", () => {
    expect(new Node(process.execPath, posixRoot).npmCliPath).toBe(
      join(posixRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );
    expect(new Node(process.execPath, posixRoot).npxCliPath).toBe(
      join(posixRoot, "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    );
    expect(new Node(process.execPath, winRoot).npmCliPath).toBe(
      join(winRoot, "node_modules", "npm", "bin", "npm-cli.js"),
    );
    expect(() => new Node(process.execPath, emptyRoot).npmCliPath).toThrow(/未找到自带 npm/);
  });
});

describe("就绪判定（isFlatRuntimeReady，离线）", () => {
  let root: string;
  const extraDirs: string[] = [];

  function makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    extraDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    root = makeDir("ezn-ready-");
  });

  afterEach(() => {
    for (const dir of extraDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("node 达标但缺自带 npm（落位中断的半成品）→ false，不得当就绪复用", () => {
    const nodePath = join(root, process.platform === "win32" ? "node.exe" : join("bin", "node"));
    mkdirSync(dirname(nodePath), { recursive: true });
    writeFileSync(nodePath, "NODE_BIN");
    // 只有 npm 装好的托管包：正是「包先装、node 落位中途失败」的现场
    mkdirSync(join(root, "node_modules", "ezn"), { recursive: true });
    writeFileSync(join(root, "node_modules", "ezn", "package.json"), '{"name":"ezn"}');
    expect(isFlatRuntimeReady(root)).toBe(false);
  });

  it("node 达标 + 自带 npm 在位（node_modules 与 lib/node_modules 两种布局都认）→ true", () => {
    // node 位置按本机平台；npm 两个候选位置都试，与平台无关
    const nodePath = join(root, process.platform === "win32" ? "node.exe" : join("bin", "node"));
    mkdirSync(dirname(nodePath), { recursive: true });
    writeFileSync(nodePath, "NODE_BIN");
    expect(isFlatRuntimeReady(root)).toBe(false); // 先确认 npm 缺位时不算就绪
    const npmCli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, "FAKE_NPM");
    expect(isFlatRuntimeReady(root)).toBe(true);

    // 自带 npm 落在 POSIX 候选位置（lib/node_modules）同样认
    const libRoot = makeDir("ezn-ready-lib-");
    const libNode = join(libRoot, process.platform === "win32" ? "node.exe" : join("bin", "node"));
    mkdirSync(dirname(libNode), { recursive: true });
    writeFileSync(libNode, "NODE_BIN");
    const libNpmCli = join(libRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(dirname(libNpmCli), { recursive: true });
    writeFileSync(libNpmCli, "FAKE_NPM");
    expect(isFlatRuntimeReady(libRoot)).toBe(true);
  });

  it("只有自带 npm、没有 node → false（node 在位是前提）", () => {
    const npmCli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, "FAKE_NPM");
    expect(isFlatRuntimeReady(root)).toBe(false);
  });
});

describe("落位（逐条目 + 共享目录按子项合并）——驱动真实 installNode，仅 mock I/O 层", () => {
  let appDir: string;
  let rt: string;
  // 本组用例个别需要第二套目录树（POSIX 形态），统一登记以便 afterEach 一并清理
  const extraDirs: string[] = [];
  function makeExtraDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    extraDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    setExtractSource(DEFAULT_SRC);
    appDir = mkdtempSync(join(tmpdir(), "ezn-flat-dst-"));
    rt = join(appDir, "node");
    // 目标 = npm 已把托管包装好的运行时目录
    mkdirSync(join(rt, "node_modules", "ezn", "dist"), { recursive: true });
    writeFileSync(join(rt, "node_modules", "ezn", "package.json"), '{"name":"ezn"}');
    writeFileSync(join(rt, "node_modules", "ezn", "dist", "server.js"), "SERVER_JS");
  });

  afterEach(() => {
    extractSource = {};
    rmSync(appDir, { recursive: true, force: true });
    for (const dir of extraDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("包先装、node 后落位（目标只有已装包）→ 自带 npm/corepack 并入，包原样保留", async () => {
    const pkgTree = listTree(join(rt, "node_modules", "ezn"));

    const { installNode } = await import("../src/install.js");
    await installNode(rt, "18");

    expect(readFileSync(join(rt, "node.exe"), "utf8")).toBe("NODE_BIN");
    expect(readdirSync(rt).sort()).toEqual(["LICENSE", "README.md", "node.exe", "node_modules", "npm.cmd"]);
    // 共享目录按子项合并：自带包并入，目标独有的托管包原样
    expect(readdirSync(join(rt, "node_modules")).sort()).toEqual(["corepack", "ezn", "npm"]);
    expect(readFileSync(join(rt, "node_modules", "npm", "bin", "npm-cli.js"), "utf8")).toBe("RUNTIME_NPM_CLI");
    expect(listTree(join(rt, "node_modules", "ezn"))).toEqual(pkgTree);
    // 临时区（下载包 + 解压区）用完即清，不残留在 appDir
    expect(readdirSync(appDir).sort()).toEqual(["node"]);
  });

  it("node 损坏/不达标 → 同名项备份为 <名>.old-<ts> 后覆盖，共享目录内已装包不受影响", async () => {
    writeFileSync(join(rt, "node.exe"), "BROKEN_NODE"); // 非可执行假文件
    writeFileSync(join(rt, "README.md"), "OLD_README");
    const pkgTree = listTree(join(rt, "node_modules", "ezn"));

    const { installNode } = await import("../src/install.js");
    await installNode(rt, "18");

    expect(readFileSync(join(rt, "node.exe"), "utf8")).toBe("NODE_BIN");
    expect(readFileSync(join(rt, "README.md"), "utf8")).toBe("NODE_README");
    const backups = readdirSync(rt).filter((n) => n.includes(".old-"));
    expect(backups.sort()).toEqual([
      expect.stringMatching(/^README\.md\.old-\d+$/),
      expect.stringMatching(/^node\.exe\.old-\d+$/),
    ]);
    const nodeBackup = backups.find((n) => n.startsWith("node.exe.old-"));
    const readmeBackup = backups.find((n) => n.startsWith("README.md.old-"));
    expect(readFileSync(join(rt, nodeBackup as string), "utf8")).toBe("BROKEN_NODE");
    expect(readFileSync(join(rt, readmeBackup as string), "utf8")).toBe("OLD_README");
    expect(new Set(backups.map((n) => n.split(".old-")[1])).size).toBe(1); // 同一次落位共用时间戳
    expect(listTree(join(rt, "node_modules", "ezn"))).toEqual(pkgTree);
    // 关键安全语义：不做整目录备份（rt 自身绝不能被改名挪走）
    expect(readdirSync(appDir).some((n) => n.startsWith("node.old-"))).toBe(false);
    expect(existsSync(rt)).toBe(true);
  });

  it("共享目录内只存在于目标的子项（已装包）→ 不备份、不阻断落位", async () => {
    const pkgTree = listTree(join(rt, "node_modules", "ezn"));

    const { installNode } = await import("../src/install.js");
    await installNode(rt, "18");

    expect(readdirSync(join(rt, "node_modules")).sort()).toEqual(["corepack", "ezn", "npm"]);
    expect(listTree(join(rt, "node_modules", "ezn"))).toEqual(pkgTree);
    expect(
      readdirSync(rt)
        .concat(readdirSync(join(rt, "node_modules")))
        .some((n) => n.includes(".old-")),
    ).toBe(false);
  });

  it("共享目录内两边都有的子项 → 备份后覆盖，时间戳与其它同名备份一致", async () => {
    mkdirSync(join(rt, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(rt, "node_modules", "npm", "bin", "npm-cli.js"), "OLD_NPM");
    writeFileSync(join(rt, "README.md"), "OLD_README");

    const { installNode } = await import("../src/install.js");
    await installNode(rt, "18");

    expect(readFileSync(join(rt, "node_modules", "npm", "bin", "npm-cli.js"), "utf8")).toBe("RUNTIME_NPM_CLI");
    const npmBackups = readdirSync(join(rt, "node_modules")).filter((n) => n.startsWith("npm.old-"));
    expect(npmBackups).toHaveLength(1);
    expect(readFileSync(join(rt, "node_modules", npmBackups[0] as string, "bin", "npm-cli.js"), "utf8")).toBe(
      "OLD_NPM",
    );
    const readmeBackup = readdirSync(rt).find((n) => n.startsWith("README.md.old-"));
    expect(readmeBackup).toBeTruthy();
    // 同一次落位（含共享目录内的备份）共用时间戳
    expect((npmBackups[0] as string).split(".old-")[1]).toBe((readmeBackup as string).split(".old-")[1]);
  });

  it("POSIX 多段合并路径：lib/node_modules 合并、lib 不被整体备份、lib 下其它内容走既有语义", async () => {
    // MERGE_PATHS 在模块加载时按 process.platform 决定，故覆写平台后重新加载模块
    const posixRt = makeExtraDir("ezn-flat-posix-");
    // 目标：托管包在 lib/node_modules 下（POSIX 官方 tar.gz 与 npm prefix 布局都如此）
    mkdirSync(join(posixRt, "lib", "node_modules", "ezn"), { recursive: true });
    writeFileSync(join(posixRt, "lib", "node_modules", "ezn", "package.json"), '{"name":"ezn"}');
    // lib 下的普通内容：一个两边都有（走既有语义）、一个仅目标有（原地保留）
    writeFileSync(join(posixRt, "lib", "other.txt"), "OLD_LIB_OTHER");
    writeFileSync(join(posixRt, "lib", "keepme.txt"), "KEEP_ONLY_IN_TARGET");
    const pkgTree = listTree(join(posixRt, "lib", "node_modules", "ezn"));
    setExtractSource({
      "bin/node": "NODE_BIN",
      "lib/node_modules/npm/bin/npm-cli.js": "RUNTIME_NPM_CLI",
      "lib/node_modules/corepack/dist/corepack.js": "RUNTIME_COREPACK",
      "lib/other.txt": "SRC_LIB_OTHER",
      "README.md": "NODE_README",
    });

    const savedPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.resetModules();
    try {
      const { installNode } = await import("../src/install.js");
      await installNode(posixRt, "18");
    } finally {
      Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
      vi.resetModules();
    }

    expect(readFileSync(join(posixRt, "bin", "node"), "utf8")).toBe("NODE_BIN");
    // lib 是合并路径的前缀：下钻而不整体备份
    expect(readdirSync(posixRt).some((n) => n.startsWith("lib.old-"))).toBe(false);
    expect(readFileSync(join(posixRt, "lib", "other.txt"), "utf8")).toBe("SRC_LIB_OTHER");
    expect(readdirSync(join(posixRt, "lib")).find((n) => n.startsWith("other.txt.old-"))).toBeTruthy();
    expect(readFileSync(join(posixRt, "lib", "keepme.txt"), "utf8")).toBe("KEEP_ONLY_IN_TARGET");
    // lib/node_modules 合并：自带包并入、托管包原样
    expect(readdirSync(join(posixRt, "lib", "node_modules")).sort()).toEqual(["corepack", "ezn", "npm"]);
    expect(listTree(join(posixRt, "lib", "node_modules", "ezn"))).toEqual(pkgTree);
  });
});
