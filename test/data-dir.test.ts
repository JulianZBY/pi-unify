import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installIntercept } from "../src/fs-intercept.ts";
import type { Adapter } from "../src/adapters.ts";

interface Sandbox {
  ad: string;
  cwd: string;
  adapter: Adapter;
  oldData: string;
  unified: string;
}

function sandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-data-"));
  const ad = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(ad, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldData = join(ad, "memory");
  return {
    ad,
    cwd,
    adapter: { name: "pi-memory", data: [oldData] },
    oldData,
    unified: join(ad, "extensions/data/pi-memory"),
  };
}

function install(sb: Sandbox, adapters: Adapter[] = [sb.adapter]) {
  return installIntercept({ agentDir: sb.ad, adapters, cwd: sb.cwd, projectTrusted: false });
}

// Written straight to disk, bypassing the patch, to model a pre-migration layout.
function seed(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("write under the old data dir lands in the unified dir with parent dirs created", (t) => {
  const sb = sandbox(t);
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  fs.writeFileSync(join(sb.oldData, "nested/deep/note.txt"), "hello");
  assert.equal(fs.readFileSync(join(sb.unified, "nested/deep/note.txt"), "utf8"), "hello");
  assert.equal(fs.existsSync(join(sb.oldData, "nested/deep/note.txt")), true);
  intercept.uninstall();
  assert.equal(fs.existsSync(join(sb.oldData, "nested/deep/note.txt")), false, "nothing written to the old dir");
});

test("read under the old data dir comes from the unified dir", (t) => {
  const sb = sandbox(t);
  seed(join(sb.unified, "a.txt"), "unified");
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.equal(fs.readFileSync(join(sb.oldData, "a.txt"), "utf8"), "unified");
  assert.equal(fs.existsSync(join(sb.oldData, "a.txt")), true);
  assert.equal(fs.statSync(join(sb.oldData, "a.txt")).size, "unified".length);
});

test("unified dir wins over the old dir when both exist", (t) => {
  const sb = sandbox(t);
  seed(join(sb.oldData, "a.txt"), "old");
  seed(join(sb.unified, "a.txt"), "unified");
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.equal(fs.readFileSync(join(sb.oldData, "a.txt"), "utf8"), "unified");
  assert.deepEqual(fs.readdirSync(sb.oldData), ["a.txt"]);
});

test("unmigrated old data dir still reads through the old path", (t) => {
  const sb = sandbox(t);
  seed(join(sb.oldData, "legacy.txt"), "legacy");
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.equal(fs.readFileSync(join(sb.oldData, "legacy.txt"), "utf8"), "legacy");
  assert.equal(fs.existsSync(sb.oldData), true);
  assert.deepEqual(fs.readdirSync(sb.oldData), ["legacy.txt"]);
});

test("missing data path reports the unified location, not the old one", (t) => {
  const sb = sandbox(t);
  const intercept = install(sb);
  t.after(() => intercept.uninstall());
  const missing = join(sb.oldData, "gone.txt");

  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => fs.readFileSync(missing, "utf8"), (err: NodeJS.ErrnoException) => {
    return err.code === "ENOENT" && err.message.includes(join(sb.unified, "gone.txt"));
  });
});

test("mkdir and rm under the old data dir act on the unified dir", (t) => {
  const sb = sandbox(t);
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  fs.mkdirSync(join(sb.oldData, "cache"), { recursive: true });
  assert.equal(fs.statSync(join(sb.unified, "cache")).isDirectory(), true);
  fs.writeFileSync(join(sb.oldData, "cache/x.txt"), "x");
  fs.rmSync(join(sb.oldData, "cache"), { recursive: true });
  assert.equal(fs.existsSync(join(sb.unified, "cache")), false);
  assert.equal(fs.existsSync(join(sb.oldData, "cache")), false);
});

test("paths outside every data dir pass through byte-identically", (t) => {
  const sb = sandbox(t);
  const sibling = join(sb.ad, "memory-other/x.txt");
  const parent = join(sb.ad, "plain.txt");
  seed(sibling, "sibling");
  seed(parent, "plain");
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.equal(fs.readFileSync(sibling, "utf8"), "sibling");
  assert.equal(fs.readFileSync(parent, "utf8"), "plain");
  assert.equal(fs.existsSync(join(sb.ad, "extensions/data/pi-memory-other")), false);
});

test("async fs calls are redirected the same way", async (t) => {
  const sb = sandbox(t);
  seed(join(sb.unified, "a.txt"), "async");
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.equal(await fs.promises.readFile(join(sb.oldData, "a.txt"), "utf8"), "async");
  assert.equal((await fs.promises.stat(join(sb.oldData, "a.txt"))).size, "async".length);
  await fs.promises.writeFile(join(sb.oldData, "b.txt"), "written");
  assert.equal(await fs.promises.readFile(join(sb.unified, "b.txt"), "utf8"), "written");
  await fs.promises.mkdir(join(sb.oldData, "d"), { recursive: true });
  assert.equal((await fs.promises.readdir(sb.oldData)).includes("d"), true);
  assert.deepEqual(fs.readdirSync(sb.unified), ["a.txt", "b.txt", "d"]);
  await fs.promises.rm(join(sb.oldData, "b.txt"));
  assert.equal(fs.existsSync(join(sb.unified, "b.txt")), false);
});

test("config interception wins over a data dir that contains the config path", (t) => {
  const sb = sandbox(t);
  const oldConfig = join(sb.oldData, "config.json");
  const shared: Adapter = { name: "pi-memory", config: { path: oldConfig }, data: [sb.oldData] };
  const intercept = install(sb, [shared]);
  t.after(() => intercept.uninstall());

  fs.writeFileSync(oldConfig, JSON.stringify({ a: 1 }));
  assert.equal(fs.readFileSync(join(sb.ad, "extensions/settings/pi-memory.json"), "utf8"), JSON.stringify({ a: 1 }));
  assert.equal(fs.existsSync(join(sb.unified, "config.json")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(oldConfig, "utf8")), { a: 1 });
});

test("config and data interception are active at the same time", (t) => {
  const sb = sandbox(t);
  const oldConfig = join(sb.ad, "demo.json");
  const adapters: Adapter[] = [
    { name: "pi-demo", config: { path: oldConfig }, data: [] },
    sb.adapter,
  ];
  seed(join(sb.ad, "extensions/settings/pi-demo.json"), JSON.stringify({ unified: true }));
  const intercept = install(sb, adapters);
  t.after(() => intercept.uninstall());

  assert.deepEqual(JSON.parse(fs.readFileSync(oldConfig, "utf8")), { unified: true });
  fs.writeFileSync(join(sb.oldData, "x.txt"), "data");
  assert.equal(fs.readFileSync(join(sb.unified, "x.txt"), "utf8"), "data");
});

test("uninstall stops the redirection", (t) => {
  const sb = sandbox(t);
  const intercept = install(sb);
  fs.writeFileSync(join(sb.oldData, "a.txt"), "redirected");
  intercept.uninstall();

  assert.equal(fs.existsSync(join(sb.unified, "a.txt")), true);
  seed(join(sb.oldData, "a.txt"), "old");
  assert.equal(fs.readFileSync(join(sb.oldData, "a.txt"), "utf8"), "old");
});

test("health reports a data dir that exists but is not a directory", (t) => {
  const sb = sandbox(t);
  seed(sb.oldData, "i am a file");
  const intercept = install(sb);
  t.after(() => intercept.uninstall());

  assert.ok(
    intercept.health().problems.some((p) => p.includes(sb.oldData)),
    intercept.health().problems.join("; "),
  );
});
