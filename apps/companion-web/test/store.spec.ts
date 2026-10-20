import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CompanionStore,
  HOST_STORAGE_KEY,
  normalizeHost,
  type StorageLike,
} from "../src/store.ts";

interface WriteRecord {
  key: string;
  value: string;
}

/** 记录全部写操作的假 storage：用来断言"令牌从未被写进存储"。 */
class RecordingStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  readonly writes: WriteRecord[] = [];

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes.push({ key, value });
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.writes.push({ key, value: "<removed>" });
    this.map.delete(key);
  }

  dump(): WriteRecord[] {
    return [...this.writes];
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

const TOKEN = "super-secret-token-value";

test("normalizeHost：补全协议、去查询串与片段、拒绝非法地址", () => {
  assert.deepEqual(normalizeHost("192.168.1.8:3210"), { host: "http://192.168.1.8:3210" });
  assert.deepEqual(normalizeHost("http://192.168.1.8:3210/"), { host: "http://192.168.1.8:3210" });
  assert.deepEqual(normalizeHost("https://example.com/api/?token=abc#x"), { host: "https://example.com/api" });
  assert.deepEqual(normalizeHost("http://user:pass@host:1"), { error: "地址中不能包含用户名或密码" });
  assert.deepEqual(normalizeHost("ftp://host"), { error: "只允许 http:// 或 https:// 地址" });
  assert.deepEqual(normalizeHost(""), { error: "请填写桌面端伴生服务地址，例如 http://192.168.1.8:3210" });
});

test("host 可持久化，token 绝不写入 storage", () => {
  const storage = new RecordingStorage();
  const store = new CompanionStore({ storage });

  assert.equal(store.setHost("192.168.1.8:3210") instanceof Object, true);
  store.setToken(TOKEN, "2030-01-01T00:00:00.000Z");

  assert.equal(store.token, TOKEN);
  assert.equal(store.paired, true);

  const writes = storage.dump();
  assert.ok(writes.length > 0);
  assert.deepEqual(
    writes.map((record) => record.key),
    [HOST_STORAGE_KEY],
  );
  // 令牌出现在任何一次写入里都算违规。
  for (const record of writes) {
    assert.equal(record.value.includes(TOKEN), false);
  }
  assert.equal(JSON.stringify(storage.dump()).includes(TOKEN), false);

  store.clearToken();
  assert.equal(store.token, null);
  assert.equal(JSON.stringify(storage.dump()).includes(TOKEN), false);
});

test("刷新/重启（新 store 实例）后 host 还在、token 不在了", () => {
  const storage = new RecordingStorage();
  const first = new CompanionStore({ storage });
  first.setHost("http://192.168.1.8:3210");
  first.setToken(TOKEN, null);

  const second = new CompanionStore({ storage });
  assert.equal(second.host, "http://192.168.1.8:3210");
  assert.equal(second.token, null);
  assert.equal(second.paired, false);
});

test("storage 被禁用（隐私模式）时仍然可工作，只是不持久化", () => {
  const store = new CompanionStore({ storage: null });
  store.setHost("http://192.168.1.8:3210");
  store.setToken(TOKEN, null);
  assert.equal(store.host, "http://192.168.1.8:3210");
  assert.equal(store.token, TOKEN);

  const another = new CompanionStore({ storage: null });
  assert.equal(another.host, "");
  assert.equal(another.token, null);
});

test("setToken 拒绝空令牌；clearAll 可选择清掉 host", () => {
  const storage = new RecordingStorage();
  const store = new CompanionStore({ storage });
  store.setHost("http://192.168.1.8:3210");
  store.setToken(TOKEN, null);
  assert.throws(() => store.setToken("   ", null), /令牌不能为空/u);

  store.clearAll({ keepHost: false });
  assert.equal(store.host, "");
  assert.equal(store.token, null);
  assert.equal(storage.getItem(HOST_STORAGE_KEY), null);
});

test("被手工改坏的持久化 host 会被重新校验并丢弃", () => {
  const storage = new RecordingStorage();
  storage.setItem(HOST_STORAGE_KEY, "ftp://evil.example");
  const store = new CompanionStore({ storage });
  assert.equal(store.host, "");
});
