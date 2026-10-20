/**
 * 调用 Android Gradle wrapper 构建 APK（本机没有 Android SDK 时会在配置阶段失败，属预期）。
 *
 * CI 直接 `cd apps/mobile/android && chmod +x gradlew && ./gradlew assembleDebug`；
 * 本脚本只是让本地（Windows）开发者用 `npm run android:debug` 得到同样的行为。
 */

import { chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const androidDir = join(dirname(here), "android");
const isWindows = process.platform === "win32";
const wrapper = join(androidDir, isWindows ? "gradlew.bat" : "gradlew");

if (!existsSync(wrapper)) {
  process.stderr.write(
    "[mobile] 未找到 android/ 工程。请先执行：npm install && npm run sync（必要时 npx cap add android）\n",
  );
  process.exit(1);
}

if (!isWindows) {
  chmodSync(wrapper, 0o755);
}

const args = process.argv.slice(2);
if (args.length === 0) args.push("assembleDebug");

const result = spawnSync(wrapper, args, {
  cwd: androidDir,
  stdio: "inherit",
  env: { ...process.env, ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "" },
  shell: isWindows,
});

process.exit(result.status ?? 1);
