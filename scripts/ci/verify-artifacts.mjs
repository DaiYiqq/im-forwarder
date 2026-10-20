/**
 * 发布产物校验与校验和生成（CI 用，无第三方依赖）。
 *
 * 用法：
 *   node scripts/ci/verify-artifacts.mjs --platform win|mac|linux
 *   node scripts/ci/verify-artifacts.mjs --platform android --src <apk> [--out dist/android] [--rename <name>]
 *   node scripts/ci/verify-artifacts.mjs --shasums <dir>
 *   node scripts/ci/verify-artifacts.mjs --assert-exit <code> -- <command...>
 *
 * 只做"存在性 / 大小阈值 / 命名 / 校验和 / 退出码"，不读取安装包内容，不接触任何密钥。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const DESKTOP_RELEASE_DIR = "apps/desktop/release";
const DEFAULT_ANDROID_OUT = "dist/android";

function fail(message) {
  process.stderr.write(`[verify-artifacts] FAIL: ${message}\n`);
  process.exit(1);
}

function info(message) {
  process.stdout.write(`[verify-artifacts] ${message}\n`);
}

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      args.positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args.positional.push(token);
    }
  }
  return args;
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function checkFile(file, minBytes, label) {
  if (!existsSync(file)) fail(`${label} 缺失：${file}`);
  const size = statSync(file).size;
  if (size < minBytes) fail(`${label} 过小（${size} bytes < ${minBytes}）：${file}`);
  info(`OK ${label}: ${basename(file)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return file;
}

function findOne(files, pattern, label) {
  const matched = files.filter((file) => pattern.test(basename(file)));
  if (matched.length === 0) {
    const listed = files.map((file) => basename(file)).join(", ") || "空";
    fail(`${label} 未找到（release 目录：${listed}）`);
  }
  return matched.sort()[0];
}

function verifyDesktop(platform) {
  if (!existsSync(DESKTOP_RELEASE_DIR)) {
    fail(`桌面端 release 目录不存在：${DESKTOP_RELEASE_DIR}（先执行 npm --prefix apps/desktop run dist:${platform}）`);
  }
  const files = listFiles(DESKTOP_RELEASE_DIR);
  info(`release 文件数：${files.length}`);

  if (platform === "win") {
    checkFile(findOne(files, /-win-.*\.exe$/i, "Windows NSIS 安装器"), 20 * 1024 * 1024, "Windows installer");
    const zip = files.find((file) => /-win-.*\.zip$/i.test(basename(file)));
    if (zip) checkFile(zip, 20 * 1024 * 1024, "Windows portable zip");
  } else if (platform === "mac") {
    checkFile(findOne(files, /\.dmg$/i, "macOS dmg"), 40 * 1024 * 1024, "macOS dmg");
    checkFile(findOne(files, /-mac-.*\.zip$/i, "macOS zip"), 40 * 1024 * 1024, "macOS zip");
  } else if (platform === "linux") {
    checkFile(findOne(files, /\.AppImage$/i, "Linux AppImage"), 30 * 1024 * 1024, "Linux AppImage");
    checkFile(findOne(files, /\.deb$/i, "Linux deb"), 20 * 1024 * 1024, "Linux deb");
  } else {
    fail(`未知平台：${platform}`);
  }
}

function verifyAndroid(args) {
  const source = args.src;
  if (typeof source !== "string" || !existsSync(source)) fail(`Android APK 不存在：${String(source)}`);
  checkFile(source, 1 * 1024 * 1024, "Android APK");
  const outDir = typeof args.out === "string" ? args.out : DEFAULT_ANDROID_OUT;
  mkdirSync(outDir, { recursive: true });
  const name = typeof args.rename === "string" ? args.rename : basename(source);
  const target = join(outDir, name);
  copyFileSync(source, target);
  info(`APK 已输出：${target}`);
}

function shasums(dir) {
  if (!existsSync(dir)) fail(`校验和目录不存在：${dir}`);
  const files = listFiles(dir).filter((file) => !basename(file).startsWith("SHA256SUMS"));
  if (files.length === 0) fail(`目录为空，无法生成校验和：${dir}`);
  const lines = files
    .map((file) => ({
      name: basename(file),
      hash: createHash("sha256").update(readFileSync(file)).digest("hex"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.hash}  ${entry.name}`);
  const target = join(dir, "SHA256SUMS.txt");
  writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
  info(`已生成 ${target}（${lines.length} 个文件）`);
  process.stdout.write(`${readFileSync(target, "utf8")}\n`);
}

function assertExit(args) {
  const expected = String(args["assert-exit"]);
  const command = args.positional;
  if (command.length === 0) fail("--assert-exit 需要命令（放在 -- 之后）");
  const [program, ...rest] = command;
  const result = spawnSync(program, rest, { stdio: "inherit", env: process.env });
  const code = result.status === null ? "null" : String(result.status);
  info(`命令退出码=${code}，期望=${expected}`);
  if (code !== expected) fail(`退出码不符：${code} != ${expected}`);
  info("退出码符合预期");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.shasums) return shasums(typeof args.shasums === "string" ? args.shasums : "dist");
  if (args["assert-exit"] !== undefined) return assertExit(args);
  const platform = args.platform;
  if (platform === "android") return verifyAndroid(args);
  if (typeof platform === "string") return verifyDesktop(platform);
  fail("用法：--platform win|mac|linux|android | --shasums <dir> | --assert-exit <code> -- <cmd>");
}

main();
