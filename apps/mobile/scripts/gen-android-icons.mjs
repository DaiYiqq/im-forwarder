/**
 * 生成 Android mipmap 多尺寸图标（以及 iOS AppIcon@1024），全部为纯 Node 手写 PNG。
 *
 * 复用 companion-web 的 `scripts/icons.mjs`（同一份品牌图形）：
 *  - legacy `ic_launcher.png` / `ic_launcher_round.png`：48/72/96/144/192；
 *  - adaptive foreground `ic_launcher_foreground.png`：108/162/216/324/432（透明底 + 安全区内容）；
 *  - `values/ic_launcher_background.xml`：与图形一致的深色底；
 *  - iOS `AppIcon-512@2x.png`：1024×1024 满底不透明（避免带 alpha 的图标被 App Store 校验拒绝）。
 *
 * 不引入任何图像库；不联网。生成后 `npx cap sync` 不会覆盖本脚本写入的 res 文件
 * （Capacitor 只覆盖 web assets 与 capacitor 配置）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderIconPng } from "../../companion-web/scripts/icons.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = dirname(here);
const resDir = join(mobileRoot, "android", "app", "src", "main", "res");

/** 各密度对应的 legacy 图标边长与 adaptive foreground 边长（108dp 基准）。 */
const DENSITIES = [
  { dir: "mipmap-mdpi", legacy: 48, foreground: 108 },
  { dir: "mipmap-hdpi", legacy: 72, foreground: 162 },
  { dir: "mipmap-xhdpi", legacy: 96, foreground: 216 },
  { dir: "mipmap-xxhdpi", legacy: 144, foreground: 324 },
  { dir: "mipmap-xxxhdpi", legacy: 192, foreground: 432 },
];

function writePng(path, size, options) {
  const png = renderIconPng(size, options);
  writeFileSync(path, png);
  return png.length;
}

let totalBytes = 0;

for (const density of DENSITIES) {
  const dir = join(resDir, density.dir);
  mkdirSync(dir, { recursive: true });

  totalBytes += writePng(join(dir, "ic_launcher.png"), density.legacy, { scale: 0.78 });
  totalBytes += writePng(join(dir, "ic_launcher_round.png"), density.legacy, { shape: "circle", scale: 0.78 });
  totalBytes += writePng(join(dir, "ic_launcher_foreground.png"), density.foreground, {
    transparent: true,
    scale: 0.6,
  });
}

// adaptive icon 背景色（mipmap-anydpi-v26 的 XML 引用 @color/ic_launcher_background）。
writeFileSync(
  join(resDir, "values", "ic_launcher_background.xml"),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B1B2B</color>\n</resources>\n',
);

// iOS AppIcon（1024×1024，满底不透明）。
const iosIcon = join(mobileRoot, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png");
mkdirSync(dirname(iosIcon), { recursive: true });
totalBytes += writePng(iosIcon, 1024, { shape: "square", scale: 0.72 });

process.stdout.write(
  `[mobile] 图标已生成：${DENSITIES.length} 个密度 × 3 种 + iOS AppIcon，共 ${totalBytes} 字节\n`,
);
