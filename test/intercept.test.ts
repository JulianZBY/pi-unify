import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIntercept } from "../src/fs-intercept.ts";
import type { Adapter } from "../src/adapters.ts";
import { readNamed, readNamedAsync, statNamedAsync } from "./helpers/named-fs.ts";

interface Sandbox {
  ad: string;
  cwd: string;
  adapter: Adapter;
  oldConfig: string;
  newConfig: string;
}

function sandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-intercept-"));
  const ad = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(ad, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    ad,
    cwd,
    adapter: { name: "pi-demo", config: { path: join(ad, "demo.json") }, data: [] },
    oldConfig: join(ad, "demo.json"),
    newConfig: join(ad, "extensions/settings/pi-demo.json"),
  };
}

function install(sb: Sandbox, onWarn?: (m: string) => void) {
  return installIntercept({
    agentDir: sb.ad,
    adapters: [sb.adapter],
    cwd: sb.cwd,
    projectTrusted: false,
    onWarn,
  });
}

test("non-whitelisted reads pass through unchanged", (t) => {
  const sb = sandbox(t);
  const plain = join(sb.cwd, "plain.json");
  writeFileSync(plain, JSON.stringify({ a: 1 }));
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.equal(fs.readFileSync(plain, "utf8"), JSON.stringify({ a: 1 }));
  assert.deepEqual(fs.readFileSync(plain), Buffer.from(JSON.stringify({ a: 1 })));
  assert.deepEqual(fs.readFileSync(plain, { encoding: "utf8" }), JSON.stringify({ a: 1 }));
  assert.equal(fs.existsSync(plain), true);
  assert.equal(fs.statSync(plain).size, JSON.stringify({ a: 1 }).length);
});

test("non-whitelisted write passes through unchanged", (t) => {
  const sb = sandbox(t);
  const out = join(sb.cwd, "out.txt");
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  fs.writeFileSync(out, "hello");
  assert.equal(fs.readFileSync(out, "utf8"), "hello");
  fs.writeFileSync(out, Buffer.from("bytes"));
  assert.deepEqual(fs.readFileSync(out), Buffer.from("bytes"));
});

test("non-whitelisted ENOENT behaves like the original", (t) => {
  const sb = sandbox(t);
  const intercept = install(sb);
  t.after(() => intercept.uninstall());
  const missing = join(sb.cwd, "nope.json");

  assert.equal(fs.existsSync(missing), false);
  assert.throws(
    () => fs.readFileSync(missing, "utf8"),
    (err: NodeJS.ErrnoException) => err.code === "ENOENT" && err.message === `ENOENT: no such file or directory, open '${missing}'`,
  );
  let statCode: string | undefined;
  try {
    fs.statSync(missing);
  } catch (err) {
    statCode = (err as NodeJS.ErrnoException).code;
  }
  assert.equal(statCode, "ENOENT");
});

test("whitelisted config read returns the unified settings file", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, JSON.stringify({ old: true }));
  mkdirSync(join(sb.ad, "extensions/settings"), { recursive: true });
  writeFileSync(sb.newConfig, JSON.stringify({ unified: true }));
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.equal(fs.readFileSync(sb.oldConfig, "utf8"), JSON.stringify({ unified: true }));
  assert.equal(fs.existsSync(sb.oldConfig), true);
  assert.equal(fs.statSync(sb.oldConfig).size, JSON.stringify({ unified: true }).length);
});

test("whitelisted read falls through to the old file when unified does not exist", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, JSON.stringify({ old: true }));
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.equal(fs.readFileSync(sb.oldConfig, "utf8"), JSON.stringify({ old: true }));
  rmSync(sb.oldConfig);
  assert.equal(fs.existsSync(sb.oldConfig), false);
  assert.throws(() => fs.readFileSync(sb.oldConfig, "utf8"), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
});

test("async whitelisted read is routed the same way", async (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, "old");
  mkdirSync(join(sb.ad, "extensions/settings"), { recursive: true });
  writeFileSync(sb.newConfig, "unified");
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.equal(await fs.promises.readFile(sb.oldConfig, "utf8"), "unified");
  assert.equal((await fs.promises.stat(sb.oldConfig)).size, "unified".length);
});

test("whitelisted config write lands in the unified settings file", (t) => {
  const sb = sandbox(t);
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  fs.writeFileSync(sb.oldConfig, JSON.stringify({ written: 1 }));
  assert.equal(fs.readFileSync(sb.newConfig, "utf8"), JSON.stringify({ written: 1 }));
});

test("patching twice keeps the passthrough chain intact", (t) => {
  const sb = sandbox(t);
  const plain = join(sb.cwd, "plain.json");
  writeFileSync(plain, "chain");
  mkdirSync(join(sb.ad, "extensions/settings"), { recursive: true });
  writeFileSync(sb.newConfig, "unified");

  const first = install(sb);
  const second = install(sb);
  t.after(() => {
    second.uninstall();
    first.uninstall();
  });

  assert.equal(fs.readFileSync(plain, "utf8"), "chain");
  assert.equal(fs.readFileSync(sb.oldConfig, "utf8"), "unified");
  second.uninstall();
  assert.equal(fs.readFileSync(plain, "utf8"), "chain");
  assert.equal(fs.readFileSync(sb.oldConfig, "utf8"), "unified");
});

test("uninstall restores the original fs functions", (t) => {
  const sb = sandbox(t);
  const before = fs.readFileSync;
  writeFileSync(sb.oldConfig, "old");
  mkdirSync(join(sb.ad, "extensions/settings"), { recursive: true });
  writeFileSync(sb.newConfig, "unified");
  const intercept = install(sb);
  assert.notEqual(fs.readFileSync, before);
  intercept.uninstall();
  assert.equal(fs.readFileSync, before);
  assert.equal(fs.readFileSync(sb.oldConfig, "utf8"), "old");
  intercept.uninstall();
});

test("health reports patched functions and problems", (t) => {
  const sb = sandbox(t);
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  const h = intercept.health();
  assert.ok(h.patched.includes("readFileSync"), `patched: ${h.patched.join(",")}`);
  assert.ok(h.patched.includes("writeFileSync"));
  assert.ok(h.problems.some((p) => p.includes("settings dir")), h.problems.join("; "));

  mkdirSync(join(sb.ad, "extensions/settings"), { recursive: true });
  assert.deepEqual(intercept.health().problems, []);
});

test("adapters without config add no whitelist entries", (t) => {
  const sb = sandbox(t);
  const plain = join(sb.cwd, "x.json");
  writeFileSync(plain, "untouched");
  const intercept = installIntercept({
    agentDir: sb.ad,
    adapters: [{ name: "pi-data-only", data: [join(sb.ad, "cache")] }],
    cwd: sb.cwd,
    projectTrusted: false,
  });
  t.after(() => intercept.uninstall());
  assert.equal(fs.readFileSync(plain, "utf8"), "untouched");
  assert.deepEqual(intercept.health().problems, []);
});

// Regression: plugins written with named ESM imports (`import { readFileSync }
// from "node:fs"`) bind to the builtin's exports object, which is only refreshed by
// syncBuiltinESMExports(). The helper module deliberately imports that way.
test("named ESM imports of node:fs are intercepted", async (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.ad, "extensions/settings"), { recursive: true });
  writeFileSync(sb.newConfig, '{"adopted":true}');
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.equal(readNamed(sb.oldConfig), '{"adopted":true}');
  assert.equal(await readNamedAsync(sb.oldConfig), '{"adopted":true}');
  assert.ok((await statNamedAsync(sb.oldConfig)).isFile());
});
