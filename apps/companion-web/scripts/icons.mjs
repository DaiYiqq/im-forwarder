/**
 * 纯 Node 图标生成（无第三方图像库）：手写 PNG 编码 + 超采样矢量绘制。
 *
 * 任务书要求"生成图标 192/512 PNG（同桌面做法，纯 Node 手写 PNG）"。
 * 本模块被两个地方复用：
 *  - apps/companion-web/scripts/build.mjs → PWA 图标（192/512/maskable/apple-touch-icon）；
 *  - apps/mobile/scripts/gen-android-icons.mjs → Android mipmap 多尺寸图标。
 *
 * 只实现自己需要的最小 PNG 子集：8bit RGBA、filter=0、zlib deflate。
 * 不引入任何依赖，也不读取/解码外部图片。
 */

import { deflateSync } from "node:zlib";

// ───────────────────────────── PNG 编码 ─────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 把 RGBA 像素编码为 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba 长度必须为 width*height*4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`RGBA 长度不匹配：期望 ${width * height * 4}，实际 ${rgba.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前置 filter 字节 0（None）。
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ───────────────────────────── 矢量绘制 ─────────────────────────────

const COLORS = {
  bgTop: [11, 27, 43],
  bgBottom: [18, 48, 71],
  bubbleWechat: [125, 211, 252],
  bubbleQq: [52, 211, 153],
  arrow: [244, 250, 255],
};

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function mix(a, b, t) {
  const k = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

/** 圆角矩形内部判定（坐标已归一化到 0..1）。 */
function insideRoundRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  if (dx <= 0 || dy <= 0) {
    return Math.abs(x - cx) <= halfW && Math.abs(y - cy) <= halfH;
  }
  return dx * dx + dy * dy <= radius * radius;
}

/** 圆角正方形（图标外轮廓）内部判定。 */
function insideRoundedSquare(x, y, radius) {
  return insideRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, radius);
}

/** 圆形（Android round 图标）内部判定。 */
function insideCircle(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 三角形内部判定（用重心坐标符号一致性）。 */
function insideTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** 点到线段的距离（用于描边箭头）。 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq === 0 ? 0 : clamp01((apx * abx + apy * aby) / lengthSq);
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.hypot(dx, dy);
}

/**
 * 绘制图标为 RGBA 像素。
 *
 * 构图：深色渐变底 + 两个对话气泡（微信蓝 / QQ 绿）+ 中间白色"转发"双箭头。
 * @param {number} size 输出边长（正方形）
 * @param {{maskable?: boolean, scale?: number, transparent?: boolean, shape?: "rounded"|"square"|"circle"}} options
 *   maskable：满底不透明（供 Android adaptive / maskable PWA，内容缩到安全区）；
 *   transparent：不画背景（供 Android adaptive foreground，透明底 + 内容安全区）；
 *   shape：背景形状（rounded=圆角方形，square=直角满底，circle=圆形）；
 *   scale：内容整体缩放（默认按 maskable 自动选择）。
 */
export function renderIconRgba(size, options = {}) {
  const maskable = options.maskable === true;
  const transparent = options.transparent === true;
  const shape = options.shape ?? "rounded";
  const contentScale = options.scale ?? (transparent || maskable ? 0.62 : 0.78);
  const supersample = size <= 96 ? 4 : 2;
  const big = size * supersample;
  const cornerRadius = maskable ? 0.5 : 0.235;

  // 超采样画布，最后做盒式降采样得到抗锯齿边缘。
  const high = new Float32Array(big * big * 4);

  const map = (u) => 0.5 + (u - 0.5) * contentScale;

  const shapes = [
    { type: "bubble", color: COLORS.bubbleWechat, cx: 0.37, cy: 0.47, halfW: 0.185, halfH: 0.13, r: 0.065, tail: [0.30, 0.585, 0.25, 0.675, 0.385, 0.60] },
    { type: "bubble", color: COLORS.bubbleQq, cx: 0.63, cy: 0.55, halfW: 0.185, halfH: 0.13, r: 0.065, tail: [0.70, 0.665, 0.755, 0.755, 0.615, 0.68] },
  ];

  const chevronThickness = 0.028;
  const chevrons = [
    [
      [0.435, 0.385],
      [0.505, 0.475],
      [0.435, 0.565],
    ],
    [
      [0.535, 0.385],
      [0.605, 0.475],
      [0.535, 0.565],
    ],
  ];

  for (let py = 0; py < big; py += 1) {
    const v = (py + 0.5) / big;
    for (let px = 0; px < big; px += 1) {
      const u = (px + 0.5) / big;
      const offset = (py * big + px) * 4;

      // 1) 背景（含圆角/满底/圆形判定；foreground 模式不画背景）
      const insideBg = transparent
        ? false
        : maskable
          ? true
          : shape === "circle"
            ? insideCircle(u, v, 0.5, 0.5, 0.5)
            : shape === "square"
              ? true
              : insideRoundedSquare(u, v, cornerRadius);
      if (!insideBg && !transparent) continue;

      let color = [0, 0, 0];
      let alpha = 0;
      if (insideBg) {
        color = mix(COLORS.bgTop, COLORS.bgBottom, (v - 0.1) / 0.9);
        alpha = 1;
      }

      // 2) 气泡（内容坐标缩放居中）
      const cu = map(u);
      const cv = map(v);
      for (const shapeDef of shapes) {
        const inBody = insideRoundRect(cu, cv, shapeDef.cx, shapeDef.cy, shapeDef.halfW, shapeDef.halfH, shapeDef.r);
        const tail = shapeDef.tail;
        const inTail = insideTriangle(cu, cv, tail[0], tail[1], tail[2], tail[3], tail[4], tail[5]);
        if (inBody || inTail) {
          color = shapeDef.color;
          alpha = 1;
        }
      }

      // 3) 双箭头（白色描边，画在气泡之上）
      for (const points of chevrons) {
        const a = points[0];
        const b = points[1];
        const c = points[2];
        if (cu >= 0.38 && cu <= 0.66 && cv >= 0.32 && cv <= 0.63) {
          const d1 = distanceToSegment(cu, cv, a[0], a[1], b[0], b[1]);
          const d2 = distanceToSegment(cu, cv, b[0], b[1], c[0], c[1]);
          if (Math.min(d1, d2) <= chevronThickness) {
            color = COLORS.arrow;
            alpha = 1;
          }
        }
      }

      high[offset] = color[0];
      high[offset + 1] = color[1];
      high[offset + 2] = color[2];
      high[offset + 3] = alpha;
    }
  }

  // 盒式降采样（超采样因子固定为整数，边界整除）。
  const rgba = new Uint8Array(size * size * 4);
  const sampleCount = supersample * supersample;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const index = ((y * supersample + sy) * big + (x * supersample + sx)) * 4;
          r += high[index];
          g += high[index + 1];
          b += high[index + 2];
          a += high[index + 3];
        }
      }
      const target = (y * size + x) * 4;
      rgba[target] = Math.round(r / sampleCount);
      rgba[target + 1] = Math.round(g / sampleCount);
      rgba[target + 2] = Math.round(b / sampleCount);
      rgba[target + 3] = Math.round((a / sampleCount) * 255);
    }
  }

  return { width: size, height: size, rgba };
}

/** 生成 PNG Buffer。 */
export function renderIconPng(size, options = {}) {
  const { width, height, rgba } = renderIconRgba(size, options);
  return encodePng(width, height, rgba);
}
