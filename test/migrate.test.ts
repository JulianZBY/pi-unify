import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/migrate.ts";
import { configLayers, readConfig } from "../src/config.ts";
import { backupDir, settingsDir, dataRoot } from "../src/paths.ts";
import { readState, writeState } from "../src/state.ts";
import type { Adapter } from "../src/adapters.ts";
import type { CommandOptions } from "../src/types.ts";

interface Sandbox {
  ad: string;
  cwd: string;
  adapter: Adapter;
  oldConfig: string;
  newConfig: string;
  oldData: string;
  newData: string;
}

function sandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-migrate-"));
  const ad = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(ad, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter: Adapter = {
    name: "pi-demo",
    config: { path: join(ad, "demo.json"), projectOverride: "demo.json" },
    data: [join(ad, "demo-cache")],
  };
  return {
    ad,
    cwd,
    adapter,
    oldConfig: join(ad, "demo.json"),
    newConfig: join(settingsDir(ad), "pi-demo.json"),
    oldData: join(ad, "demo-cache"),
    newData: join(dataRoot(ad), "pi-demo"),
  };
}

function opts(sb: Sandbox, now?: () => Date) {
  return now === undefined
    ? { agentDir: sb.ad, adapters: [sb.adapter] }
    : { agentDir: sb.ad, adapters: [sb.adapter], now };
}

const fixedNow = () => new Date("2026-02-03T04:05:06.000Z");

function list(dir: string): string[] {
  return fs.existsSync(dir) ? readdirSync(dir).sort() : [];
}

test("unknown plugin name reports an error and moves nothing", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  const result = migrate("nope", opts(sb));
  assert.equal(result.ok, false);
  assert.match(result.message, /unknown adapter "nope"/);
  assert.equal(fs.readFileSync(sb.oldConfig, "utf8"), '{"a":1}');
  assert.equal(fs.existsSync(backupDir(sb.ad)), false);
});

test("empty name reports usage and moves nothing", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  const result = migrate("   ", opts(sb));
  assert.equal(result.ok, false);
  assert.match(result.message, /usage/i);
  assert.equal(fs.readFileSync(sb.oldConfig, "utf8"), '{"a":1}');
});

test("config move backs up the old file first, then leaves no trace at the old path", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, true, result.message);

  const stamp = join(backupDir(sb.ad), "pi-demo", "2026-02-03T04-05-06-000Z");
  assert.deepEqual(result.backedUp, [join(stamp, "config/demo.json")]);
  assert.equal(fs.readFileSync(join(stamp, "config/demo.json"), "utf8"), '{"a":1}');

  assert.equal(fs.existsSync(sb.oldConfig), false);
  assert.equal(fs.readFileSync(sb.newConfig, "utf8"), '{"a":1}');
  assert.deepEqual(result.moved, [sb.newConfig]);
});

test("data dir contents move under the unified data dir preserving layout", (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.oldData, "deep/nested"), { recursive: true });
  writeFileSync(join(sb.oldData, "top.txt"), "top");
  writeFileSync(join(sb.oldData, "deep/nested/leaf.txt"), "leaf");

  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, true, result.message);

  assert.equal(fs.readFileSync(join(sb.newData, "top.txt"), "utf8"), "top");
  assert.equal(fs.readFileSync(join(sb.newData, "deep/nested/leaf.txt"), "utf8"), "leaf");
  assert.equal(fs.existsSync(sb.oldData), false);

  const stamp = join(backupDir(sb.ad), "pi-demo", "2026-02-03T04-05-06-000Z");
  assert.equal(fs.readFileSync(join(stamp, "data/demo-cache/deep/nested/leaf.txt"), "utf8"), "leaf");
});

test("config and data merge into an existing unified data dir", (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.oldData, "shared"), { recursive: true });
  mkdirSync(join(sb.newData, "shared"), { recursive: true });
  writeFileSync(join(sb.oldData, "shared/old.txt"), "old");
  writeFileSync(join(sb.newData, "shared/new.txt"), "new");

  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(list(join(sb.newData, "shared")), ["new.txt", "old.txt"]);
  assert.equal(fs.existsSync(sb.oldData), false);
});

test("migration state records config and data moves for eject", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  mkdirSync(sb.oldData, { recursive: true });
  writeFileSync(join(sb.oldData, "cache.txt"), "x");

  assert.equal(migrate("pi-demo", opts(sb, fixedNow)).ok, true);

  const record = readState(sb.ad).migrations["pi-demo"];
  assert.equal(record.migratedAt, "2026-02-03T04:05:06.000Z");
  assert.deepEqual(record.config, { from: sb.oldConfig, to: sb.newConfig });
  assert.deepEqual(record.data, [{ from: sb.oldData, to: sb.newData }]);
});

test("a second run is a no-op", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  mkdirSync(sb.oldData, { recursive: true });
  writeFileSync(join(sb.oldData, "cache.txt"), "x");
  assert.equal(migrate("pi-demo", opts(sb, fixedNow)).ok, true);

  const backupsBefore = list(join(backupDir(sb.ad), "pi-demo"));
  const mtimeBefore = statSync(sb.newConfig).mtimeMs;

  const again = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(again.ok, true);
  assert.match(again.message, /already migrated/);
  assert.deepEqual(again.moved, []);
  assert.deepEqual(again.backedUp, []);
  assert.deepEqual(list(join(backupDir(sb.ad), "pi-demo")), backupsBefore);
  assert.equal(statSync(sb.newConfig).mtimeMs, mtimeBefore);
  assert.equal(fs.readFileSync(sb.newConfig, "utf8"), '{"a":1}');
});

test("fresh install with no old files records nothing", (t) => {
  const sb = sandbox(t);
  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, true);
  assert.match(result.message, /no old files to migrate/);
  assert.deepEqual(result.backedUp, []);
  assert.deepEqual(result.moved, []);
  assert.deepEqual(readState(sb.ad).migrations, {});
  assert.equal(fs.existsSync(backupDir(sb.ad)), false);
});

test("project override files are never touched and still merge after migration", (t) => {
  const sb = sandbox(t);
  const projectFile = join(sb.cwd, ".pi/unify/demo.json");
  mkdirSync(join(sb.cwd, ".pi/unify"), { recursive: true });
  writeFileSync(projectFile, '{"b":2}');
  writeFileSync(sb.oldConfig, '{"a":1}');

  assert.equal(migrate("pi-demo", opts(sb, fixedNow)).ok, true);

  assert.equal(fs.readFileSync(projectFile, "utf8"), '{"b":2}');
  const layers = configLayers({ agentDir: sb.ad, cwd: sb.cwd, projectTrusted: true }, sb.adapter);
  assert.ok(layers);
  assert.deepEqual(readConfig(layers)?.merged, { a: 1, b: 2 });
});

test("two migrations in the same second get separate backup dirs", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"first":1}');
  assert.equal(migrate("pi-demo", opts(sb, fixedNow)).ok, true);

  // Undo by hand the way eject would, then migrate again within the same second.
  writeState(sb.ad, { migrations: {} });
  writeFileSync(sb.oldConfig, '{"second":2}');
  assert.equal(migrate("pi-demo", opts(sb, fixedNow)).ok, true);

  assert.deepEqual(list(join(backupDir(sb.ad), "pi-demo")), [
    "2026-02-03T04-05-06-000Z",
    "2026-02-03T04-05-06-000Z-2",
  ]);
  const second = join(backupDir(sb.ad), "pi-demo", "2026-02-03T04-05-06-000Z-2", "config/demo.json");
  assert.equal(fs.readFileSync(second, "utf8"), '{"second":2}');
});

test("a failing move returns ok:false instead of throwing", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  // A regular file where the settings dir must go makes the move impossible.
  mkdirSync(join(sb.ad, "extensions"), { recursive: true });
  writeFileSync(settingsDir(sb.ad), "not a directory");

  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, false);
  assert.match(result.message, /pi-demo/);
  assert.equal(fs.existsSync(sb.oldConfig), true);
  assert.deepEqual(readState(sb.ad).migrations, {});
});

test("/unify:migrate command is registered and reports its result without throwing", async (t) => {
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-unify-migrate-cmd-"));
  t.after(() => {
    rmSync(process.env.PI_CODING_AGENT_DIR as string, { recursive: true, force: true });
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  });

  const { default: piUnify } = await import("../src/index.ts");
  const commands = new Map<string, CommandOptions>();
  piUnify({ on: () => {}, registerCommand: (name, options) => commands.set(name, options) });
  const command = commands.get("unify:migrate");
  assert.ok(command, "/unify:migrate command registered");

  const seen: [string, string | undefined][] = [];
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => false,
    ui: { notify: (msg: string, type?: "info" | "warning" | "error") => seen.push([msg, type]) },
  };
  await command.handler("  ", ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1], "error");
  assert.match(seen[0][0], /usage/i);
});
