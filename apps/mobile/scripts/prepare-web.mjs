/**
 * 同步前准备：确保共享 Web 应用已有构建产物。
 *
 * CI 流程（release.yml 的 android job）会先下载 companion-web 的 dist 产物；
 * 本地开发时若 dist 不存在，这里会自动到 ../companion-web 执行 `npm run build`。
 * 两者都不成立时给出可操作的中文提示，而不是让 `cap sync` 报出难懂的 "webDir does not exist"。
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = dirname(here);
const webRoot = join(mobileRoot, "..", "companion-web");
const distIndex = join(webRoot, "dist", "index.html");
const webPackageJson = join(webRoot, "package.json");

function fail(message) {
  process.stderr.write(`[mobile] ${message}\n`);
  process.exit(1);
}

if (!existsSync(webPackageJson)) {
  fail(`找不到共享 Web 应用目录：${relative(mobileRoot, webRoot)}（期望存在 package.json）`);
}

if (!existsSync(distIndex)) {
  if (!existsSync(join(webRoot, "node_modules"))) {
    fail(
      "companion-web 尚未构建且依赖未安装。请先执行：\n" +
        "  npm ci --prefix apps/companion-web\n" +
        "  npm --prefix apps/companion-web run build\n" +
        "然后重新执行 npm run sync。",
    );
  }
  process.stdout.write("[mobile] companion-web/dist 不存在，先构建共享 Web 应用…\n");
  const result = spawnSync("npm", ["run", "build", "--prefix", webRoot], {
    stdio: "inherit",
    cwd: mobileRoot,
    shell: process.platform === "win32",
  });
  if (result.status !== 0 || !existsSync(distIndex)) {
    fail("共享 Web 应用构建失败，已中止 cap sync。");
  }
}

process.stdout.write("[mobile] companion-web/dist 就绪，开始 cap sync…\n");
