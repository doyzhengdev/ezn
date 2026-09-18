# ezn

> 在项目固定版本的托管 Node 上执行任意命令。零系统依赖，不用装 nvm / fnm / volta。

`ezn` 按需把一个固定版本的 Node 运行时下载并落位到**项目自己的** `node/` 目录，然后在该运行时上执行你给的命令——`vitest`、`tsc`、`vite`，或任何别的东西。

```bash
npx ezn node -v        # 用项目固定的 Node 版本
npx ezn vitest run     # 在该 Node 上跑测试
```

版本只在 `package.json` 里声明一次：

```json
{
  "ezllm-node": { "node": "22" }
}
```

## 为什么

常见做法各有代价：**nvm / fnm / volta** 需要在每台机器上单独安装并配置 shell hook，且是全局状态——不同项目要来回 `nvm use`；**`npx nve 22 <cmd>`** 免安装，但版本写在命令行里，每个脚本都得重复一遍，改版本要全仓搜索替换。

`ezn` 的取舍是：**版本进配置文件，运行时进项目目录**。

- **零安装**：`npx ezn` 即可，团队新人 clone 下来就能跑，不需要装任何版本管理器。
- **版本是配置不是命令**：一个项目一个版本，写在 `package.json` 里，脚本里只写 `ezn vitest run`。
- **运行时随项目走**：落在 `<项目>/node/`，和项目同生命周期。想清理就直接删掉那个目录。
- **只下一个版本**：不像 nvm 那样在全局缓存里堆一大堆版本。

代价是每个项目各有一份运行时（约 100MB），且**必须**把它加进 `.gitignore`。

## 安装

不需要安装。用 `npx` 直接跑：

```bash
npx ezn --help
```

想固定下来（推荐）——作为 devDependency 装进项目，这样团队里每个人拿到的版本一致：

```bash
npm install -D ezn
```

然后在 `package.json` 的脚本里直接用 `ezn`：

```json
{
  "scripts": {
    "test": "ezn vitest run",
    "typecheck": "ezn tsc",
    "build": "ezn vite build"
  }
}
```

## 配置

在**项目根**的 `package.json` 里加一段 `ezllm-node`：

```json
{
  "ezllm-node": {
    "node": "22",
    "dir": "node"
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `node` | 是 | 版本描述，`"22"` \| `"22.13"` \| `"22.13.5"` 三种写法（1~3 段数字） |
| `dir` | 否 | 安装目录名，相对项目根。默认 `node` |

**配置是向上就近查找的**——和 `.nvmrc` / `.node-version` 一样。在子包里执行就用子包的配置，在仓库根执行就用根的配置，所以 monorepo 里每个子包可以锁定不同版本。

写 `"22"` 而不是 `"22.13.5"` 通常更好：ezn 会在内置版本表里按**组件级前缀**匹配到该主版本最新的一个 patch（`"22"` → `v22.23.2`），等于自动拿到安全更新。写全三段则精确锁定。注意 `"22.1"` **不会**匹配到 `22.13.x`——前缀是逐段比对的。

> ⚠️ **`ezllm-node` 这个键名是历史遗留**，取自本项目的来源仓库，与包名 `ezn` 不一致。之所以还没改，是因为它是**破坏性的**：改名会让所有既有项目的配置失效。计划在 `1.0.0` 时统一改为 `ezn`，届时会同时支持两个键名并给出迁移提示。

**务必把运行时目录加进 `.gitignore`**，否则上百 MB 的运行时会被 git 追踪：

```gitignore
/node/
```

## 用法

```
用法：ezn <命令> [参数...]
```

| 命令 | 作用 |
|---|---|
| `ezn <命令> [参数...]` | 在项目固定的 Node 上执行命令 |
| `ezn` | 不执行命令，只打印本次会用的运行时信息 |
| `ezn node -v` | 显式使用运行时自带的 node |
| `ezn npm i -g <包>` | 用运行时自带的 npm 装全局包（装进该运行时） |
| `ezn --version` | 打印 ezn 自身版本 |
| `ezn --help` | 打印帮助 |

命令查找顺序（命中即返回）：

1. `node` / `npm` / `npx` → 本运行时的对应可执行
2. 含路径分隔符 → 当作路径直接执行
3. 运行时目录下的同名可执行（`npm i -g` 装的包会落在那里）
4. 自当前目录逐级向上找 `node_modules/.bin/<名字>`
5. 系统 `PATH`

所以 `ezn vitest run` 里的 `vitest` 由**你的项目**提供，`ezn` 自己不依赖它——但它在第 4 步才被找到，即仍需正常安装项目依赖。

### 环境变量

| 变量 | 作用 |
|---|---|
| `ELLM_NODE_MIRROR` | 下载镜像。目录结构需与 `nodejs.org/dist` 一致 |
| `ELLM_NODE_BIN` | 逃生口：指定一个现成的 node 可执行文件，跳过下载与落位 |

默认下载源按顺序为 `ELLM_NODE_MIRROR` → `registry.npmmirror.com` → `nodejs.org`，逐个重试。国内网络下开箱可用。

## 编程接口

如果你需要在代码里（而不只是命令行）管理这个运行时，包同时导出一个 `Node` 类：

```ts
import { Node } from "ezn";

// 确保 <appDir>/node 下有 Node 22，返回实例
const node = await Node.ensure(appDir, "22");

await node.npm(["i", "-g", "some-pkg"]);        // 用自带 npm 执行
const { stdout } = await node.exec(["-e", "console.log(1)"]);
```

- `Node.ensure(appDir, nodeVersion)` —— 探测 / 复用 / 重装 / 下载安装，幂等，返回 `Node` 实例。
- `Node.probeMajor(nodePath)` —— 执行 `node -v` 解析主版本；不可执行返回 `null`。
- 实例属性：`path`、`rt`、`major`、`npmCliPath`、`npxCliPath`。
- 实例方法：`exec` / `npm` / `npx` 及各自的 `Sync` 版本。

参数语义：**数组 = 精确 argv**（每项一个参数，不做分发）；**字符串 = 命令行写法**，按空白拆分，首词为 `node` / `npm` / `npx` 时自动分发（如 `execSync("npm i -g x")`）。含空格或引号的参数请用数组形式。

CJS / ESM 双形态，`engines: >=16`。

## 它是怎么工作的

**布局与官方 Node 发行包同构**，只去掉顶层版本目录：

```
<项目>/node/
├── node.exe          ← Windows；POSIX 为 bin/node
├── node_modules/npm/ ← 自带 npm / npx / corepack
└── lib/node_modules/ ← POSIX 下是这个位置
```

没有版本目录层（不是 nvm 的 `versions/v22.13.5/`），因为版本由配置唯一定义，一个项目只需要一个运行时。

**落位一律逐条目进行，绝不删除与本次安装无关的文件。** 这是本项目最核心的设计约束，因为运行时目录同时是**全局包的安装位置**（`ezn npm i -g` 装的东西就在那儿）。所以：

- 同名条目（`node.exe`、`README.md` …）先备份为 `<名字>.old-<时间戳>` 再覆盖；
- 共享目录（`node_modules/`）**按子项合并**，目标独有的子项原地不动——你装的全局包因此得以幸存；
- 升级版本时同理，不会有东西被静默抹掉。

两种显而易见的做法都是错的，都实测过：

- **整目录覆盖 / 清空** → 已装的全局包被抹掉；
- **「已存在就整个跳过」** → 包先装、运行时后落位时，自带 npm 永远装不进去。

落位失败时**保留现场、不回滚**（回滚可能删掉已被覆盖的文件），已备份项的位置会在输出里列出来。

**跨进程串行化**：多个 `ezn` 进程并发落位同一个目录时，用目录锁（`mkdir` 原子性）串行化。抢不到锁的进程轮询等待，持锁者装完就直接复用，不会重复下载。

## 开发

```bash
npm install
npm run build          # esbuild + tsc → dist/
npm test               # 构建 + 跑全部测试（73 个）
npm run typecheck
npm run update-assets  # 拉 nodejs.org 刷新 src/versions.json（需联网）
```

`dist/` 不入库，由 `prepack` 在发布时重新构建。

`src/versions.json` 是版本表的**唯一事实源**，由 `scripts/update-node-assets.mjs` 生成，**不要手改**。要新增支持的主版本，改那个脚本顶部的 `MAJOR_FROM` / `MAJOR_TO` 后重跑。

## License

MIT
