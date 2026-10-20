/**
 * 生成 build/icon.png（512×512 RGBA PNG）。
 *
 * 约束：不引入任何图像库。PNG 由手写 chunk + 内置 zlib deflate 输出，
 * CRC32 与扫描线滤波器均在此文件内实现，可在任意 Node 24 环境复现。
 *
 * 图案：深蓝圆角底 + 青色「双向转发」箭头。属于本项目原创图形，无第三方素材。
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolveAppDir(scriptDir);
const outputPath = join(appDir, "build", "icon.png");

const SIZE = 512;
const SS = 2; // 2× 超采样，再降采样得到平滑边缘
const N = SIZE * SS;

function resolveAppDir(dir) {
  return join(dir, "..");
}

// ── 颜色与几何（坐标按 512 设计稿，绘制时 × SS）────────────────────────────
const BG_TOP = [10, 22, 38];
const BG_BOTTOM = [17, 63, 94];
const RING = [148, 197, 255, 34];
const TEAL = [79, 209, 197, 255];
const BLUE = [147, 197, 253, 255];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 圆角矩形内部判定。 */
function inRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 点到线段距离判定（线宽 t）。 */
function inSegment(x, y, x1, y1, x2, y2, t) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  let u = lengthSq === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / lengthSq;
  u = Math.max(0, Math.min(1, u));
  const px = x1 + u * dx;
  const py = y1 + u * dy;
  return (x - px) ** 2 + (y - py) ** 2 <= (t / 2) ** 2;
}

/** 叉积用于三角形判定。 */
function cross(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function inTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const d1 = cross(ax, ay, bx, by, x, y);
  const d2 = cross(bx, by, cx, cy, x, y);
  const d3 = cross(cx, cy, ax, ay, x, y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** 用给定颜色覆盖像素（预乘按 alpha 混合）。 */
function blend(pixels, index, color) {
  const alpha = color[3] / 255;
  pixels[index] = Math.round(color[0] * alpha + pixels[index] * (1 - alpha));
  pixels[index + 1] = Math.round(color[1] * alpha + pixels[index + 1] * (1 - alpha));
  pixels[index + 2] = Math.round(color[2] * alpha + pixels[index + 2] * (1 - alpha));
  pixels[index + 3] = Math.min(255, Math.round(255 * alpha + pixels[index + 3] * (1 - alpha)));
}

/** 形状遮罩 + 颜色填充：shape(x,y) 返回 boolean。 */
function paint(pixels, color, shape) {
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const designX = x / SS;
      const designY = y / SS;
      if (!shape(designX, designY)) continue;
      blend(pixels, (y * N + x) * 4, color);
    }
  }
}

const pixels = new Uint8ClampedArray(N * N * 4);

// 1) 圆角底板 + 垂直渐变
for (let y = 0; y < N; y += 1) {
  for (let x = 0; x < N; x += 1) {
    const designX = x / SS;
    const designY = y / SS;
    if (!inRoundedRect(designX, designY, SIZE, SIZE, 104)) continue;
    const t = designY / SIZE;
    const index = (y * N + x) * 4;
    pixels[index] = Math.round(lerp(BG_TOP[0], BG_BOTTOM[0], t));
    pixels[index + 1] = Math.round(lerp(BG_TOP[1], BG_BOTTOM[1], t));
    pixels[index + 2] = Math.round(lerp(BG_TOP[2], BG_BOTTOM[2], t));
    pixels[index + 3] = 255;
  }
}

// 2) 装饰性圆环（低透明度）
paint(pixels, RING, (x, y) => inCircle(x, y, 256, 256, 172) && !inCircle(x, y, 256, 256, 156));

// 3) 上方箭头：向右（青）
paint(pixels, TEAL, (x, y) => inSegment(x, y, 158, 214, 330, 214, 26));
paint(pixels, TEAL, (x, y) => inTriangle(x, y, 388, 214, 318, 168, 318, 260));

// 4) 下方箭头：向左（浅蓝）
paint(pixels, BLUE, (x, y) => inSegment(x, y, 182, 298, 354, 298, 26));
paint(pixels, BLUE, (x, y) => inTriangle(x, y, 124, 298, 194, 252, 194, 344));

// 5) 2× 降采样（盒式滤波）
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let dy = 0; dy < SS; dy += 1) {
      for (let dx = 0; dx < SS; dx += 1) {
        const index = ((y * SS + dy) * N + (x * SS + dx)) * 4;
        r += pixels[index];
        g += pixels[index + 1];
        b += pixels[index + 2];
        a += pixels[index + 3];
      }
    }
    const count = SS * SS;
    const outIndex = (y * SIZE + x) * 4;
    out[outIndex] = Math.round(r / count);
    out[outIndex + 1] = Math.round(g / count);
    out[outIndex + 2] = Math.round(b / count);
    out[outIndex + 3] = Math.round(a / count);
  }
}

// ── PNG 编码（手写 chunk + CRC32）─────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

// 每行前置 1 字节滤波类型（0 = None）
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  out.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, png);

const digest = createHash("sha256").update(png).digest("hex");
const valid =
  png[0] === 0x89 &&
  png.subarray(1, 4).toString("ascii") === "PNG" &&
  png.readUInt32BE(16) === SIZE &&
  png.readUInt32BE(20) === SIZE;
if (!valid) {
  console.error("[make-icon] PNG 头校验失败");
  process.exit(1);
}
console.log(
  `[make-icon] build/icon.png 已生成：${SIZE}x${SIZE}，${png.length} bytes，sha256=${digest.slice(0, 16)}…`,
);
