/**
 * 测试入口：先用 esbuild 把 test/*.spec.ts 各自打包成独立 ESM，
 * 再交给 Node 内建 test runner。
 *
 * 为什么不直接 `node --test test/*.spec.ts`：
 *  本包依赖白名单只允许 esbuild + typescript，没有 tsx；
 *  而 CI 的 Node 版本（20）不支持原生 type stripping。
 *  用 esbuild 预编译一次即可在 Node 20 / 22 / 24 上行为一致（Windows/Linux 均可）。
 *
 * 打包时 platform=node，Node 内建模块（node:test / node:assert 等）自动保持 external。
 */

import { build } from "esbuild";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(here);
const testDir = join(appRoot, "test");
const outDir = join(appRoot, ".test-dist");

const specs = readdirSync(testDir)
  .filter((name) => name.endsWith(".spec.ts"))
  .sort();

if (specs.length === 0) {
  process.stderr.write("[companion-web] 未找到 test/*.spec.ts\n");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const outFiles = [];
for (const spec of specs) {
  const outFile = join(outDir, spec.replace(/\.ts$/u, ".mjs"));
  await build({
    entryPoints: [join(testDir, spec)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node20"],
    outfile: outFile,
    logLevel: "silent",
    sourcemap: false,
  });
  outFiles.push(outFile);
}

const result = spawnSync(process.execPath, ["--test", ...outFiles], { stdio: "inherit" });

rmSync(outDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
