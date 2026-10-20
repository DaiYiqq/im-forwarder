import { execFileSync, spawnSync } from "node:child_process";

const OWNER = "DaiYiqq";
const REPO = "im-forwarder";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const PARENT = process.argv[2];
if (!PARENT) throw new Error("usage: node push.mjs <parent-sha>");

const git = (args) => execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024 });
const token = (() => {
  const out = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
  });
  const line = (out.stdout || "").split(/\r?\n/).find((l) => l.startsWith("password="));
  if (!line) throw new Error("no github credential");
  return line.slice("password=".length);
})();

const headers = {
  authorization: `token ${token}`,
  "user-agent": "dsh-agent",
  accept: "application/vnd.github+json",
  "content-type": "application/json; charset=utf-8",
};

async function apiOnce(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

async function api(method, path, body) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await apiOnce(method, path, body);
    } catch (error) {
      const status = error.status ?? 0;
      if (!(error instanceof TypeError || status === 0 || status === 429 || status >= 500) || attempt === 8) {
        throw error;
      }
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** (attempt - 1))));
    }
  }
}

const localHead = git(["rev-parse", "HEAD"]).toString().trim();
const localTree = git(["rev-parse", "HEAD^{tree}"]).toString().trim();
const parentTree = git(["rev-parse", `${PARENT}^{tree}`]).toString().trim();
const changes = git(["diff", "--name-status", PARENT, "HEAD"])
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [status, file] = line.split("\t");
    return { status, file };
  });

const entries = [];
for (const item of changes) {
  if (item.status.startsWith("D")) {
    entries.push({ path: item.file, mode: "100644", type: "blob", sha: null });
    continue;
  }
  const blobSha = git(["rev-parse", `HEAD:${item.file}`]).toString().trim();
  const content = git(["cat-file", "blob", blobSha]);
  const uploaded = await api("POST", "/git/blobs", { content: content.toString("base64"), encoding: "base64" });
  const mode = git(["ls-tree", "HEAD", "--", item.file]).toString().split(/\s+/)[0] || "100644";
  entries.push({ path: item.file, mode, type: "blob", sha: uploaded.sha });
}

const tree = await api("POST", "/git/trees", { base_tree: parentTree, tree: entries });
if (tree.sha !== localTree) throw new Error(`tree mismatch: ${tree.sha} != ${localTree}`);

const meta = git(["log", "-1", "--format=%an|%ae|%at|%ai|%cn|%ce|%ct|%ci"]).toString().trim().split("|");
const [an, ae, at, ai, cn, ce, ct, ci] = meta;
const iso = (epoch, dateText) => {
  const offset = dateText.split(" ").pop();
  const local = new Date(Number(epoch) * 1000 + Number(offset.slice(1, 3)) * 3600e3 + Number(offset.slice(3, 5)) * 60e3);
  const p = (n) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}${offset[0] === "-" ? "-" : "+"}${offset.slice(1, 3)}:${offset.slice(3, 5)}`;
};
const message = git(["log", "-1", "--pretty=%B"]).toString().replace(/\n+$/, "\n");

const commit = await api("POST", "/git/commits", {
  message,
  tree: tree.sha,
  parents: [PARENT],
  author: { name: an, email: ae, date: iso(at, ai) },
  committer: { name: cn, email: ce, date: iso(ct, ci) },
});
if (commit.sha !== localHead) throw new Error(`commit mismatch: ${commit.sha} != ${localHead}`);
const ref = await api("PATCH", "/git/refs/heads/main", { sha: commit.sha, force: false });
console.log(`pushed main=${ref.object.sha} (files: ${changes.length})`);
