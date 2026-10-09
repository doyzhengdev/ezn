/** @file ezn 测试配置（vitest 5，独立于发布构建配置）。
 * @fileoverview
 *
 * 为什么单独一份 vitest.config.mts 而不复用 vite.config.mts：
 *   1. vite.config.mts 是**发布构建**配置（ssr 构建、三目标、dts 插件），与测试运行时无关；
 *      vitest 以 serve 模式加载它会被其中的拦截直接拒绝（那份配置只服务 `vite build`，
 *      见其文件头的「无 web 入口」说明）；
 *   2. vitest 的配置解析顺序是 vitest.config.* 优先于 vite.config.*——存在本文件即可完全
 *      隔离那套构建配置，两边的改动互不牵连。
 *
 * 用例面向 src/ 源码（不经 dist 产物）；产物形态的冒烟断言在 test/node.test.ts 里直接读
 * dist/，由 `npm test` 先构建（scripts/build.mts）保证产物新鲜。
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
