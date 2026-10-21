/**
 * 用真实 Electron 渲染进程截取桌面端界面，产出 README/Demo 配图（PNG + GIF）。
 *
 * 用法（在 apps/desktop 下）：
 *   npx electron scripts/capture-main.cjs [输出目录]
 * 默认输出到 <repo>/demo/images。
 *
 * 无显示/无 GPU 环境用 **offscreen 渲染**：窗口不显示，通过 paint 事件拿到真实合成帧。
 * 数据来自 scripts/capture-preload.cjs 的假数据：不连接网关、不读取真实配置/令牌。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(ROOT, "..", "..", "demo", "images");
const PRELOAD = path.join(__dirname, "capture-preload.cjs");
const RENDERER = path.join(ROOT, "renderer", "index.html");

const WIDTH = 1280;
const HEIGHT = 832;
const FRAME_RATE = 15;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** NativeImage(BGRA) → RGBA，供 gifenc 使用。 */
function toRgba(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const rgba = Buffer.from(bitmap);
  if (process.platform !== "darwin") {
    for (let i = 0; i < rgba.length; i += 4) {
      const b = rgba[i];
      rgba[i] = rgba[i + 2];
      rgba[i + 2] = b;
    }
  }
  return { width: size.width, height: size.height, data: new Uint8Array(rgba) };
}

async function assertNoRendererError(win, stage) {
  const toast = await win.webContents.executeJavaScript(
    `(function(){var n=document.getElementById("toast");return n?String(n.textContent||""):"";})()`,
    true,
  );
  if (toast.trim().length > 0) {
    throw new Error(`渲染层报错（${stage}）：${toast}`);
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setFrameRate(FRAME_RATE);

  let latest = null;
  let paintCount = 0;
  win.webContents.on("paint", (_event, _dirty, image) => {
    latest = image;
    paintCount += 1;
  });

  await win.loadFile(RENDERER);

  // 等首帧 + UI 数据渲染完成
  const deadline = Date.now() + 15000;
  while ((!latest || paintCount < 3) && Date.now() < deadline) await wait(200);
  if (!latest) throw new Error("offscreen 渲染未产生任何帧（paint 事件未触发）");
  await wait(800);
  await assertNoRendererError(win, "初始化");

  const shots = [
    ["status", "desktop-status.png"],
    ["config", "desktop-config.png"],
    ["logs", "desktop-logs.png"],
    ["about", "desktop-about.png"],
  ];

  for (const [tab, file] of shots) {
    await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="${tab}"]').click();`, true);
    await wait(700);
    win.webContents.invalidate();
    await wait(300);
    const image = latest;
    const target = path.join(OUT_DIR, file);
    fs.writeFileSync(target, image.toPNG());
    const { width, height } = image.getSize();
    console.log(`[capture] ${file} ${width}x${height} ${(fs.statSync(target).size / 1024).toFixed(1)} KB`);
  }

  // 调试：输出日志表格表头与首行单元格坐标（确认列对齐）
  if (process.env.CAPTURE_DEBUG === "1") {
    await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="logs"]').click();`, true);
    await wait(600);
    const rects = await win.webContents.executeJavaScript(
      `(function(){
        var ths=[].map.call(document.querySelectorAll('#log-table thead th'),function(n){var r=n.getBoundingClientRect();return [n.textContent,Math.round(r.left),Math.round(r.width)];});
        var tds=[].map.call(document.querySelectorAll('#log-table tbody tr:first-child td'),function(n){var r=n.getBoundingClientRect();return [n.textContent,Math.round(r.left),Math.round(r.width)];});
        return {ths:ths,tds:tds};
      })()`,
      true,
    );
    console.log("[capture] header cells:", JSON.stringify(rects.ths));
    console.log("[capture] first row cells:", JSON.stringify(rects.tds));
  }

  // ── 动图：依次切换四个页签，生成 GIF（无需 ffmpeg） ──────────────────────
  try {
    const { GIFEncoder, quantize, applyPalette } = require("gifenc");
    const frames = [];
    for (const tab of ["status", "config", "logs", "about", "status"]) {
      await win.webContents.executeJavaScript(`document.querySelector('.tab[data-tab="${tab}"]').click();`, true);
      await wait(700);
      win.webContents.invalidate();
      await wait(300);
      frames.push(toRgba(latest.resize({ width: 960 })));
    }
    const gif = GIFEncoder();
    for (const frame of frames) {
      const palette = quantize(frame.data, 256, { format: "rgb444" });
      const index = applyPalette(frame.data, palette, "rgb444");
      gif.writeFrame(index, frame.width, frame.height, { palette, delay: 1400 });
    }
    gif.finish();
    const gifPath = path.join(OUT_DIR, "desktop-demo.gif");
    fs.writeFileSync(gifPath, gif.bytes());
    console.log(`[capture] desktop-demo.gif ${(fs.statSync(gifPath).size / 1024).toFixed(1)} KB`);
  } catch (error) {
    console.warn(`[capture] GIF skipped: ${error && error.message ? error.message : error}`);
  }

  win.destroy();
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  console.error(`[capture] failed: ${error && error.stack ? error.stack : error}`);
  app.exit(1);
});
