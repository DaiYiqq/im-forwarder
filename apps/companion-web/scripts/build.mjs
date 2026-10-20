/**
 * companion-web 构建：esbuild 打包 app.ts → dist/app.js，
 * 拷贝静态外壳并生成 PWA 图标（纯 Node 手写 PNG，无第三方图像库）。
 *
 * 产物 dist/ 同时用于：
 *  - 桌面端静态托管（"添加到主屏幕"的 PWA）；
 *  - Capacitor 的 webDir（apps/mobile/capacitor.config.ts 指向 ../companion-web/dist）。
 */

import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderIconPng } from "./icons.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(here);
const srcDir = join(appRoot, "src");
const distDir = join(appRoot, "dist");

const STATIC_FILES = ["index.html", "style.css", "manifest.webmanifest", "sw.js"];

const ICONS = [
  { relative: "icons/icon-192.png", size: 192, options: {} },
  { relative: "icons/icon-512.png", size: 512, options: {} },
  { relative: "icons/maskable-512.png", size: 512, options: { maskable: true } },
  { relative: "icons/apple-touch-icon.png", size: 180, options: { scale: 0.74 } },
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngHeaderLooksValid(path) {
  const head = readFileSync(path).subarray(0, 8);
  return head.equals(PNG_SIGNATURE);
}

async function main() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(join(distDir, "icons"), { recursive: true });

  await build({
    entryPoints: [join(srcDir, "app.ts")],
    bundle: true,
    format: "iife",
    target: ["es2020"],
    platform: "browser",
    outfile: join(distDir, "app.js"),
    legalComments: "none",
    // 不生成 sourcemap：产物不含任何来源路径/注释，便于静态托管审计。
    sourcemap: false,
    logLevel: "info",
  });

  for (const file of STATIC_FILES) {
    copyFileSync(join(srcDir, file), join(distDir, file));
  }

  let iconBytes = 0;
  for (const icon of ICONS) {
    const png = renderIconPng(icon.size, icon.options);
    const target = join(distDir, icon.relative);
    writeFileSync(target, png);
    if (!pngHeaderLooksValid(target)) {
      throw new Error(`图标生成失败：${icon.relative} 不是合法 PNG`);
    }
    iconBytes += png.length;
  }

  const appJs = readFileSync(join(distDir, "app.js")).length;
  process.stdout.write(
    `[companion-web] dist 构建完成：app.js=${appJs}B，图标 ${ICONS.length} 个共 ${iconBytes}B\n`,
  );
}

await main();
