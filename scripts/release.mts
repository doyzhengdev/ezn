/** @file 一键发版：查最新版本 → patch +1 → 构建 → 发布 npm → 提交并推 tag。
 * @fileoverview
 *
 * 用法：`npm run release`（或 `node scripts/release.mts`）。
 *
 * 为什么用 `.mts` 后缀：本包是 `type: "commonjs"`，`.ts` 会被 Node 按 CJS 加载，
 * 而本脚本用 ESM 语法（顶层 await）。Node ≥ 22.6 原生支持类型剥离，无需额外运行器。
 *
 * 流程（任一步失败即中止，且不留半成品状态）：
 *   1. 前置校验：工作区干净、在 git 仓库、.env 有 NPM_TOKEN
 *   2. 向 registry 查最新已发布版本（而不是读本地 package.json——本地可能落后于线上）
 *   3. patch +1
 *   4. npm publish —— **注意：0.0.6 起 `prepack` / `prepublishOnly` 已移除，publish 不会再自动
 *      构建或跑测试**，而本脚本自己也不跑。故发布前**必须**先手工 `npm run build`，
 *      否则会发出缺产物或产物陈旧的包（`dist/` 已 gitignore、但列在 `files` 里）。
 *      要恢复「发布即校验」请把这两个钩子加回 package.json。
 *   5. git add + commit + tag + push（含 tag）
 *
 * **发布失败时回滚版本号**：把 package.json 恢复原值、并恢复任何已改的工作区文件，
 * 以免留下「版本号已 bump 但没发出去」的中间态——那种状态下次发版会拿到错误的递增基数。
 *
 * token 从 `.env` 读（该文件已 gitignore，见 .gitignore 的注释）。**绝不把 token 写进产物或提交**：
 * 经 `npm_config_//<host>/:_authToken` 环境变量传给 npm 子进程，不落盘。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath: string = join(pkgRoot, "package.json");

/** npm 官方源：发布目标恒为它（与 package.json 的 publishConfig.registry 一致）。 */
const REGISTRY = "https://registry.npmjs.org/";

/** 一步失败就中止：发版流程的任何一步出错，继续往下只会造成更坏的中间态。 */
function fail(message: string): never {
  console.error(`\n[release] ✗ ${message}`);
  process.exit(1);
}

/** 跑一条命令并把输出原样交给用户（stdout 直连，便于看构建/发布进度）。 */
/** 该命令是否需要经 shell 执行。
 *
 *  **只有 Windows 下的 npm/pnpm/npx 需要**：它们是 `.cmd` 包装器，不`shell` 则 spawn 报 ENOENT
 *  （Node 自 CVE-2024-27980 起禁止直接 spawn .cmd/.bat）。其余命令（git / node）都是 .exe，
 *  而**经 shell 是有代价的**——shell 会按空白把参数重新分词、不做转义，带空格的参数会被拆散。
 *  实测踩过：`git commit -m "chore(release): 发布 0.0.4"` 经 shell 后被拆成三段，git 把「发布」
 *  和「0.0.4」当成 pathspec 而报 `did not match any file(s) known to git`（发版流程因此中断）。 */
function needsShell(cmd: string): boolean {
  return process.platform === "win32" && /^(npm|pnpm|npx)$/.test(cmd);
}

/** 跑一条命令并把输出原样交给用户（stdout 直连，便于看构建/发布进度）。 */
function run(cmd: string, args: readonly string[], opts: { cwd?: string } = {}): void {
  console.error(`[release] $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: opts.cwd ?? pkgRoot, stdio: "inherit", shell: needsShell(cmd) });
}

/** 跑一条命令并捕获 stdout（用于读取型命令，如 npm view / git status）。 */
function capture(cmd: string, args: readonly string[], opts: { cwd?: string } = {}): string {
  return execFileSync(cmd, args, { cwd: opts.cwd ?? pkgRoot, encoding: "utf-8", shell: needsShell(cmd) }).trim();
}

interface Pkg {
  name: string;
  version: string;
  [key: string]: unknown;
}

/** 读 .env 里的 NPM_TOKEN（只取这一个键；不引入 dotenv 依赖）。 */
function readToken(): string {
  const envPath = join(pkgRoot, ".env");
  if (!existsSync(envPath)) fail(`未找到 .env（应含 NPM_TOKEN）：${envPath}`);
  const line = readFileSync(envPath, "utf-8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("NPM_TOKEN"));
  const token = line?.slice(line.indexOf("=") + 1).trim();
  if (!token) {
    fail("`.env` 里没有 NPM_TOKEN。请添加一行：NPM_TOKEN=npm_xxxxxxxx");
  }
  return token;
}

/** 校验工作区干净——发版必须基于**已提交**的状态。
 *
 *  为什么暂存（git add）不算过关：本脚本随后要 `git commit package.json`，若暂存区里还躺着别的
 *  改动，它们会被一并提交进发版提交里（`git commit <path>` 只限定路径，不限定暂存来源）。
 *  故此处要求 `git status --porcelain` 完全为空——含未暂存、已暂存与未跟踪三类。 */
function assertCleanWorktree(): void {
  const status = capture("git", ["status", "--porcelain"]);
  if (status !== "") {
    fail(
      "工作区不干净（含未跟踪文件），请先提交后再发版：\n" +
        status
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
    );
  }
}

/** 查 registry 上的最新已发布版本。发布过则返回它，未发布过（首次）返回 null。 */
function latestPublished(pkgName: string): string | null {
  try {
    // 用 --registry 显式指定：本机默认源可能是镜像（如 npmmirror），查到的版本未必与发布目标一致
    const out = capture("npm", ["view", pkgName, "version", "--registry", REGISTRY]);
    return out === "" ? null : (out.split("\n").pop()?.trim() ?? null);
  } catch {
    // 包未发布过（E404）或网络异常——交给调用方按「首次发布」处理并提示
    return null;
  }
}

/** patch 位 +1（0.0.3 → 0.0.4）。 */
function bumpPatch(version: string): string {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    fail(`版本号形态无法解析（期望 x.y.z）：${version}`);
  }
  return `${parts[0]}.${parts[1]}.${(parts[2] as number) + 1}`;
}

/** 在当前进程环境里临时挂上 npm 认证：经 `npm_config_//host/:_authToken` 环境变量传递。
 *
 *  为什么不用临时 .npmrc：环境变量无需落盘、也不会因异常退出而残留含 token 的文件。
 *  npm 认的是 `//<host>/:_authToken` 这个规范化键名，故用 `npm_config_` 前缀 + 完整路径注入。 */
function withAuthEnv(token: string): NodeJS.ProcessEnv {
  const host = REGISTRY.replace(/^https?:/, "").replace(/\/$/, ""); // //registry.npmjs.org
  return { ...process.env, [`npm_config_${host}/:_authToken`]: token };
}

// ── 主流程 ───────────────────────────────────────────────────────────────

const token = readToken();
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Pkg;

assertCleanWorktree();

console.error(`[release] 包：${pkg.name}`);
const latest = latestPublished(pkg.name);
if (latest === null) {
  fail(`未能从 ${REGISTRY} 查到 ${pkg.name} 的最新版本（网络问题或包未发布过？）`);
}
console.error(`[release] registry 最新版本：${latest}`);

// 以 registry 的版本为基数递增，而不是本地 package.json——本地可能是尚未发布的改动
const next = bumpPatch(latest);
console.error(`[release] 本次发布版本：${next}`);

const originalPkg = readFileSync(pkgPath, "utf-8");

/** 回滚：恢复 package.json 原内容（发布失败时不留「版本号已 bump 但没发出去」的中间态）。 */
function rollback(): void {
  writeFileSync(pkgPath, originalPkg, "utf-8");
  console.error(`[release] 已回滚 package.json 到 ${pkg.version}`);
}

try {
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`, "utf-8");
  console.error(`[release] 已写入版本号 ${next}`);

  // 不在此处跑构建/测试：0.0.6 起 prepack / prepublishOnly 已移除，publish 不做任何校验，
  // 故发布前须由人事先跑过 build 与 test。publish 失败时下面的 catch 会回滚版本号。
  console.error("[release] 发布到 npm（不再自动构建/测试，请确认已跑过 build 与 test）...");
  execFileSync("npm", ["publish"], {
    cwd: pkgRoot,
    stdio: "inherit",
    shell: needsShell("npm"),
    env: withAuthEnv(token),
  });
  console.error(`[release] ✓ 已发布 ${pkg.name}@${next}`);
} catch (err) {
  rollback();
  fail(`发布失败：${err instanceof Error ? err.message : String(err)}`);
}

// 发布成功后才提交：顺序反过来的话，提交了却没发出去会留下误导性的提交记录
try {
  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `chore(release): 发布 ${next}`]);
  run("git", ["tag", `v${next}`]);
  run("git", ["push", "origin", "HEAD"]);
  run("git", ["push", "origin", `v${next}`]);
  console.error(`[release] ✓ 已提交并推送（含 tag v${next}）`);
} catch (err) {
  console.error(
    `\n[release] ⚠ npm 已发布 ${next}，但 git 提交/推送失败：` +
      `${err instanceof Error ? err.message : String(err)}\n` +
      "  请手动完成：git add package.json package-lock.json && " +
      `git commit -m "chore(release): 发布 ${next}" && git tag v${next} && git push origin HEAD --tags`,
  );
  process.exit(1);
}

console.error(`\n[release] 全部完成：${pkg.name}@${next}`);
