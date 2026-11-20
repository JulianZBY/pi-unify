import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIntercept } from "../src/fs-intercept.ts";
import type { Adapter } from "../src/adapters.ts";

interface Sandbox {
  ad: string;
  cwd: string;
  adapter: Adapter;
  oldConfig: string;
  globalConfig: string;
  projectConfig: string;
}

function sandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-config-"));
  const ad = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(ad, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    ad,
    cwd,
    adapter: { name: "pi-demo", config: { path: join(ad, "demo.json"), projectOverride: "demo.json" }, data: [] },
    oldConfig: join(ad, "demo.json"),
    globalConfig: join(ad, "extensions/settings/pi-demo.json"),
    projectConfig: join(cwd, ".pi/unify/demo.json"),
  };
}

function install(sb: Sandbox, projectTrusted: boolean, onWarn?: (m: string) => void) {
  return installIntercept({ agentDir: sb.ad, adapters: [sb.adapter], cwd: sb.cwd, projectTrusted, onWarn });
}

function put(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

test("read merges project override over global, project wins per key", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { model: "global-model", verbose: true });
  put(sb.projectConfig, { model: "project-model" });
  const intercept = install(sb, true);
  t.after(() => intercept.uninstall());

  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { model: "project-model", verbose: true });
});

test("read ignores the project override when the project is not trusted", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { model: "global-model" });
  put(sb.projectConfig, { model: "project-model" });
  const intercept = install(sb, false);
  t.after(() => intercept.uninstall());

  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { model: "global-model" });
});

test("read falls through to the old path when no layer exists", (t) => {
  const sb = sandbox(t);
  put(sb.oldConfig, { legacy: true });
  const intercept = install(sb, true);
  t.after(() => intercept.uninstall());

  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { legacy: true });
});

test("read returns only the project layer when no global file exists", (t) => {
  const sb = sandbox(t);
  put(sb.projectConfig, { fromProject: 1 });
  const intercept = install(sb, true);
  t.after(() => intercept.uninstall());

  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { fromProject: 1 });
});

test("async read merges layers the same way", async (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { a: 1, b: 2 });
  put(sb.projectConfig, { b: 3 });
  const intercept = install(sb, true);
  t.after(() => intercept.uninstall());

  assert.deepEqual(JSON.parse(await fs.promises.readFile(sb.oldConfig, "utf8")), { a: 1, b: 3 });
});

test("write lands in the global layer and never touches the project override", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { model: "global-model" });
  put(sb.projectConfig, { model: "project-model" });
  const intercept = install(sb, true);
  t.after(() => intercept.uninstall());

  fs.writeFileSync(sb.oldConfig, JSON.stringify({ model: "rewritten" }));
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), { model: "rewritten" });
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.projectConfig, "utf8")), { model: "project-model" });
});

test("async write lands in the global layer", async (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { a: 1 });
  put(sb.projectConfig, { a: 2 });
  const intercept = install(sb, true);
  t.after(() => intercept.uninstall());

  await fs.promises.writeFile(sb.oldConfig, JSON.stringify({ a: 3 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), { a: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.projectConfig, "utf8")), { a: 2 });
});

test("Buffer writes keep the bytes the caller passed", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { a: 1 });
  const intercept = install(sb, true);
  t.after(() => intercept.uninstall());

  const bytes = Buffer.from('{"a":9}', "utf8");
  fs.writeFileSync(sb.oldConfig, bytes);
  assert.deepEqual(fs.readFileSync(fs.existsSync(sb.globalConfig) ? sb.globalConfig : sb.oldConfig), bytes);
});

test("write of an unknown key is rejected with a warning", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { known: true });
  const warnings: string[] = [];
  const intercept = install(sb, true, (m) => warnings.push(m));
  t.after(() => intercept.uninstall());

  fs.writeFileSync(sb.oldConfig, JSON.stringify({ known: true, surprise: 1 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), { known: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /surprise/);
});

test("write with a mismatched value type is rejected with a warning", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { count: 1, list: [1], flag: true, nested: { a: 1 } });
  const warnings: string[] = [];
  const intercept = install(sb, true, (m) => warnings.push(m));
  t.after(() => intercept.uninstall());

  fs.writeFileSync(sb.oldConfig, JSON.stringify({ count: "1" }));
  fs.writeFileSync(sb.oldConfig, JSON.stringify({ list: {} }));
  fs.writeFileSync(sb.oldConfig, JSON.stringify({ flag: null }));
  fs.writeFileSync(sb.oldConfig, JSON.stringify({ nested: [] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), { count: 1, list: [1], flag: true, nested: { a: 1 } });
  assert.equal(warnings.length, 4);
});

test("matching value types are accepted", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { count: 1, list: [1], flag: true, nested: { a: 1 }, maybe: null });
  const warnings: string[] = [];
  const intercept = install(sb, true, (m) => warnings.push(m));
  t.after(() => intercept.uninstall());

  const next = { count: 2, list: ["x"], flag: false, nested: { b: 2 }, maybe: null };
  fs.writeFileSync(sb.oldConfig, JSON.stringify(next));
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), next);
  assert.deepEqual(warnings, []);
});

test("first write to a missing global file is allowed", (t) => {
  const sb = sandbox(t);
  put(sb.oldConfig, { legacy: 1 });
  const warnings: string[] = [];
  const intercept = install(sb, true, (m) => warnings.push(m));
  t.after(() => intercept.uninstall());

  fs.writeFileSync(sb.oldConfig, JSON.stringify({ legacy: 1, fresh: "ok" }));
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), { legacy: 1, fresh: "ok" });
  assert.deepEqual(warnings.filter((w) => w.includes("reject")), []);
});

test("a key present only in the project layer counts as existing", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { a: 1 });
  put(sb.projectConfig, { fromProject: "x" });
  const warnings: string[] = [];
  const intercept = install(sb, true, (m) => warnings.push(m));
  t.after(() => intercept.uninstall());

  fs.writeFileSync(sb.oldConfig, JSON.stringify({ a: 2, fromProject: "y" }));
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), { a: 2, fromProject: "y" });
  assert.deepEqual(warnings, []);
});

test("non-JSON write is rejected with a warning", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { a: 1 });
  const warnings: string[] = [];
  const intercept = install(sb, true, (m) => warnings.push(m));
  t.after(() => intercept.uninstall());

  fs.writeFileSync(sb.oldConfig, "not json at all");
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), { a: 1 });
  assert.equal(warnings.length, 1);
});

test("rejected async write resolves without writing and warns once", async (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { a: 1 });
  const warnings: string[] = [];
  const intercept = install(sb, true, (m) => warnings.push(m));
  t.after(() => intercept.uninstall());

  await fs.promises.writeFile(sb.oldConfig, JSON.stringify({ a: "wrong" }));
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), { a: 1 });
  assert.equal(warnings.length, 1);
});

test("trust granted after install takes effect without re-patching", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { model: "global-model" });
  put(sb.projectConfig, { model: "project-model" });
  const options = { agentDir: sb.ad, adapters: [sb.adapter], cwd: sb.cwd, projectTrusted: false };
  const intercept = installIntercept(options);
  t.after(() => intercept.uninstall());

  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { model: "global-model" });
  options.projectTrusted = true;
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { model: "project-model" });
});

// Regression: the write replaced the whole global file, so a write that only
// touched some keys silently dropped every other key the file had.
test("a write that omits existing keys keeps them", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { a: 1, b: 2 });
  const warnings: string[] = [];
  const intercept = install(sb, false, (m) => warnings.push(m));
  t.after(() => intercept.uninstall());

  fs.writeFileSync(sb.oldConfig, JSON.stringify({ a: 3 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), { a: 3, b: 2 });
  assert.deepEqual(warnings, []);
});

// An explicit empty object must not wipe a populated config; skip and warn.
test("an empty-object write does not wipe a populated global config", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { a: 1, b: 2 });
  const warnings: string[] = [];
  const intercept = install(sb, false, (m) => warnings.push(m));
  t.after(() => intercept.uninstall());

  fs.writeFileSync(sb.oldConfig, "{}");
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.globalConfig, "utf8")), { a: 1, b: 2 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /empty/i);
});

// Regression: pi-unify refreshes trust/cwd from its own session_start handler, which
// is not guaranteed to run before another extension reads config. A project override
// that exists but is not applied must surface, not vanish silently.
test("an existing project override that is not applied yet is reported", async (t) => {
  const sb = sandbox(t);
  put(sb.projectConfig, { fromProject: true });
  put(sb.globalConfig, { fromGlobal: true });

  const { installIntercept } = await import("../src/fs-intercept.ts");
  const warnings: string[] = [];
  const opts = { agentDir: sb.ad, adapters: [sb.adapter], cwd: sb.cwd, projectTrusted: false, onWarn: (m: string) => warnings.push(m) };
  const intercept = installIntercept(opts);
  t.after(() => intercept.uninstall());

  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { fromGlobal: true });
  assert.equal(warnings.filter((w) => w.includes("not applied")).length, 1, warnings.join("; "));

  opts.projectTrusted = true;
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { fromGlobal: true, fromProject: true });
  assert.equal(warnings.filter((w) => w.includes("not applied")).length, 1, "warns once per adapter");
});
