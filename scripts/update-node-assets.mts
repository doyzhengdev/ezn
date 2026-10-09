// 内置版本常量表（versions.json）生成器：拉取 nodejs.org/dist/index.json，取主版本范围
// （MAJOR_FROM~MAJOR_TO）内每个主版本的最新一次发布，重写 src/versions.json。
// 该表是 ezn 的「版本唯一事实源」：Node.ensure 按版本描述（"18" | "18.1" | "18.1.5"）
// 在表内做组件级前缀匹配取确切 patch 版本（构建期内联进产物）。
// 更新后须重跑 npm run build 刷新 dist/ 产物。
// 新增主版本 = 调整下方 MAJOR_FROM/MAJOR_TO 后重跑本脚本。
//
// 后缀 .mts：本包是 `type: "commonjs"`，`.ts` 会被 Node 按 CJS 加载（本脚本用 ESM 语法 +
// 顶层 await）；`.mjs` 同为 ESM，但与 scripts/ 下其余脚本（release.mts / build.mts）统一为
// .mts——脚本命名只留一种规则。
//
// 用法：npm run update-assets（需可访问 nodejs.org）

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MAJOR_FROM: number = 18;
const MAJOR_TO: number = 26;

/** nodejs.org/dist/index.json 里的一条发布记录（本脚本只消费 version） */
interface Release {
  version: string;
}

// 三段 semver 比较（x.y.z 数字逐段比较）
function compareSemver(a: string, b: string): number {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

// —— 1. 官方 index.json：取范围内各主版本最新发布 ——
console.log(`[update-node-assets] 拉取发布索引（主版本 ${MAJOR_FROM}~${MAJOR_TO}）...`);
const res = await fetch("https://nodejs.org/dist/index.json");
if (!res.ok) {
  console.error(`[update-node-assets] 拉取 index.json 失败：HTTP ${res.status}`);
  process.exit(1);
}
const index = (await res.json()) as Release[];

const latestByMajor: Record<number, Release> = {};
for (const release of index) {
  const m = /^v(\d+)\./.exec(release.version ?? "");
  const major = m ? Number(m[1]) : 0;
  if (major < MAJOR_FROM || major > MAJOR_TO) continue;
  const cur = latestByMajor[major];
  if (!cur || compareSemver(release.version, cur.version) > 0) latestByMajor[major] = release;
}

// —— 2. 写 src/versions.json ——
const table: Record<string, { version: string }> = {};
for (const [major, release] of Object.entries(latestByMajor).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  table[major] = { version: release.version };
}
writeFileSync(resolve(pkgRoot, "src", "versions.json"), JSON.stringify(table, null, 2) + "\n", "utf-8");
console.log(
  `[update-node-assets] 已生成 ${Object.keys(table).length} 个主版本（${Object.keys(table)
    .map((k) => `${k}=${table[k]?.version}`)
    .join("、")}）→ src/versions.json（记得重跑 npm run build 刷新 dist/ 产物）`,
);
