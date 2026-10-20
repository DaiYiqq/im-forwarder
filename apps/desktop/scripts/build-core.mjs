/**
 * esbuild 构建脚本（apps/desktop）。
 *
 * 产物全部在 dist/ 下，并且**自带依赖**（yaml / zod / ws 一并打包）：
 *   · dist/core-runner.cjs        —— utilityProcess 核心入口（复用 ../../src 的核心代码）
 *   · dist/main.cjs               —— Electron 主进程
 *   · dist/preload.cjs            —— contextBridge 白名单桥（sandbox:true 下只 require('electron')）
 *   · dist/preflight.cjs          —— 主进程做配置保存/启动前校验用的独立 bundle
 *   · dist/companion-server.cjs   —— 伴生 HTTP API（可独立 node 运行，用于无界面自测）
 *   · dist/icon.png               —— 托盘/窗口图标（由 make-icon 生成后复制）
 *   · dist/companion-web/         —— 若 apps/companion-web/dist 已存在则复制进来，随包分发
 *
 * 依赖解析：核心源码位于仓库根 src/，其 import（yaml/zod/ws）从仓库根 node_modules 解析。
 * 这里显式把仓库根 node_modules 加入 nodePaths，避免在 apps/desktop 下重复声明运行期依赖
 * （任务书规定桌面端只允许 electron / electron-builder / esbuild / typescript / @types/node）。
 */

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const repoRoot = resolve(appDir, "../..");
const distDir = join(appDir, "dist");
const repoNodeModules = join(repoRoot, "node_modules");

function fail(message) {
  console.error(`\n[build-core] 构建失败：${message}\n`);
  process.exit(1);
}

if (!existsSync(join(repoNodeModules, "yaml"))) {
  fail(
    `找不到仓库根依赖 ${join(repoNodeModules, "yaml")}。` +
      "请先在仓库根执行 npm ci / npm install（核心代码复用根目录的 yaml、zod、ws）。",
  );
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const common = {
  absWorkingDir: appDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  logLevel: "warning",
  legalComments: "none",
  nodePaths: [repoNodeModules],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
};

/** utilityProcess 核心入口：全部依赖打包进来，产物是自包含 CJS。 */
await build({
  ...common,
  entryPoints: [join(appDir, "src/core-runner.ts")],
  outfile: join(distDir, "core-runner.cjs"),
});

/** Electron 主进程：electron 保持 external（由运行时提供）。 */
await build({
  ...common,
  entryPoints: [join(appDir, "src/main.ts")],
  outfile: join(distDir, "main.cjs"),
  external: ["electron", "electron/*"],
});

/** preload：sandbox:true 下只允许 require('electron')，因此除 electron 外全部内联。 */
await build({
  ...common,
  entryPoints: [join(appDir, "src/preload.ts")],
  outfile: join(distDir, "preload.cjs"),
  external: ["electron"],
});

/** 独立的前置检查 bundle：保存配置 / 启动前由主进程调用（不启动子进程）。 */
await build({
  ...common,
  entryPoints: [join(appDir, "src/preflight.ts")],
  outfile: join(distDir, "preflight.cjs"),
});

/** 伴生 HTTP 服务：可独立 node 运行，便于 CI/本地无界面 smoke。 */
await build({
  ...common,
  entryPoints: [join(appDir, "src/companion/server.ts")],
  outfile: join(distDir, "companion-server.cjs"),
});

/** 图标：build/icon.png 由 npm run icon 生成，复制到 dist 以便随包分发（托盘用）。 */
const iconSource = join(appDir, "build/icon.png");
if (!existsSync(iconSource)) {
  fail("缺少 build/icon.png。请先执行 npm run icon（或 npm run build）。");
}
cpSync(iconSource, join(distDir, "icon.png"));

/**
 * 移动伴生 PWA 静态资源。CI 会先构建 apps/companion-web 再构建桌面端，
 * 这里把它复制进 dist/（electron-builder 的 files 只含 dist/**，所以必须复制，
 * 否则安装后的应用无法提供 / 静态页面）。开发态未构建时跳过并给出提示，
 * 伴生服务会返回 503 + 明确提示，而不是崩溃。
 */
const webDist = join(repoRoot, "apps/companion-web/dist");
if (existsSync(join(webDist, "index.html"))) {
  cpSync(webDist, join(distDir, "companion-web"), { recursive: true });
  console.log("[build-core] 已复制 apps/companion-web/dist → dist/companion-web");
} else {
  console.warn(
    "[build-core] 警告：apps/companion-web/dist 不存在（未构建移动端）。" +
      "伴生服务将以 503 提示静态资源缺失；如需完整产物请先构建 apps/companion-web。",
  );
}

console.log("[build-core] 构建完成：dist/{core-runner,main,preload,preflight,companion-server}.cjs");
