import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  agentDir,
  unifyAdapterDir,
  settingsDir,
  dataRoot,
  backupDir,
  statePath,
  expandPath,
} from "../src/paths.ts";
import { loadAdapters } from "../src/adapters.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-unify-adapters-"));
}

test("agent dir honours PI_CODING_AGENT_DIR with tilde and env expansion", () => {
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/tmp/custom-agent" }), "/tmp/custom-agent");
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/relocated-agent" }), join(homedir(), "relocated-agent"));
  assert.equal(
    agentDir({ PI_CODING_AGENT_DIR: "$MY_ROOT/agent", MY_ROOT: "/tmp/root" }),
    "/tmp/root/agent",
  );
  assert.equal(agentDir({}), join(homedir(), ".pi/agent"));
});

test("owned path helpers hang off the agent dir", () => {
  const ad = "/tmp/agent";
  assert.equal(unifyAdapterDir(ad), "/tmp/agent/extensions/unify");
  assert.equal(settingsDir(ad), "/tmp/agent/extensions/settings");
  assert.equal(dataRoot(ad), "/tmp/agent/extensions/data");
  assert.equal(backupDir(ad), "/tmp/agent/extensions/data/unify/backup");
  assert.equal(statePath(ad), "/tmp/agent/extensions/data/unify/state.json");
});

test("expandPath expands tilde, env vars and the agent dir token", () => {
  assert.equal(expandPath("~/x.json", "/tmp/agent"), join(homedir(), "x.json"));
  assert.equal(expandPath("$HOME/x.json", "/tmp/agent"), join(homedir(), "x.json"));
  assert.equal(expandPath("/literal/x.json", "/tmp/agent"), "/literal/x.json");
});

test("loadAdapters reads descriptors from the agent unify dir", (t) => {
  const ad = tempDir();
  t.after(() => rmSync(ad, { recursive: true, force: true }));
  mkdirSync(unifyAdapterDir(ad), { recursive: true });
  writeFileSync(
    join(unifyAdapterDir(ad), "caveman.json"),
    JSON.stringify({ name: "pi-caveman", config: { path: "~/caveman.json", projectOverride: "caveman.json" } }),
  );
  writeFileSync(
    join(unifyAdapterDir(ad), "memory.json"),
    JSON.stringify({ name: "pi-memory", data: ["~/memory-dir"] }),
  );

  const { adapters, warnings } = loadAdapters(ad);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    adapters.map((a) => a.name).sort(),
    ["pi-caveman", "pi-memory"],
  );
  const caveman = adapters.find((a) => a.name === "pi-caveman")!;
  assert.deepEqual(caveman.config, { path: "~/caveman.json", projectOverride: "caveman.json" });
  assert.deepEqual(caveman.data, []);
  assert.deepEqual(adapters.find((a) => a.name === "pi-memory")!.data, ["~/memory-dir"]);
});

test("missing adapter dir yields no adapters and no throw", () => {
  const ad = tempDir();
  try {
    assert.deepEqual(loadAdapters(ad), { adapters: [], warnings: [] });
  } finally {
    rmSync(ad, { recursive: true, force: true });
  }
});

test("malformed descriptor becomes a warning, not a throw", (t) => {
  const ad = tempDir();
  t.after(() => rmSync(ad, { recursive: true, force: true }));
  mkdirSync(unifyAdapterDir(ad), { recursive: true });
  writeFileSync(join(unifyAdapterDir(ad), "broken.json"), "{ not json");
  writeFileSync(join(unifyAdapterDir(ad), "nameless.json"), JSON.stringify({ data: ["~/d"] }));
  writeFileSync(join(unifyAdapterDir(ad), "ok.json"), JSON.stringify({ name: "pi-ok" }));

  const { adapters, warnings } = loadAdapters(ad);
  assert.deepEqual(adapters.map((a) => a.name), ["pi-ok"]);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join("\n"), /broken\.json/);
  assert.match(warnings.join("\n"), /nameless\.json/);
});

test("extraDirs contribute shipped descriptors and later dirs win on name clash", (t) => {
  const ad = tempDir();
  const shipped = tempDir();
  t.after(() => {
    rmSync(ad, { recursive: true, force: true });
    rmSync(shipped, { recursive: true, force: true });
  });
  mkdirSync(unifyAdapterDir(ad), { recursive: true });
  writeFileSync(join(unifyAdapterDir(ad), "fff.json"), JSON.stringify({ name: "pi-fff", config: { path: "~/a.json" } }));
  writeFileSync(join(shipped, "fff.json"), JSON.stringify({ name: "pi-fff", config: { path: "~/b.json" } }));
  writeFileSync(join(shipped, "web.json"), JSON.stringify({ name: "pi-web-search", data: ["~/web"] }));

  // agent-dir descriptors come first, so they win a name clash over shipped ones
  const { adapters } = loadAdapters(ad, [shipped]);
  assert.deepEqual(adapters.map((a) => a.name).sort(), ["pi-fff", "pi-web-search"]);
  assert.equal(adapters.find((a) => a.name === "pi-fff")!.config!.path, "~/a.json");
});
