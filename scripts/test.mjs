/**
 * 测试入口：跨平台地收集 test/*.spec.ts 并交给 Node 内置 test runner。
 *
 * 为什么不用 `node --test test/*.spec.ts`：Windows 上 npm 脚本经由 cmd.exe 执行，
 * 通配符不会被展开。这里用 Node 自己列目录，行为在 Windows / Linux / macOS 一致。
 */

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testDir = join(root, "test");

const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".spec.ts"))
  .sort()
  .map((name) => join(testDir, name));

if (files.length === 0) {
  console.error("未找到任何 test/*.spec.ts");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-reporter=spec", ...files],
  { stdio: "inherit", cwd: root, env: process.env },
);

process.exit(result.status ?? 1);
