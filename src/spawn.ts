/**
 * @file 子进程执行原语：命令行的 shell 引用、输出收集式 spawn、继承式 spawn。
 * @fileoverview
 * 为什么单独成模块：Windows 的 shell 模式引用规则（见 {@link quoteShellArg}）与 `.cmd` 必须经 shell
 * 这条安全策略（见 {@link shellSafe}）是**两处消费者共用**的同一套语义——`Node` 类的 exec/npm/npx
 * 封装与 `ezn` 命令（`./cli.ts`）都要用。各写一份必然漂移，故集中在此。
 *
 * 本模块不从包导出（公共 API 面只有 `Node`）。
 */

import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

/** 异步 spawn 结果（stdio 为 pipe 时收集 utf8 stdout/stderr，否则对应字段为 null）。 */
export interface SpawnAsyncResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | null;
  stderr: string | null;
}

/**
 * 为 Windows shell 模式引用单个参数。
 *
 * Node 在 `shell: true` 下只做朴素字符串拼接，不会为含空格的参数加引号（会把 `run "my script"`
 * 拆坏），故自行引用；无特殊字符时保持原样以免引入多余的引号层。
 *
 * @param arg - 待引用的参数
 * @returns 可安全拼进命令行的字符串
 */
export function quoteShellArg(arg: string): string {
  return arg !== "" && !/[\s"^&|<>()%!]/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * 组装 spawn 的 `(command, args)`。
 *
 * shell 模式下自行拼成整行、args 传空（原因见 {@link quoteShellArg}）；非 shell 模式原样透传。
 *
 * @param file - 可执行文件路径
 * @param argv - 参数数组
 * @param shell - 是否经 shell 执行
 * @returns `[command, args]` 元组，可直接传给 spawn/spawnSync
 */
export function shellSafe(file: string, argv: readonly string[], shell: boolean): [string, string[]] {
  return shell ? [[file, ...argv].map(quoteShellArg).join(" "), []] : [file, [...argv]];
}

/**
 * 异步 spawn，stdio 为 pipe（默认）时以 utf8 收集输出。
 *
 * @param cmd - 可执行文件
 * @param args - 参数数组
 * @param options - spawn 选项（`windowsHide` 默认开启）
 * @returns 收集完输出后的结果；stdio 非 pipe 时 `stdout`/`stderr` 为 null
 */
export function spawnAsync(cmd: string, args: readonly string[], options: SpawnOptions = {}): Promise<SpawnAsyncResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...options });
    let stdout: string | null = null;
    let stderr: string | null = null;
    if (child.stdout) {
      stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout = (stdout ?? "") + chunk));
    }
    if (child.stderr) {
      stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr ?? "") + chunk));
    }
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

/**
 * 同步/继承式执行：stdio 交给子进程直连当前终端，返回退出码。
 *
 * 与 {@link spawnAsync} 的区别是**不收集输出**：`n` 命令执行的是用户给的任意命令（vitest / tsc /
 * vite …），必须原样透传 TTY、颜色、进度条与退出码，捕获输出会破坏这些。
 *
 * @param cmd - 可执行文件
 * @param args - 参数数组
 * @param options - spawn 选项（`windowsHide` 默认关闭以保住 TTY 语义）
 * @returns 子进程退出码（被信号终止时为 1）
 */
export function spawnInherit(cmd: string, args: readonly string[], options: SpawnOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", windowsHide: false, ...options });
    child.on("error", reject);
    child.on("close", (status) => resolve(status ?? 1));
  });
}
