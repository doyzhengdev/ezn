// ezn 单测（离线）：主版本探测、版本描述匹配、ensure 守卫、内置版本表形态、执行封装基本语义。
// 涉及真实下载/解压的链路由壳包引导器 e2e（临时 EZN_APP_DIR 三分支实测）覆盖，此处不做网络 I/O。

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Node } from "../src/index.js";
import { installNode } from "../src/install.js";
import { matchNodeVersion } from "../src/runtime.js";
import versions from "../src/versions.json";

// installNode 的打桩入口：ensure 的「下载安装分支」的真实落位必然触发网络，此处只验
// 「传了什么参数」，真实落位链路由冒烟/e2e 覆盖。
vi.mock("../src/install.js", () => ({ installNode: vi.fn(async () => {}) }));

const table = versions as Record<string, { version: string }>;

describe("Node.probeMajor", () => {
  it("当前进程 node → 返回其主版本", () => {
    const expected = Number(process.versions.node.split(".")[0]);
    expect(Node.probeMajor(process.execPath)).toBe(expected);
  });

  it("不存在的路径 → null（不可执行）", () => {
    expect(Node.probeMajor(join(tmpdir(), "ezn-nonexistent", "node.exe"))).toBeNull();
  });
});

describe("Node 实例执行封装", () => {
  let node: Node;

  beforeEach(() => {
    node = new Node(process.execPath, tmpdir());
  });

  it("execSync：捕获输出默认 utf8 字符串", () => {
    const res = node.execSync(["-e", "console.log(40+2)"]);
    expect(res.status).toBe(0);
    expect(res.stdout?.trim()).toBe("42");
  });

  it("exec：异步返回 status/stdout", async () => {
    const res = await node.exec(["-v"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^v\d+\./);
  });

  it("args 可传单个字符串", () => {
    const res = node.execSync("-v");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^v\d+\./);
  });

  it("major getter 与 probeMajor 一致", () => {
    expect(node.major).toBe(Node.probeMajor(process.execPath));
  });
});

// 从 src/index.ts 源码扫描「运行期具名导出」：export function/class/const，以及
// `export { a, b } from "./x.js"` 形式的转发导出；类型/接口（含 `export type { ... }`）运行期不存在，不计。
function sourceExportNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}\s*from/gm)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

describe("构建产物双形态冒烟（CJS/ESM）", () => {
  it("ESM 入口（dist/index.mjs）：具名导入可用（经 createRequire 包装 CJS 实现）", async () => {
    const { pathToFileURL } = await import("node:url");
    const mod = await import(pathToFileURL(join(process.cwd(), "dist", "index.mjs")).href);
    expect(typeof mod.Node).toBe("function");
    const node = new mod.Node(process.execPath, tmpdir());
    expect(node.major).toBe(Number(process.versions.node.split(".")[0]));
  });

  it("ESM 入口的具名导出与 src 的运行期导出对齐（硬编码 re-export 名单不漏项）", async () => {
    // 断言方式：动态 import dist/index.mjs（消费者实际拿到的运行时视图）+ 源码扫描得到的导出集合。
    // 选它而非「读 index.mjs 源码字符串比对」：前者验证的是运行期真实可导入性，且不受包装文件
    // 排版/生成方式影响；dist 由本包 test 脚本先 build，故此处的产物必为最新。
    const expected = sourceExportNames(readFileSync(join(process.cwd(), "src", "index.ts"), "utf8"));
    // 公共 API 面刻意收窄为只导出 Node（其余实现细节在 src/flat.ts、src/runtime.ts 内）
    expect(expected).toEqual(["Node"]);
    const { pathToFileURL } = await import("node:url");
    const mod = (await import(pathToFileURL(join(process.cwd(), "dist", "index.mjs")).href)) as Record<string, unknown>;
    const missing = expected.filter((name) => !Object.prototype.hasOwnProperty.call(mod, name));
    expect(missing).toEqual([]);
  });

  it("CJS 入口（dist/index.js）：require 具名解构可用", () => {
    // import.meta 禁入 CJS 输出（TS1470），以 cwd 的 package.json 作 require 解析基准
    const cjsRequire = createRequire(join(process.cwd(), "package.json"));
    const mod = cjsRequire("./dist/index.js") as { Node: typeof Node };
    expect(typeof mod.Node).toBe("function");
  });
});

describe("matchNodeVersion（版本描述 → 内置表匹配）", () => {
  it("主版本 → 命中该主版本内置 patch", () => {
    expect(matchNodeVersion("18")).toBe(table["18"]?.version);
  });

  it("主.次版本 → 组件级前缀命中", () => {
    const pinned = table["18"]?.version ?? "";
    expect(matchNodeVersion(pinned.replace(/^v/, "").split(".").slice(0, 2).join("."))).toBe(pinned);
  });

  it("完整版本 → 精确命中", () => {
    const pinned = table["18"]?.version ?? "";
    expect(matchNodeVersion(pinned.replace(/^v/, ""))).toBe(pinned);
  });

  it("非法格式（v 前缀/超三段/非数字/空）→ 抛可操作错误", () => {
    for (const bad of ["v18", "18.1.2.3", "18.x", "18.", ""]) {
      expect(() => matchNodeVersion(bad)).toThrow(/nodeVersion/);
    }
  });

  it("无匹配（未内置主版本 / 未内置次版本）→ 抛错且列出内置版本", () => {
    expect(() => matchNodeVersion("27")).toThrow(/无匹配/);
    // 取内置 18 的次版本 +1，构造必然不命中的 "18.x"（表内每主版本仅一条）
    const minor = Number(table["18"]?.version.split(".")[1]);
    expect(() => matchNodeVersion(`18.${minor + 1}`)).toThrow(/18=/);
  });
});

describe("命令行字符串形式（空白拆分 + node/npm/npx 首词分发）", () => {
  // 伪造自带 npm/npx CLI 入口：分发单测只关心"选中了哪个 CLI、传了什么参数"，不依赖真实 npm
  // （离线；nve 缓存等精简发行版可能没有 npm，真实 npm 链路由壳包引导器 e2e 覆盖）
  let rt: string;
  let node: Node;

  beforeEach(() => {
    rt = mkdtempSync(join(tmpdir(), "ezn-test-"));
    mkdirSync(join(rt, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(
      join(rt, "node_modules", "npm", "bin", "npm-cli.js"),
      'console.log("npm-cli", process.argv.slice(2).join(" "));\n',
    );
    writeFileSync(
      join(rt, "node_modules", "npm", "bin", "npx-cli.js"),
      'console.log("npx-cli", process.argv.slice(2).join(" "));\n',
    );
    node = new Node(process.execPath, rt);
  });

  afterEach(() => {
    rmSync(rt, { recursive: true, force: true });
  });

  it("execSync('node -v')：分发到 node 本体", () => {
    const res = node.execSync("node -v");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^v\d+\./);
  });

  it("execSync('npm -v')：分发到自带 npm", () => {
    const res = node.execSync("npm -v");
    expect(res.status).toBe(0);
    expect(res.stdout?.trim()).toBe("npm-cli -v");
  });

  it("npmSync('npm -v') / npxSync('npx -v')：首词分发一致", () => {
    expect(node.npmSync("npm -v").stdout?.trim()).toBe("npm-cli -v");
    expect(node.npxSync("npx -v").stdout?.trim()).toBe("npx-cli -v");
  });

  it("npmSync('i -g nve')：非命令首词 → 默认当前方法的 CLI", () => {
    expect(node.npmSync("i -g nve").stdout?.trim()).toBe("npm-cli i -g nve");
  });

  it("多 token 拆分：execSync('-e console.log(40+2)')", () => {
    const res = node.execSync("-e console.log(40+2)");
    expect(res.status).toBe(0);
    expect(res.stdout?.trim()).toBe("42");
  });

  it("非 node/npm/npx 开头 → 整串作为默认可执行参数（'-v' 单 token 向后兼容）", () => {
    expect(node.execSync("-v").status).toBe(0);
  });

  it("空命令 → 抛错", () => {
    expect(() => node.execSync("   ")).toThrow(/命令为空/);
  });
});

describe("Node.ensure 守卫（不触发下载）", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ezn-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // 以 process.env 存取 EZN_NODE_BIN（逃生口现仅经环境变量注入），逐例保存/恢复
  function withNodeBin(value: string | undefined, fn: () => unknown): Promise<unknown> | unknown {
    const prev = process.env.EZN_NODE_BIN;
    if (value === undefined) delete process.env.EZN_NODE_BIN;
    else process.env.EZN_NODE_BIN = value;
    const done = (result: unknown) => {
      if (prev === undefined) delete process.env.EZN_NODE_BIN;
      else process.env.EZN_NODE_BIN = prev;
      return result;
    };
    try {
      const out = fn();
      return out instanceof Promise
        ? out.then(done, (err) => {
            done(err);
            throw err;
          })
        : out;
    } catch (err) {
      done(err);
      throw err;
    }
  }

  it("非法 nodeVersion → 抛可操作错误（不触发任何下载）", async () => {
    await expect(Node.ensure(tmpRoot, "v24")).rejects.toThrow(/nodeVersion/);
    await expect(Node.ensure(tmpRoot, "27")).rejects.toThrow(/无匹配/);
  });

  it("appDir 相对路径 → 内部转绝对（rt 为绝对路径且指向 <appDir>/node）", async () => {
    await withNodeBin(process.execPath, async () => {
      const node = await Node.ensure("test-app-rel", "18");
      expect(isAbsolute(node.rt)).toBe(true);
      expect(node.rt.endsWith(join("test-app-rel", "node"))).toBe(true);
    });
  });

  it("EZN_NODE_BIN 指向不存在路径 → 抛错", async () => {
    await withNodeBin(join(tmpRoot, "no-such-node"), async () => {
      await expect(Node.ensure(tmpRoot, "18")).rejects.toThrow(/EZN_NODE_BIN/);
    });
  });

  // 回归：ensure 一度把 matchNodeVersion 解析后的 "v20.20.2" 透传给 installNode，
  // 而 installNode 内部会再解析一次、且拒绝 "v" 前缀 → 真实下载链路直接抛错（单测当时没抓到）。
  // 契约：传原始版本描述（"20" / "20.1"），解析只发生一次。
  it("下载安装分支 → installNode 收到「原始版本描述 + 托管目录」（不透传解析结果）", async () => {
    const mocked = vi.mocked(installNode);
    mocked.mockClear();

    // 目录内含不可执行的 node.exe → 走到下载安装分支（不走复用，也不触发真实下载：installNode 已打桩）
    mkdirSync(join(tmpRoot, "node"), { recursive: true });
    writeFileSync(join(tmpRoot, "node", "node.exe"), "BROKEN");
    await Node.ensure(tmpRoot, "18");
    expect(mocked).toHaveBeenCalledWith(join(tmpRoot, "node"), "18");
  });

  it("内置表：主版本 18~26 全覆盖，version 与键一致", () => {
    const majors = Object.keys(table).map(Number);
    for (let major = 18; major <= 26; major++) {
      expect(majors).toContain(major);
    }
    for (const [major, entry] of Object.entries(table)) {
      expect(entry.version).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(Number(entry.version.replace(/^v(\d+)\..*/, "$1"))).toBe(Number(major));
    }
  });
});
