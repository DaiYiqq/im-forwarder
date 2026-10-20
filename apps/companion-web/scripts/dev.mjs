/**
 * 本地开发服务器：esbuild watch 重建 dist，并用 Node 内建 http 静态托管 dist。
 *
 * 用途：桌面端尚未接入静态托管时，先在电脑浏览器/手机浏览器里验证 PWA。
 * 注意：Service Worker 只在 https 或 localhost 下有效；局域网 http 访问时不会注册（属预期）。
 */

import { context } from "esbuild";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(here);
const distDir = join(appRoot, "dist");
const srcDir = join(appRoot, "src");
const port = Number.parseInt(process.env["DEV_PORT"] ?? "5173", 10);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

// 先完整构建一次（含静态文件与图标），之后只 watch app.ts。
execFileSync(process.execPath, [join(here, "build.mjs")], { stdio: "inherit" });

const ctx = await context({
  entryPoints: [join(srcDir, "app.ts")],
  bundle: true,
  format: "iife",
  target: ["es2020"],
  platform: "browser",
  outfile: join(distDir, "app.js"),
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
});
await ctx.watch();

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/index.html";

  // 目录穿越防护：normalize 后必须仍在 dist 内。
  const relativePath = normalize(pathname).replace(/^(\.\.[/\\])+/u, "").replace(/^[/\\]+/u, "");
  const filePath = join(distDir, relativePath);
  if (!filePath.startsWith(`${distDir}${sep}`) && filePath !== distDir) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`[companion-web] dev server: http://127.0.0.1:${port}/\n`);
});
