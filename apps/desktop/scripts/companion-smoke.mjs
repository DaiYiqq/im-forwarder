/**
 * 伴生 API 全链路自测（CI 可用，不需要 Electron / 不需要显示器）。
 *
 * 运行：node scripts/companion-smoke.mjs（需先 npm run build:core）
 *
 * 覆盖：
 *   1. 无 token → 401
 *   2. 错误配对码 → 401
 *   3. 正确配对码 → 200 {token, expiresAt}
 *   4. GET /api/health / status / routes / logs → 200 且不含会话 ID / receiver
 *   5. 错误方法 → 405；未知路径 → 404；CORS 预检白名单
 *   6. 请求体超 16KB → 413
 *   7. 请求体不反射（错误响应里不含请求体内容）
 *   8. 所有响应 Cache-Control: no-store
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const serverBundle = join(appDir, "dist", "companion-server.cjs");
const port = 17899;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

if (!existsSync(serverBundle)) {
  console.error(`[companion-smoke] 缺少 ${serverBundle}，请先执行 npm run build:core`);
  process.exit(1);
}

const child = spawn(process.execPath, [serverBundle, "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, IM_COMPANION_PORT: String(port) },
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

function waitForReady(timeoutMs = 8000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const line = stdout.split(/\r?\n/u).find((item) => item.startsWith("COMPANION_SMOKE_READY "));
      if (line) {
        clearInterval(timer);
        try {
          resolvePromise(JSON.parse(line.slice("COMPANION_SMOKE_READY ".length)));
        } catch (error) {
          rejectPromise(error);
        }
        return;
      }
      if (child.exitCode !== null) {
        clearInterval(timer);
        rejectPromise(new Error(`服务提前退出（code ${child.exitCode}）：${stderr.slice(0, 500)}`));
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        rejectPromise(new Error("等待服务就绪超时"));
      }
    }, 100);
  });
}

function cleanup() {
  if (child.exitCode === null) {
    child.kill();
  }
}

try {
  const ready = await waitForReady();
  console.log(`[companion-smoke] 服务已就绪：${base}，配对码 ${ready.pairCode}`);

  // 1) 无 token → 401
  let response = await fetch(`${base}/api/health`);
  check("无 token GET /api/health → 401", response.status === 401, `实际 ${response.status}`);
  check("401 响应含 Cache-Control: no-store", (response.headers.get("cache-control") ?? "").includes("no-store"));

  // 静态资源（无 companion-web 时 503，有则 200）
  response = await fetch(`${base}/`);
  check(
    "GET / → 200（静态存在）或 503（静态缺失且明确提示）",
    response.status === 200 || response.status === 503,
    `实际 ${response.status}`,
  );
  if (response.status === 503) {
    const body = await response.json();
    check("503 返回明确提示（static_unavailable）", body.error === "static_unavailable");
  }

  // 2) 错误配对码 → 401；错误响应不反射请求体
  const wrongCode = String((Number(ready.pairCode) + 123456) % 1000000).padStart(6, "0");
  response = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ code: wrongCode }),
  });
  const wrongBody = await response.text();
  check("错误配对码 POST /api/pair → 401", response.status === 401, `实际 ${response.status}`);
  check("错误响应不反射请求体", !wrongBody.includes(wrongCode));

  // 3) 正确配对码 → 200 token
  response = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: ready.pairCode }),
  });
  const pairBody = await response.json();
  check("正确配对码 → 200", response.status === 200);
  check("配对响应含 token 与 expiresAt", typeof pairBody.token === "string" && typeof pairBody.expiresAt === "number");
  check("配对码一次性（重复使用 → 401）", (await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: ready.pairCode }),
  })).status === 401);

  const token = pairBody.token;
  const auth = { authorization: `Bearer ${token}` };

  // 4) 各端点
  response = await fetch(`${base}/api/health`, { headers: auth });
  const health = await response.json();
  check("GET /api/health → 200", response.status === 200);
  check("health 契约字段", health.ok === true && health.app === "im-forwarder-desktop" && typeof health.version === "string");

  response = await fetch(`${base}/api/status`, { headers: auth });
  const status = await response.json();
  check("GET /api/status → 200", response.status === 200);
  check(
    "status 字段完整（running/startedAt/routeCount/gateway/crossBorderOpen/counts）",
    typeof status.running === "boolean" &&
      "startedAt" in status &&
      typeof status.routeCount === "number" &&
      typeof status.gateway?.baseUrlHost === "string" &&
      typeof status.crossBorderOpen === "boolean" &&
      typeof status.counts?.forwarded === "number",
  );
  check("status 不含会话 ID / 正文", !/conversationId|text|messageId|receiver/iu.test(JSON.stringify(status)));

  response = await fetch(`${base}/api/routes`, { headers: auth });
  const routes = await response.json();
  check("GET /api/routes → 200 数组", response.status === 200 && Array.isArray(routes));
  const routeDump = JSON.stringify(routes);
  check("routes 去掉 conversationId", !routeDump.includes("conversationId"));
  check("routes 去掉 receiver", !routeDump.includes("receiver"));
  check(
    "routes 字段契约",
    Array.isArray(routes) &&
      routes.length > 0 &&
      typeof routes[0].id === "string" &&
      typeof routes[0].from?.platform === "string" &&
      Array.isArray(routes[0].to),
  );

  response = await fetch(`${base}/api/logs?limit=10`, { headers: auth });
  const logs = await response.json();
  check("GET /api/logs → 200 数组", response.status === 200 && Array.isArray(logs));
  const allowed = new Set(["ts", "level", "event", "routeId", "sourcePlatform", "targetPlatform", "status", "errorCode", "latencyMs"]);
  const extra = new Set();
  for (const record of logs) {
    for (const key of Object.keys(record)) if (!allowed.has(key)) extra.add(key);
  }
  check("logs 只含白名单字段", extra.size === 0, [...extra].join(","));
  check("logs 不含正文/会话 ID", !/conversationId|"(text|content|message)"/iu.test(JSON.stringify(logs)));

  // 5) 方法/路径/CORS
  response = await fetch(`${base}/api/status`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
  check("POST /api/status → 405", response.status === 405);
  check("405 带 Allow: GET", (response.headers.get("allow") ?? "") === "GET");

  response = await fetch(`${base}/api/nope`, { headers: auth });
  check("未知 /api 路径 → 404", response.status === 404);

  response = await fetch(`${base}/api/status`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization, content-type",
    },
  });
  check("合法 CORS 预检 → 204", response.status === 204);
  check(
    "预检只允许 GET/POST + Authorization/Content-Type",
    (response.headers.get("access-control-allow-methods") ?? "").includes("GET") &&
      (response.headers.get("access-control-allow-headers") ?? "").toLowerCase().includes("authorization"),
  );

  response = await fetch(`${base}/api/status`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
  });
  check("非白名单 Origin 预检 → 403 且无 CORS 放行头", response.status === 403 && !response.headers.get("access-control-allow-origin"));

  // 6) 请求体上限 16KB
  const huge = JSON.stringify({ code: "000000", pad: "x".repeat(20 * 1024) });
  response = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: huge,
  });
  check(">16KB 请求体 → 413", response.status === 413, `实际 ${response.status}`);

  // 7) 控制端点（独立模式返回 running 翻转）
  response = await fetch(`${base}/api/control`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ action: "start" }),
  });
  const control = await response.json();
  check("POST /api/control start → 200 {running}", response.status === 200 && control.running === true);

  response = await fetch(`${base}/api/control`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ action: "delete" }),
  });
  check("非法 action → 400", response.status === 400);

  // 8) 所有响应 no-store（抽样）
  for (const path of ["/api/status", "/api/routes", "/api/logs"]) {
    response = await fetch(base + path, { headers: auth });
    check(`${path} 带 no-store`, (response.headers.get("cache-control") ?? "").includes("no-store"));
  }
} catch (error) {
  failures += 1;
  console.error(`[companion-smoke] 异常：${error instanceof Error ? error.message : String(error)}`);
} finally {
  cleanup();
}

if (failures > 0) {
  console.error(`[companion-smoke] FAIL（${failures} 项失败）`);
  process.exit(1);
}
console.log("[companion-smoke] PASS（401 → pair → status → logs 全链路通过）");
process.exit(0);
