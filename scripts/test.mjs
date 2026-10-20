/**
 * 测试入口：跨平台地收集测试文件并交给 Node 内置 test runner。
 *
 * 覆盖：
 *   · 核心：test/*.spec.ts
 *   · 移动端 Web/实验核心：apps/companion-web/test/*.spec.ts（纯逻辑，不依赖 DOM）
 *
 * 为什么不用 `node --test test/*.spec.ts`：Windows 上 npm 脚本经由 cmd.exe 执行，
 * 通配符不会被展开。这里用 Node 自己列目录，行为在 Windows / Linux / macOS 一致。
 */

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const TEST_DIRS = ["test", join("apps", "companion-web", "test")];

const files = [];
for (const relative of TEST_DIRS) {
  const dir = join(root, relative);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(".spec.ts")) files.push(join(dir, name));
  }
}

if (files.length === 0) {
  console.error("未找到任何 *.spec.ts（test/ 或 apps/companion-web/test/）");
  process.exit(1);
}

process.stdout.write(`[test] 运行 ${files.length} 个测试文件\n`);

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-reporter=spec", ...files],
  { stdio: "inherit", cwd: root, env: process.env },
);

process.exit(result.status ?? 1);
