#!/usr/bin/env node
/**
 * im-forwarder 合规静态扫描（`npm run compliance:scan`）。
 *
 * 四道检查：
 *  1. 禁用词：src/**\/*.ts、scripts/**\/*.ts、apps/**\/*.ts 中不得出现任何"平台登录/协议逆向/userbot"相关标识；
 *  2. 日志通道：src/ 下不得出现 console.log(（必须走 Logger 或 process.stdout.write）；
 *  3. 依赖白名单：根 package.json 的 dependencies / devDependencies 必须恰好等于允许集合；
 *  4. 应用依赖：apps 下各应用的 package.json 不得出现登录/userbot/逆向类依赖（桌面端/移动端新增面）。
 *
 * 匹配规则（重要，避免被误解为逃避检查）：
 *  - **注释不参与匹配**。扫描前先剥离块注释与行注释，
 *    因为源码里存在"本仓库不存在 MTProto/Telethon/Pyrogram 代码路径"这类合规声明注释，
 *    它们正是合规文档的一部分，不应当把检查自己的说明文字当成违规。
 *  - **deny-list / blocklist 常量定义豁免**。`FORBIDDEN_KEY_RULES`、
 *    `PLATFORM_DIRECT_HOST_BLOCKLIST` 这类常量的用途就是"列出被禁止的东西"，
 *    因此其中出现的禁用词属于防护定义本身。豁免位置会在报告中逐条打印，
 *    既不是静默放过，也不会把防护代码误判为违规。
 *  - 除此之外，字符串字面量（例如 URL、配置键名）**参与匹配**——
 *    直连 ilinkai、写死 bot_token 这类风险恰恰最常出现在字符串里。
 *
 * 退出码：0 = 全部通过；1 = 发现至少一个问题。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF_PATH = fileURLToPath(import.meta.url);
const SCAN_ROOTS = ["src", "scripts", "apps"];
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "test",
  "dist",
  ".git",
  // 应用目录里的非源码目录（构建产物/原生工程/依赖缓存）
  "release",
  "build",
  "out",
  "android",
  "ios",
  ".gradle",
  "coverage",
]);

/** 应用依赖中的禁用包（精确匹配包名，大小写不敏感）。 */
const FORBIDDEN_APP_DEPENDENCY_PATTERN =
  /^(telethon|pyrogram|mtproto|tdlib|userbot|wechaty|itchat|padlocal|wechatferry|wcferry)([-_.].*)?$/i;

/** 禁用词规则（大小写不敏感）。 */
const FORBIDDEN_PATTERNS = [
  {
    label: "个人号/userbot 类 Telegram 客户端（禁止）",
    regex: /telethon|pyrogram|mtproto|tdlib|api_hash|session_string|userbot/gi,
  },
  {
    label: "微信直连/登录凭据（禁止：只能由网关官方 iLink 通道完成）",
    regex: /ilinkai|ilink_bot|bot_token|qrcode|itchat|wechaty|padlocal|wechatferry|wcferry|com\.tencent\.mm/gi,
  },
];

/** 依赖白名单：精确集合，多一个少一个都要报错。 */
const EXPECTED_DEPENDENCIES = ["ws", "yaml", "zod"];
const EXPECTED_DEV_DEPENDENCIES = ["@types/node", "@types/ws", "tsx", "typescript"];
const DEPENDENCY_BLOCKLIST_KEYS = [
  "peerDependencies",
  "optionalDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

/** console.log( 检查（只针对 src/，且注释已剥离）。 */
const CONSOLE_LOG_PATTERN = /console\s*\.\s*log\s*\(/;

const toPosix = (path) => path.split(sep).join("/");

function snippetOf(line) {
  const trimmed = line.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

/** 递归收集 .ts 文件（跳过 node_modules/test/dist，跳过脚本自身）。 */
function collectTypeScriptFiles(rootDir, output) {
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) {
      continue;
    }
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(fullPath, output);
      continue;
    }
    if (!entry.isFile() || extname(entry.name) !== ".ts") {
      continue;
    }
    if (fullPath === SELF_PATH) {
      continue;
    }
    output.push(fullPath);
  }
}

function isCommentStart(line, index) {
  // 只把"行首或空白之后"的 // 、/* 当作注释开头。
  // 这样 `http://127.0.0.1` 这类字符串里的 // 不会被误删（宁可保守）。
  if (index === 0) {
    return true;
  }
  const previous = line[index - 1];
  return previous === " " || previous === "\t";
}

function findCommentStart(line, marker, fromIndex) {
  let index = line.indexOf(marker, fromIndex);
  while (index !== -1) {
    if (isCommentStart(line, index)) {
      return index;
    }
    index = line.indexOf(marker, index + 1);
  }
  return -1;
}

/**
 * 剥离注释，保持行号不变（每行仍对应原文件的一行）。
 * 字符串里的 // 因为前面不是空白而不会被当作注释。
 */
function stripComments(source) {
  const lines = source.split(/\r?\n/);
  const stripped = [];
  let inBlockComment = false;

  for (const line of lines) {
    let visible = "";
    let cursor = 0;
    while (cursor < line.length) {
      if (inBlockComment) {
        const endIndex = line.indexOf("*/", cursor);
        if (endIndex === -1) {
          cursor = line.length;
          break;
        }
        cursor = endIndex + 2;
        inBlockComment = false;
        continue;
      }

      const lineCommentAt = findCommentStart(line, "//", cursor);
      const blockCommentAt = findCommentStart(line, "/*", cursor);
      let startAt = -1;
      let startsBlock = false;
      if (lineCommentAt !== -1 && (blockCommentAt === -1 || lineCommentAt < blockCommentAt)) {
        startAt = lineCommentAt;
      } else if (blockCommentAt !== -1) {
        startAt = blockCommentAt;
        startsBlock = true;
      }

      if (startAt === -1) {
        visible += line.slice(cursor);
        cursor = line.length;
        break;
      }

      visible += line.slice(cursor, startAt);
      if (startsBlock) {
        inBlockComment = true;
        cursor = startAt + 2;
      } else {
        cursor = line.length;
      }
    }
    stripped.push(visible);
  }

  return stripped;
}

/** deny-list / blocklist 常量定义的行区间（其中的禁用词属于防护定义，豁免）。 */
const GUARD_DECLARATION_PATTERN =
  /^\s*(?:export\s+)?const\s+[A-Za-z0-9_$]*(?:FORBIDDEN|BLOCKLIST|BLACKLIST|DENYLIST|DENY_)[A-Za-z0-9_$]*\s*[:=]/;

function findGuardRanges(strippedLines) {
  const ranges = [];
  for (let index = 0; index < strippedLines.length; index += 1) {
    if (!GUARD_DECLARATION_PATTERN.test(strippedLines[index] ?? "")) {
      continue;
    }
    let end = strippedLines.length - 1;
    for (let cursor = index; cursor < strippedLines.length; cursor += 1) {
      if (/^\s*\]\s*;?\s*$/.test(strippedLines[cursor] ?? "")) {
        end = cursor;
        break;
      }
    }
    ranges.push([index, end]);
    index = end;
  }
  return ranges;
}

function inRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index <= end);
}

/**
 * 网关令牌环境变量名 `EASYBOT_TOKEN` 的豁免判定。
 *
 * 禁用词规则里有 `bot_token`（指微信侧登录凭据），但本项目自己的网关令牌变量名
 * `EASYBOT_TOKEN` 会命中该规则。两者含义完全不同：前者是平台登录凭据（禁止），
 * 后者只是"EasyBot 网关"的 token 变量名（文档与配置示例统一使用）。
 * 因此仅当命中项正好是 BOT_TOKEN 且紧邻前缀为 EASY 时才豁免，并在报告中打印。
 */
function isGatewayTokenEnvName(line, index, term) {
  if (!/^bot_token$/i.test(term)) return false;
  const prefix = line.slice(Math.max(0, index - 4), index);
  return /easy$/i.test(prefix);
}

function scanSources(scanFiles, findings, exemptions) {
  for (const absolutePath of scanFiles) {
    const relativePath = toPosix(relative(ROOT, absolutePath));
    let source;
    try {
      source = readFileSync(absolutePath, "utf8");
    } catch (error) {
      findings.push({
        kind: "read",
        file: relativePath,
        line: 0,
        message: `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const strippedLines = stripComments(source);
    const guardRanges = findGuardRanges(strippedLines);

    strippedLines.forEach((line, index) => {
      const lineNumber = index + 1;
      for (const rule of FORBIDDEN_PATTERNS) {
        for (const match of line.matchAll(rule.regex)) {
          const entry = {
            kind: "forbidden-term",
            file: relativePath,
            line: lineNumber,
            term: match[0],
            label: rule.label,
            snippet: snippetOf(line),
          };
          if (inRanges(index, guardRanges)) {
            exemptions.push({ ...entry, reason: "deny-list/blocklist 防护定义" });
          } else if (isGatewayTokenEnvName(line, match.index, match[0])) {
            exemptions.push({ ...entry, reason: "网关令牌环境变量名 EASYBOT_TOKEN（非微信 bot_token 凭据）" });
          } else {
            findings.push(entry);
          }
        }
      }

      if (relativePath.startsWith("src/") && CONSOLE_LOG_PATTERN.test(line)) {
        findings.push({
          kind: "console-log",
          file: relativePath,
          line: lineNumber,
          label: "src/ 下禁止 console.log(；日志必须走 Logger 或 process.stdout.write",
          snippet: snippetOf(line),
        });
      }
    });
  }
}

function compareDependencySet(blockName, expected, actual, findings) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));

  if (missing.length > 0) {
    findings.push({
      kind: "dependency",
      file: "package.json",
      line: 0,
      message: `${blockName} 缺少允许的依赖：${missing.join(", ")}（白名单：${expected.join(", ")}）`,
    });
  }
  if (extra.length > 0) {
    findings.push({
      kind: "dependency",
      file: "package.json",
      line: 0,
      message:
        `${blockName} 出现白名单之外的依赖：${extra.join(", ")}。` +
        `依赖必须恰好等于 {${expected.join(", ")}}；新增依赖会扩大供应链与合规风险面。`,
    });
  }
}

function scanPackageJson(findings) {
  const packagePath = join(ROOT, "package.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    findings.push({
      kind: "dependency",
      file: "package.json",
      line: 0,
      message: `无法读取/解析 package.json：${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  compareDependencySet(
    "dependencies",
    EXPECTED_DEPENDENCIES,
    Object.keys(parsed.dependencies ?? {}),
    findings,
  );
  compareDependencySet(
    "devDependencies",
    EXPECTED_DEV_DEPENDENCIES,
    Object.keys(parsed.devDependencies ?? {}),
    findings,
  );

  for (const key of DEPENDENCY_BLOCKLIST_KEYS) {
    const value = parsed[key];
    if (value === undefined) {
      continue;
    }
    const names = Array.isArray(value) ? value : Object.keys(value);
    if (names.length > 0) {
      findings.push({
        kind: "dependency",
        file: "package.json",
        line: 0,
        message: `${key} 必须为空：本项目只允许固定白名单依赖（实际：${names.join(", ")}）`,
      });
    }
  }
}

function scanAppDependencies(findings) {
  const root = join(ROOT, "apps");
  let appDirs;
  try {
    appDirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return;
  }
  for (const entry of appDirs) {
    const packagePath = join(root, entry.name, "package.json");
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(packagePath, "utf8"));
    } catch {
      continue;
    }
    const names = [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ];
    for (const name of names) {
      if (FORBIDDEN_APP_DEPENDENCY_PATTERN.test(name)) {
        findings.push({
          kind: "dependency",
          file: `apps/${entry.name}/package.json`,
          line: 0,
          message: `应用依赖出现禁用包：${name}（禁止平台登录/协议逆向/userbot 类依赖）`,
        });
      }
    }
  }
}

function printSection(title) {
  process.stdout.write(`${title}\n`);
}

function printFindings(findings) {
  for (const finding of findings) {
    if (finding.kind === "forbidden-term") {
      process.stdout.write(
        `  ✗ ${finding.file}:${finding.line}  命中禁用词「${finding.term}」（${finding.label}）\n` +
          `      代码：${finding.snippet}\n`,
      );
    } else if (finding.kind === "console-log") {
      process.stdout.write(
        `  ✗ ${finding.file}:${finding.line}  出现 console.log(\n` +
          `      代码：${finding.snippet}\n` +
          `      要求：${finding.label}\n`,
      );
    } else {
      process.stdout.write(`  ✗ ${finding.file}${finding.line ? `:${finding.line}` : ""}  ${finding.message}\n`);
    }
  }
}

function main() {
  process.stdout.write("════════════════════════════════════════════════════════════════\n");
  process.stdout.write(" im-forwarder 合规静态扫描（compliance:scan）\n");
  process.stdout.write("════════════════════════════════════════════════════════════════\n");
  process.stdout.write(
    `扫描根目录：${SCAN_ROOTS.map((name) => `${name}/**/*.ts`).join("、")}\n`,
  );
  process.stdout.write("规则说明：先剥离块注释与行注释再匹配，注释不参与匹配；\n");
  process.stdout.write(
    "          但 deny-list/blocklist 常量定义中的禁用词属于防护定义，逐条豁免并打印（见下方）。\n\n",
  );

  const scanFiles = [];
  for (const rootName of SCAN_ROOTS) {
    collectTypeScriptFiles(join(ROOT, rootName), scanFiles);
  }

  const findings = [];
  const exemptions = [];

  printSection(`[1/4] 禁用词扫描（${scanFiles.length} 个文件）`);
  scanSources(scanFiles, findings, exemptions);
  const forbiddenFindings = findings.filter((finding) => finding.kind === "forbidden-term");
  if (forbiddenFindings.length === 0) {
    process.stdout.write("  ✓ 未发现 telethon / pyrogram / mtproto / ilinkai / bot_token / qrcode 等禁用词\n");
  } else {
    printFindings(forbiddenFindings);
  }
  if (exemptions.length > 0) {
    process.stdout.write(
      `  · 豁免 ${exemptions.length} 处（位于 deny-list/blocklist 常量定义内，属于合规防护本身）：\n`,
    );
    for (const exemption of exemptions) {
      process.stdout.write(
        `      ${exemption.file}:${exemption.line}  「${exemption.term}」 ← ${exemption.reason}\n`,
      );
    }
  }

  printSection("[2/4] 日志通道检查（src/ 下不得出现 console.log(）");
  const consoleFindings = findings.filter((finding) => finding.kind === "console-log");
  if (consoleFindings.length === 0) {
    process.stdout.write("  ✓ src/ 下没有 console.log(（未绕过 Logger 白名单）\n");
  } else {
    printFindings(consoleFindings);
  }

  printSection("[3/4] 依赖白名单检查（精确集合）");
  scanPackageJson(findings);
  const dependencyFindings = findings.filter((finding) => finding.kind === "dependency");
  if (dependencyFindings.length === 0) {
    process.stdout.write(
      `  ✓ dependencies 恰好为 {${EXPECTED_DEPENDENCIES.join(", ")}}\n` +
        `  ✓ devDependencies 恰好为 {${EXPECTED_DEV_DEPENDENCIES.join(", ")}}\n`,
    );
  } else {
    printFindings(dependencyFindings);
  }

  printSection("[4/4] 应用依赖检查（apps/*/package.json）");
  const beforeAppScan = findings.length;
  scanAppDependencies(findings);
  if (findings.length === beforeAppScan) {
    process.stdout.write("  ✓ apps/ 下没有平台登录 / userbot / 协议逆向类依赖\n");
  } else {
    process.stdout.write("  ✗ apps/ 下发现禁用依赖（见下方）\n");
  }

  const otherFindings = findings.filter(
    (finding) => !["forbidden-term", "console-log", "dependency"].includes(finding.kind),
  );
  if (otherFindings.length > 0) {
    printSection("[额外问题]");
    printFindings(otherFindings);
  }

  process.stdout.write("\n────────────────────────────────────────────────────────────────\n");
  if (findings.length === 0) {
    process.stdout.write(
      `结果：通过（0 个问题；豁免 ${exemptions.length} 处防护定义）\n` +
        "说明：本扫描是静态文本层防线，不能替代人工评审；它只证明「仓库里没有被禁的标识与依赖」。\n",
    );
    return 0;
  }

  process.stdout.write(`结果：失败（${findings.length} 个问题）——请按上面的文件/行号修正后重试\n`);
  return 1;
}

process.exit(main());
