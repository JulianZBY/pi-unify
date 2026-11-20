import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdapters } from "../src/adapters.ts";
import type { Adapter } from "../src/adapters.ts";
import { installIntercept } from "../src/fs-intercept.ts";
import { migrate } from "../src/migrate.ts";
import { settingsDir } from "../src/paths.ts";

const SHIPPED = join(import.meta.dirname, "../adapters");

// Paths verified against the installed plugin sources; see README table.
// `<agent>` is the agent dir token expandPath understands, so a relocated
// PI_CODING_AGENT_DIR keeps matching the plugins that honor it.
const EXPECTED: Record<string, { config?: string; projectOverride?: string; data: string[] }> = {
  "pi-caveman": { config: "<agent>/caveman.json", projectOverride: "caveman.json", data: [] },
  "pi-fff": {
    config: "<agent>/pi-fff.json",
    projectOverride: "pi-fff.json",
    data: ["<agent>/fff/frecency", "<agent>/fff/history"],
  },
  "pi-web-search": { config: "<agent>/web-search.json", projectOverride: "web-search.json", data: [] },
  "pi-cc-extensions": {
    config: "<agent>/pi-cc-extensions.json",
    projectOverride: "pi-cc-extensions.json",
    data: [],
  },
  "pi-memory": { data: ["~/.pi/agent/memory"] },
  "pi-lens": { config: "~/.pi-lens/config.json", projectOverride: "pi-lens.json", data: [] },
};

function emptyAgentDir(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-builtin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("all six shipped descriptors load without warnings", (t) => {
  const ad = emptyAgentDir(t);
  const { adapters, warnings } = loadAdapters(ad, [SHIPPED]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    adapters.map((a) => a.name).sort(),
    ["pi-caveman", "pi-cc-extensions", "pi-fff", "pi-lens", "pi-memory", "pi-web-search"],
  );
});

test("each shipped descriptor declares the verifiably correct old paths", (t) => {
  const { adapters } = loadAdapters(emptyAgentDir(t), [SHIPPED]);
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const adapter = adapters.find((a) => a.name === name);
    assert.ok(adapter, `missing descriptor for ${name}`);
    assert.equal(adapter.config?.path, expected.config, `${name} config path`);
    assert.equal(adapter.config?.projectOverride, expected.projectOverride, `${name} projectOverride`);
    assert.deepEqual(adapter.data, expected.data, `${name} data paths`);
  }
  // Data-only plugin: no config means no project override layer either.
  const memory = adapters.find((a) => a.name === "pi-memory");
  assert.equal(memory?.config, undefined);
});

interface Sandbox {
  ad: string;
  cwd: string;
  adapters: Adapter[];
  oldConfig: string;
}

// Mirrors pi-caveman's real layout: one JSON config in the agent dir.
function cavemanSandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-caveman-"));
  const ad = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(ad, { recursive: true });
  // A real install already has the unified settings dir; keep the intercept quiet.
  mkdirSync(settingsDir(ad), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { adapters } = loadAdapters(ad, [SHIPPED]);
  const oldConfig = join(ad, "caveman.json");
  writeFileSync(oldConfig, JSON.stringify({ defaultLevel: "ultra", showStatus: false }));
  return { ad, cwd, adapters, oldConfig };
}

test("migrating pi-caveman makes the plugin's old-path read serve the unified file", (t) => {
  const sb = cavemanSandbox(t);
  const warnings: string[] = [];
  const intercept = installIntercept({
    agentDir: sb.ad,
    adapters: sb.adapters,
    cwd: sb.cwd,
    projectTrusted: false,
    onWarn: (m) => warnings.push(m),
  });
  t.after(() => intercept.uninstall());

  // Before migration the old path is the only layer, so it is served verbatim.
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), {
    defaultLevel: "ultra",
    showStatus: false,
  });
  assert.deepEqual(warnings, []);

  const result = migrate("pi-caveman", { agentDir: sb.ad, adapters: sb.adapters });
  assert.equal(result.ok, true, result.message);

  const unified = join(settingsDir(sb.ad), "pi-caveman.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(unified, "utf8")), {
    defaultLevel: "ultra",
    showStatus: false,
  });
  // The plugin still reads the OLD path and gets the migrated values.
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), {
    defaultLevel: "ultra",
    showStatus: false,
  });
  // No stale duplicate on disk (readdir bypasses the patch, so this is real).
  assert.equal(readdirSync(sb.ad).includes("caveman.json"), false);

  // A plugin write through the old path lands in the unified file.
  fs.writeFileSync(sb.oldConfig, JSON.stringify({ defaultLevel: "off", showStatus: false }));
  assert.deepEqual(JSON.parse(fs.readFileSync(unified, "utf8")), {
    defaultLevel: "off",
    showStatus: false,
  });
});

test("a project override still wins over the migrated global file when trusted", (t) => {
  const sb = cavemanSandbox(t);
  const first = installIntercept({
    agentDir: sb.ad,
    adapters: sb.adapters,
    cwd: sb.cwd,
    projectTrusted: false,
  });
  migrate("pi-caveman", { agentDir: sb.ad, adapters: sb.adapters });
  first.uninstall();

  mkdirSync(join(sb.cwd, ".pi/unify"), { recursive: true });
  writeFileSync(join(sb.cwd, ".pi/unify/caveman.json"), JSON.stringify({ defaultLevel: "off" }));

  const untrusted = installIntercept({
    agentDir: sb.ad,
    adapters: sb.adapters,
    cwd: sb.cwd,
    projectTrusted: false,
  });
  assert.equal(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")).defaultLevel, "ultra");
  untrusted.uninstall();

  const trusted = installIntercept({
    agentDir: sb.ad,
    adapters: sb.adapters,
    cwd: sb.cwd,
    projectTrusted: true,
  });
  t.after(() => trusted.uninstall());
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), {
    defaultLevel: "off",
    showStatus: false,
  });
});
