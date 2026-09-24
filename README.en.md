# ezn

> Run any command on a pinned, project-local Node runtime. Zero system dependencies — no nvm / fnm / volta.

[简体中文](README.md) | English

`ezn` downloads a pinned Node runtime on demand, lands it in the **project's own** `node/` directory, then runs your command on that runtime — `vitest`, `tsc`, `vite`, or anything else.

```bash
npx @doyzheng/ezn node -v        # uses the project's pinned Node version
npx @doyzheng/ezn vitest run     # runs tests on that Node
```

The version is declared once, in `package.json`:

```json
{
  "ezn": { "node": "22" }
}
```

## Why

The common approaches each have a cost. **nvm / fnm / volta** must be installed on every machine with shell hooks configured, and they are global state — you keep switching with `nvm use` between projects. **`npx nve 22 <cmd>`** needs no install, but the version lives on the command line: every script repeats it, and changing it means a repo-wide search-and-replace.

`ezn` trades differently: **the version goes in a config file, the runtime goes in the project directory.**

- **Zero install**: `npx @doyzheng/ezn` is enough. New teammates just clone and run — no version manager to install.
- **Version is config, not a command**: one version per project, declared in `package.json`; scripts just say `ezn vitest run`.
- **Runtime travels with the project**: it lands in `<project>/node/` and shares the project's lifecycle. To clean up, delete that directory.
- **Only one version downloaded**: unlike nvm, which piles up versions in a global cache.

The cost is one runtime per project (about 100MB), and you **must** add it to `.gitignore`.

## Install

No install needed — run it with `npx`:

```bash
npx @doyzheng/ezn --help
```

To pin it (recommended) — install it as a devDependency so everyone on the team gets the same version:

```bash
npm install -D @doyzheng/ezn
```

> The package name is scoped, but **the bin name is just `ezn`**, so `node_modules/.bin/ezn` is generated as usual and none of the script examples below change. Only a global `npx` invocation needs the full name `@doyzheng/ezn`.

Then use `ezn` directly in your `package.json` scripts:

```json
{
  "scripts": {
    "test": "ezn vitest run",
    "typecheck": "ezn tsc",
    "build": "ezn vite build"
  }
}
```

## Configuration

Add an `ezn` section to the **project root** `package.json`:

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

| Field | Required | Description |
|---|---|---|
| `node` | yes | Version spec: `"22"` \| `"22.13"` \| `"22.13.5"` (1–3 numeric segments) |
| `dir` | no | Install directory name, relative to the project root. Defaults to `node` |
| `tools` | no | Tools to install into the runtime (name → version), e.g. `{ "pnpm": "10.34.5" }`. The version may be omitted (see below) |
| `mirror` | no | Download mirror; the directory layout must match `nodejs.org/dist` |
| `nodeBin` | no | Escape hatch: point at an existing node executable, skipping download and landing |

> The package manager version can also live in the top-level `packageManager` field (an official npm field): `"packageManager": "pnpm@10.34.5"`.

**Config is resolved by walking up from the current directory** — same as `.nvmrc` / `.node-version`. Running inside a sub-package uses that sub-package's config; running at the repo root uses the root's. In a monorepo, each package can therefore pin a different version.

Writing `"22"` instead of `"22.13.5"` is usually better: ezn matches it against its built-in version table by **segment-wise prefix**, picking the latest patch of that major (`"22"` → `v22.23.2`) — effectively automatic security updates. Writing all three segments pins exactly. Note that `"22.1"` does **not** match `22.13.x`; the prefix is compared segment by segment.

### Tools (`tools`)

Tools declared here are installed into the **runtime directory** (Windows: `<project>/node/node_modules/`; POSIX: `<project>/node/lib/node_modules/`), not your global prefix — versions travel with the project and are unaffected by whatever the machine has installed.

```json
"ezn": { "node": "24", "tools": { "pnpm": "10.34.5" } }
```

**Three-level version fallback** (earlier wins):

| Priority | Source | Example |
|---|---|---|
| 1 | `ezn.tools.<name>` declared explicitly | `"tools": { "pnpm": "9.15.0" }` |
| 2 | Top-level `packageManager` field | `"packageManager": "pnpm@10.34.5"` |
| 3 | Fallback: install the **latest pnpm** | when neither is configured |

The point of level 2: `packageManager` is already the existing source of truth for "which package manager, which version" — having `tools` restate the version would be a second declaration. So most projects **need no configuration at all**: one `"packageManager": "pnpm@10.34.5"` line is enough. Write `tools` only to deviate from it.

- Missing → installed with the runtime's own npm; wrong version → reinstalled; already present → zero overhead (one `package.json` read)
- Once installed, `ezn pnpm ...` hits that copy: step 3 of `resolveCommand` checks the runtime directory, before PATH
- Versions compare exactly (`"10.34.5"`), or allow a prefix (`"^10"` / `"~10"`)
- **When you genuinely don't care about the version**, write `"*"`: install latest once, then skip via a `<runtime dir>/.ezn-tools/<name>` marker.
  **To force a latest reinstall, delete that marker file**
- **Failures only warn, they don't block the command** (offline, `ezn pnpm ...` still falls back to whatever is on the host PATH)

> Installing a tool runs that package's own lifecycle scripts (**`--ignore-scripts` is not passed**). This is
> required: since pnpm 12, the `pnpm` file at the package root is an extensionless placeholder that a
> `postinstall` script replaces with the native binary and rewrites `bin` for; skipping scripts leaves the
> Windows `pnpm.cmd` shim pointing at a file cmd.exe cannot execute ("is not recognized as an internal or
> external command"). The cost is that auto-installing tools executes the installed package's install
> scripts — assess supply-chain trust accordingly.

> Misconfiguration **always warns**: non-string versions, invalid version specs, and empty package names all print `[ezn] ignoring …`.
> Silent drops are the hardest class of config error to diagnose (they look like "I configured it but it wasn't installed"), so nothing is dropped silently.

> ⚠️ **The config key used to be `ezllm-node`** (the 0.0.1 era) and changed to `ezn` in **0.0.2**, matching the package name.
> The old key is **no longer read**; existing projects must rename it by hand: rename the `"ezllm-node"` section in `package.json` to `"ezn"`.

**Do add the runtime directory to `.gitignore`**, or the hundred-megabyte runtime will be tracked by git:

```gitignore
/node/
```

## Platform support

Supported on **Windows / macOS / Linux**, each with `x64` and `arm64`:

| Platform | `process.platform-arch` | Archive | Extraction |
|---|---|---|---|
| Windows x64 | `win32-x64` | zip | `extract-zip` |
| Windows arm64 | `win32-arm64` | zip | `extract-zip` |
| macOS Intel | `darwin-x64` | tar.gz | `tar` |
| macOS Apple Silicon | `darwin-arm64` | tar.gz | `tar` |
| Linux x64 | `linux-x64` | tar.gz | `tar` |
| Linux arm64 | `linux-arm64` | tar.gz | `tar` |

Other combinations (`linux-ia32`, `linux-ppc64le`, `linux-s390x`, `win32-ia32`, BSD, …) throw
**"unsupported platform"** at install time, with manual-placement instructions. If you have already placed a
runtime in the target directory by hand, no download is triggered and that error never appears.

### Verification status (please read)

The table above is **declared** support, not **individually verified** support. In practice:

| Platform | How well verified |
|---|---|
| Windows x64 | The platform where development and all tests happen; reasonably covered |
| Linux / macOS | Covered indirectly by a downstream project's (`ezllm`) cross-platform CI — its package scripts go through `ezn`, really performing download + extraction + landing + execution (the exact architecture depends on the runner labels it uses) |
| arm64 (any platform) | **Not covered by this package's own tests** |

This repository **has no CI of its own**, and the unit tests run on a single platform — platform-dependent
assertions are written as "assert on this host, skip elsewhere", so **test coverage of non-host branches is
effectively zero**. The tar.gz extraction path is also mocked in unit tests and never exercised end-to-end
inside this repo.

> In other words: outside Windows x64, treat this package as **"supported by design, but not well verified"**.

### Known limitations

- **Alpine / musl is unsupported, and fails ungracefully.** The platform key only looks at `platform-arch`,
  so on musl it is still `linux-x64`: ezn downloads the glibc build, extracts it successfully, and then
  **fails to execute it → concludes "probably corrupt" → reinstalls forever**. For containers, use a glibc
  base image, or point `nodeBin` at your own musl node build.
- **The runtime directory must not be shared across platforms.** The merge paths (which determine shared
  directories) are fixed **at module load time** for the current platform, and lock names carry no platform
  segment. Sharing one `<project>/node` across heterogeneous machines (roaming profiles, WSL reading a
  Windows directory, network drives) makes them overwrite each other's node and re-download ~100MB back and
  forth. Keep the runtime directory **platform-exclusive**.
- **POSIX permission bits depend on tar, with no fallback.** The code never calls `chmod`; if a mirror
  repacks an archive and loses the executable bit, you get a "probe fails → reinstall → still fails" loop
  (the error only says "probably corrupt").
- **Case-sensitivity differences.** Config keys, package names, and same-name detection while landing are
  not case-normalized. On case-insensitive filesystems (Windows, macOS by default) `{"EZN":{"NODE":"22"}}`
  is read, while on Linux it is silently ignored; and `README.md` versus `readme.md` are treated as the same
  entry when landing. Stick to lowercase.
- **After a source clone, `./bin/ezn.js` is not directly executable on POSIX** (it is `100644` in git).
  This is expected: installing it as a dependency (`npm i -D @doyzheng/ezn`) lets npm set the executable
  bit; to run from source, use `node bin/ezn.js`.

## Usage

```
Usage: ezn <command> [args...]
```

| Command | What it does |
|---|---|
| `ezn <command> [args...]` | Run the command on the project's pinned Node |
| `ezn` | Run nothing; print the runtime that would be used |
| `ezn node -v` | Explicitly use the runtime's own node |
| `ezn npm i -g <pkg>` | Install a global package with the runtime's own npm (**always into the runtime directory**) |
| `ezn --version` | Print ezn's own version |
| `ezn --help` | Print help |

`ezn npm`'s **global operations** (`-g` / `--global`) are forcibly pinned to the runtime directory by injecting `--prefix <runtime dir>`:

```bash
ezn npm i -g some-cli     # → <project>/node/node_modules/, safe from a prefix= in your ~/.npmrc
```

Why the explicit pin: npm's globalPrefix is normally derived from the node location (managed node → managed
directory), but a single `prefix=` in your `~/.npmrc` can redirect it. In that case the install "succeeds"
into the wrong place and `ezn <command>` cannot find it — a silent failure.

**Only global operations get the injection**: for a non-global command, `--prefix` means "change the project
root", not "change the install location". Running `npm install --prefix <rt> <pkg>` against the runtime
directory treats that directory as a project root: it writes `package.json` / `package-lock.json` and prunes
existing packages that aren't in that dependency tree — while the runtime directory holds managed packages,
which would leave the service unable to find its own entry point. Hence:

```bash
ezn npm i some-cli        # passed through → installed into the current project's node_modules (a local dep)
ezn npm run build         # passed through → runs the script in the current project
```

Command resolution order (first hit wins):

1. `node` / `npm` / `npx` → this runtime's corresponding executable
2. Contains a path separator → treated as a path. If the target is `.js` / `.mjs` / `.cjs` it is **executed
   with the runtime's node** — otherwise its shebang lands on the host node, and on Windows spawning such a
   file directly reports `EFTYPE`
3. A same-named executable in the runtime directory (where `npm i -g` puts packages)
4. Walking up from the current directory for `node_modules/.bin/<name>`
5. The system `PATH`

So the `vitest` in `ezn vitest run` is provided by **your project** — ezn does not depend on it — but it is
only found at step 4, meaning project dependencies must still be installed normally.

The child process's `PATH` has the runtime directory prepended, so commands found at steps 3–5 that
**invoke `node` internally will hit this runtime's node** — part of the pinned-version promise.

### Environment variables

This package **reads no environment variables** — the single source of configuration is the `ezn` section of
`package.json` (`mirror` / `nodeBin` / …). If the process environment could change behavior, "which mirror /
which node was actually used" would become invisible and untestable.

Download sources are tried in order: `ezn.mirror` → `registry.npmmirror.com` → `nodejs.org`, with retries.

## Programmatic API

To manage the runtime from code rather than the command line, the package also exports a `Node` class:

```ts
import { Node } from "@doyzheng/ezn";

// Ensure Node 22 exists under <appDir>/node, returning an instance
const node = await Node.ensure(appDir, "22");

await node.npm(["i", "-g", "some-pkg"]);        // run with the bundled npm
const { stdout } = await node.exec(["-e", "console.log(1)"]);
```

- `Node.ensure(appDir, nodeVersion)` — probe / reuse / reinstall / download-and-install; idempotent; returns a `Node` instance.
- `Node.probeMajor(nodePath)` — run `node -v` and parse the major version; returns `null` if not executable.
- Instance properties: `path`, `rt`, `major`, `npmCliPath`, `npxCliPath`.
- Instance methods: `exec` / `npm` / `npx` plus their `Sync` variants.

Argument semantics: **an array means exact argv** (one argument per item, no dispatch); **a string means
command-line style**, split on whitespace, with the first word dispatching automatically when it is
`node` / `npm` / `npx` (e.g. `execSync("npm i -g x")`). Use the array form for arguments containing spaces
or quotes.

Dual CJS / ESM, `engines: >=16`.

## How it works

**The layout mirrors the official Node distribution**, minus the top-level version directory:

```
<project>/node/
├── node.exe                    ← Windows; POSIX uses bin/node
├── node_modules/npm/           ← bundled npm / npx / corepack
├── node_modules/pnpm/          ← tools installed by `ezn.tools` (your global packages land here too)
└── lib/node_modules/           ← on POSIX, bundled and global packages both live here
```

(Packages live in `<rt>/node_modules/` on Windows and `<rt>/lib/node_modules/` on POSIX — a difference in
npm's global layout between the two platforms; the code checks both locations. The diagram groups them only
to make the point that bundled and managed packages share one directory.)

There is no version directory layer (not nvm's `versions/v22.13.5/`), because the version is uniquely
defined by config and a project needs only one runtime.

**Landing is always entry-by-entry and never deletes files unrelated to this install.** This is the project's
core design constraint, because the runtime directory doubles as the **install location for global packages**
(what `ezn npm i -g` puts there). Therefore:

- Same-named entries (`node.exe`, `README.md`, …) are backed up to `<name>.old-<timestamp>` before being overwritten;
- Shared directories (`node_modules/`) are **merged item by item**; items unique to the target stay put — which is how your global packages survive;
- The same holds when upgrading versions: nothing is silently wiped.

The two obvious alternatives are both wrong, and both were measured:

- **Whole-directory overwrite / wipe** → installed global packages get erased;
- **"if it already exists, skip the whole thing"** → when packages are installed first and the runtime lands
  after, the bundled npm never makes it in.

On landing failure the site is **left as-is, with no rollback** (a rollback could delete files that were
already overwritten); the locations of backed-up items are listed in the output.

**Cross-process serialization**: when several `ezn` processes land the same directory concurrently, a
directory lock (`mkdir` atomicity) serializes them. Processes that lose the race poll and wait; once the
holder finishes, they reuse it directly instead of re-downloading.

## Development

```bash
npm install
npm run build          # tsdown (rolldown) → dist/
npm test               # build + run all tests (100)
npm run typecheck
npm run update-assets  # fetch from nodejs.org to refresh src/versions.json (needs network)
```

`dist/` is gitignored and not committed, but **it is listed in `package.json`'s `files`** — so you **must**
run `npm run build` before publishing, or you will publish a package with missing or stale artifacts.
`npm run release` only does "bump version → `npm publish` → commit and tag"; **it no longer triggers a build
or the tests itself** (`prepack` / `prepublishOnly` were removed in 0.0.6).

`src/versions.json` is the **single source of truth** for the version table, generated by
`scripts/update-node-assets.mjs` — **do not edit it by hand**. To add a supported major version, change
`MAJOR_FROM` / `MAJOR_TO` at the top of that script and re-run it.

> **Read this before making platform-dependent changes**: this repo has no CI, and tests only truly execute
> on the current platform; non-host branches are skipped via `if (process.platform === "win32")`. When your
> change touches a platform branch, at minimum get it passing on this host, and state explicitly **which
> platforms you did not verify**. `test/flat-ensure.test.ts` simulates the POSIX merge path by overwriting
> `process.platform` plus `vi.resetModules()` — follow that pattern to add coverage.

## License

MIT
