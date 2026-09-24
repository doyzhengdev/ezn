# ezn

> 在项目固定版本的托管 Node 上执行任意命令。零系统依赖，不用装 nvm / fnm / volta。

[English](README.en.md) | 简体中文

`ezn` 按需把一个固定版本的 Node 运行时下载并落位到**项目自己的** `node/` 目录，然后在该运行时上执行你给的命令——`vitest`、`tsc`、`vite`，或任何别的东西。

```bash
npx @doyzheng/ezn node -v        # 用项目固定的 Node 版本
npx @doyzheng/ezn vitest run     # 在该 Node 上跑测试
```

版本只在 `package.json` 里声明一次：

```json
{
  "ezn": { "node": "22" }
}
```

## 为什么

常见做法各有代价：**nvm / fnm / volta** 需要在每台机器上单独安装并配置 shell hook，且是全局状态——不同项目要来回 `nvm use`；**`npx nve 22 <cmd>`** 免安装，但版本写在命令行里，每个脚本都得重复一遍，改版本要全仓搜索替换。

`ezn` 的取舍是：**版本进配置文件，运行时进项目目录**。

- **零安装**：`npx @doyzheng/ezn` 即可，团队新人 clone 下来就能跑，不需要装任何版本管理器。
- **版本是配置不是命令**：一个项目一个版本，写在 `package.json` 里，脚本里只写 `ezn vitest run`。
- **运行时随项目走**：落在 `<项目>/node/`，和项目同生命周期。想清理就直接删掉那个目录。
- **只下一个版本**：不像 nvm 那样在全局缓存里堆一大堆版本。

代价是每个项目各有一份运行时（约 100MB），且**必须**把它加进 `.gitignore`。

## 安装

不需要安装。用 `npx` 直接跑：

```bash
npx @doyzheng/ezn --help
```

想固定下来（推荐）——作为 devDependency 装进项目，这样团队里每个人拿到的版本一致：

```bash
npm install -D @doyzheng/ezn
```

> 包名带 scope，但 **bin 名就是 `ezn`**，所以 `node_modules/.bin/ezn` 照常生成，下面的脚本写法一个字都不用改。只有 `npx` 全局直调才需要写全名 `@doyzheng/ezn`。

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

在**项目根**的 `package.json` 里加一段 `ezn`：

```json
{
  "ezn": {
    "node": "22",
    "dir": "node",
    "tools": { "pnpm": "10.34.5" },
    "mirror": "https://registry.npmmirror.com/-/binary/node",
    "nodeBin": "/path/to/node"
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `node` | 是 | 版本描述，`"22"` \| `"22.13"` \| `"22.13.5"` 三种写法（1~3 段数字） |
| `dir` | 否 | 安装目录名，相对项目根。默认 `node` |
| `tools` | 否 | 要装进运行时的工具（包名 → 版本），如 `{ "pnpm": "10.34.5" }`。版本可省略（见下） |
| `mirror` | 否 | 下载镜像，目录结构需与 `nodejs.org/dist` 一致 |
| `nodeBin` | 否 | 逃生口：指定一个现成的 node 可执行文件，跳过下载与落位 |

> 包管理器版本也可以只写顶层 `packageManager`（npm 官方字段）：`"packageManager": "pnpm@10.34.5"`。

**配置是向上就近查找的**——和 `.nvmrc` / `.node-version` 一样。在子包里执行就用子包的配置，在仓库根执行就用根的配置，所以 monorepo 里每个子包可以锁定不同版本。

写 `"22"` 而不是 `"22.13.5"` 通常更好：ezn 会在内置版本表里按**组件级前缀**匹配到该主版本最新的一个 patch（`"22"` → `v22.23.2`），等于自动拿到安全更新。写全三段则精确锁定。注意 `"22.1"` **不会**匹配到 `22.13.x`——前缀是逐段比对的。

### 工具（`tools`）

声明在这里的工具会被装进**运行时目录**（Windows 为 `<项目>/node/node_modules/`，POSIX 为 `<项目>/node/lib/node_modules/`），而不是宿主的全局目录——版本随项目走，不受机器上装了什么影响。

```json
"ezn": { "node": "24", "tools": { "pnpm": "10.34.5" } }
```

**版本三级回退**（越靠前越优先）：

| 优先级 | 来源 | 例子 |
|---|---|---|
| 1 | `ezn.tools.<包名>` 显式声明 | `"tools": { "pnpm": "9.15.0" }` |
| 2 | 顶层 `packageManager` 字段 | `"packageManager": "pnpm@10.34.5"` |
| 3 | 兜底：装 **pnpm 最新版** | 两者都没配时 |

第 2 级的意义：`packageManager` 已是「本项目用哪个包管理器、哪个版本」的既有事实源，让 `tools` 再抄一份版本就是第二处声明。所以大多数项目**什么都不用配**——写一句 `"packageManager": "pnpm@10.34.5"` 就够了。只有想偏离它时才写 `tools`。

- 缺则用运行时自带的 npm 装；版本不符则重装；已就位则零开销（只读一次 `package.json`）
- 装完 `ezn pnpm ...` 就命中这一份：`resolveCommand` 第 3 步查运行时目录，早于 PATH
- 版本写 `"10.34.5"` 精确匹配，或 `"^10"` / `"~10"` 前缀放行
- **确实不关心版本**时写 `"*"`：装一次最新，之后靠 `<运行时目录>/.ezn-tools/<包名>` 标记跳过。
  **想强制重装 latest 就删掉那个标记文件**
- **失败只警告，不阻塞命令**（断网时 `ezn pnpm ...` 仍会回落到宿主 PATH 的那份）

> 装工具时会执行包自身的 lifecycle 脚本（**不加 `--ignore-scripts`**）。这是必需的：`pnpm` 12 起
> 包根那个 `pnpm` 是无扩展名的占位脚本，靠 `postinstall` 把它替换成原生二进制并改写 `bin`；
> 跳过脚本会让 Windows 下的 `pnpm.cmd` 指向一个 cmd.exe 执行不了的文件（报「不是内部或外部命令」）。
> 代价是自动装工具时会执行被装包的安装脚本，请自行评估供应链信任。

> 配置写错时**一定会报警**：非字符串版本、非法版本描述、空包名都会打印 `[ezn] 忽略…`。
> 静默丢弃是最难排查的一类配置错误（表现为「明明配了却没装」），故不做静默处理。

> ⚠️ **配置键名曾是 `ezllm-node`**（0.0.1 时代），自 **0.0.2** 起改为 `ezn`，与包名一致。
> 旧键名**不再被读取**，既有项目需手工改名：把 `package.json` 里的 `"ezllm-node"` 段整体改名为 `"ezn"`。

**务必把运行时目录加进 `.gitignore`**，否则上百 MB 的运行时会被 git 追踪：

```gitignore
/node/
```

## 平台支持

支持 **Windows / macOS / Linux** 三平台，各含 `x64` 与 `arm64`：

| 平台 | `process.platform-arch` | 发行包 | 解压 |
|---|---|---|---|
| Windows x64 | `win32-x64` | zip | `extract-zip` |
| Windows arm64 | `win32-arm64` | zip | `extract-zip` |
| macOS Intel | `darwin-x64` | tar.gz | `tar` |
| macOS Apple Silicon | `darwin-arm64` | tar.gz | `tar` |
| Linux x64 | `linux-x64` | tar.gz | `tar` |
| Linux arm64 | `linux-arm64` | tar.gz | `tar` |

其它组合（`linux-ia32`、`linux-ppc64le`、`linux-s390x`、`win32-ia32`、BSD 等）会在安装时抛出
**「暂不支持的平台」**并给出手动放置指引。若你已在目标目录手动放好运行时，则不会触发下载、也就不会报这个错。

### 验证状态（请务必读）

上表是**声明支持**，不等于**逐一验证过**。实际情况：

| 平台 | 验证程度 |
|---|---|
| Windows x64 | 开发与全部测试的所在平台，覆盖较充分 |
| Linux / macOS | 由下游项目（`ezllm`）的跨平台 CI 间接覆盖——它的包脚本经 `ezn` 调用，会真实完成下载 + 解压 + 落位 + 执行（具体架构取决于其使用的 runner 标签） |
| arm64（各平台） | **未被本包自身的测试覆盖** |

本仓库**自身没有 CI**，且单元测试只在一个平台上跑——平台相关的断言写法是「在本机断言、在他机跳过」，
所以非本机分支的**测试覆盖率实际为 0**。此外 tar.gz 解压链路在单测里被 mock，未在仓库内端到端跑过。

> 换句话说：Windows x64 之外，请把本包当作**「设计上支持、但未充分验证」**来评估。

### 已知限制

- **Alpine / musl 不支持，且失败方式不友好。** 平台键只看 `platform-arch`，musl 上仍是 `linux-x64`，
  于是会下载 glibc 构建 → 解压成功 → **执行失败 → 判定「疑似损坏」→ 反复重装**。容器化部署请用
  glibc 基础镜像，或改用 `nodeBin` 指向自备的 musl 版 node。
- **运行时目录不可跨平台共享。** 合并路径（共享目录的判定）在**模块加载时**按当前平台固化，
  且锁名不含平台段。若把同一个 `<项目>/node` 放到多台异构机共享（漫游目录、WSL 访问 Windows 目录、
  网络盘），会互相覆盖对方的 node、来回重装约 100MB。请把运行时目录放在**平台独占**的位置。
- **POSIX 权限位依赖 tar 还原，无兜底。** 代码不做 `chmod`；若某个镜像重打包丢了执行位，
  会进入「探测失败 → 重装 → 仍失败」的循环（报错只说「疑似损坏」）。
- **大小写敏感性差异。** 配置键、包名、落位时的同名判定都未做大小写归一。在大小写不敏感的文件系统上
  （Windows / macOS 默认），`{"EZN":{"NODE":"22"}}` 能读到、在 Linux 上会被静默忽略；
  `README.md` 与 `readme.md` 在落位时会被视为同名项。请统一用小写。
- **源码 clone 后 `./bin/ezn.js` 在 POSIX 上不可直接执行**（git 里是 `100644`）。属正常：
  装成依赖（`npm i -D @doyzheng/ezn`）时 npm 会补上执行位；只从源码跑请用 `node bin/ezn.js`。

## 用法

```
用法：ezn <命令> [参数...]
```

| 命令 | 作用 |
|---|---|
| `ezn <命令> [参数...]` | 在项目固定的 Node 上执行命令 |
| `ezn` | 不执行命令，只打印本次会用的运行时信息 |
| `ezn node -v` | 显式使用运行时自带的 node |
| `ezn npm i -g <包>` | 用运行时自带的 npm 装全局包（**恒装进运行时目录**） |
| `ezn --version` | 打印 ezn 自身版本 |
| `ezn --help` | 打印帮助 |

`ezn npm` 的**全局操作**（`-g` / `--global`）会被强制锁定到运行时目录——注入 `--prefix <运行时目录>`：

```bash
ezn npm i -g some-cli     # → <项目>/node/node_modules/，宿主 ~/.npmrc 的 prefix 也劫持不走
```

为什么必须显式锁定：npm 的 globalPrefix 默认由 node 位置推导（托管 node → 托管目录），但用户 `~/.npmrc` 里一个 `prefix=` 就能把它改到别处。那种情况下装是"成功"了，却装错地方，`ezn <命令>` 找不到它——静默失效。

**只对全局操作注入**：`--prefix` 对非全局命令的含义是「改项目根目录」，不是「改安装位置」。往运行时目录跑 `npm install --prefix <rt> <包>` 会把该目录当项目根，写入 `package.json` / `package-lock.json`，并把其中不在依赖树里的既有包铲掉——而运行时目录里躺着托管包，那等于让服务找不到自己的入口。所以：

```bash
ezn npm i some-cli        # 原样透传 → 装进当前项目的 node_modules（项目本地依赖）
ezn npm run build         # 原样透传 → 在当前项目里跑脚本
```

命令查找顺序（命中即返回）：

1. `node` / `npm` / `npx` → 本运行时的对应可执行
2. 含路径分隔符 → 当作路径执行。目标是 `.js` / `.mjs` / `.cjs` 时**用运行时 node 执行它**——
   否则会因 shebang 落到宿主 node，且 Windows 上直接 spawn 这类文件会报 `EFTYPE`
3. 运行时目录下的同名可执行（`npm i -g` 装的包会落在那里）
4. 自当前目录逐级向上找 `node_modules/.bin/<名字>`
5. 系统 `PATH`

所以 `ezn vitest run` 里的 `vitest` 由**你的项目**提供，`ezn` 自己不依赖它——但它在第 4 步才被找到，即仍需正常安装项目依赖。

子进程的 `PATH` 会把运行时目录前置，因此在第 3–5 步命中的命令**内部再调 `node` 时，命中的仍是本运行时的 node**——这是「固定版本」承诺的一部分。

### 环境变量

本包**不读任何环境变量**——配置的唯一数据源是 `package.json` 的 `ezn` 段（`mirror` / `nodeBin` 等）。
进程环境会影响行为的话，「实际用了哪个镜像 / 哪份 node」就变得不可见、不可测。

下载源按顺序为 `ezn.mirror` → `registry.npmmirror.com` → `nodejs.org`，逐个重试。国内网络下开箱可用。

## 编程接口

如果你需要在代码里（而不只是命令行）管理这个运行时，包同时导出一个 `Node` 类：

```ts
import { Node } from "@doyzheng/ezn";

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
├── node.exe                    ← Windows；POSIX 为 bin/node
├── node_modules/npm/           ← 自带 npm / npx / corepack
├── node_modules/pnpm/          ← `ezn.tools` 装的工具（你装的全局包也在这里）
└── lib/node_modules/           ← POSIX 下自带包与全局包都在这个位置
```

（Windows 的包在 `<rt>/node_modules/`，POSIX 的在 `<rt>/lib/node_modules/`——这是两平台 npm 全局
布局的差异，代码在两个位置都会查找。上图画在一起只为说明「自带包与托管包同处一个共享目录」。）

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
npm run build          # tsdown（rolldown）→ dist/
npm test               # 构建 + 跑全部测试（100 个）
npm run typecheck
npm run update-assets  # 拉 nodejs.org 刷新 src/versions.json（需联网）
```

`dist/` 已 gitignore、不入库，但**在 `package.json` 的 `files` 里**——发布前**必须**先 `npm run build`，
否则会发出缺产物或产物陈旧的包。`npm run release` 只做「bump 版本 → `npm publish` → 提交打 tag」，
**它自己不再触发构建与测试**（`prepack` / `prepublishOnly` 已于 0.0.6 移除）。

`src/versions.json` 是版本表的**唯一事实源**，由 `scripts/update-node-assets.mjs` 生成，**不要手改**。要新增支持的主版本，改那个脚本顶部的 `MAJOR_FROM` / `MAJOR_TO` 后重跑。

> **加平台相关改动前请读**：本仓库无 CI，测试只在当前平台真实执行，非本机分支靠
> `if (process.platform === "win32")` 跳过。改动涉及平台分支时，请至少在本机跑通，
> 并明确告知「未在哪些平台验证」。`test/flat-ensure.test.ts` 用覆写 `process.platform`
> + `vi.resetModules()` 模拟 POSIX 合并路径，可参考那种写法补覆盖。

## License

MIT
