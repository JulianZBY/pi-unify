import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState } from "../src/state.ts";
import { statePath } from "../src/paths.ts";

function agentDir(t: { after: (fn: () => void) => void }): string {
  const ad = mkdtempSync(join(tmpdir(), "pi-unify-state-"));
  t.after(() => rmSync(ad, { recursive: true, force: true }));
  return ad;
}

test("missing state file means nothing adopted", (t) => {
  assert.deepEqual(readState(agentDir(t)), { migrations: {} });
});

test("state round-trips through the agent dir", (t) => {
  const ad = agentDir(t);
  writeState(ad, { migrations: { "pi-demo": { migratedAt: "2026-01-01T00:00:00Z" } } });
  assert.deepEqual(readState(ad).migrations["pi-demo"].migratedAt, "2026-01-01T00:00:00Z");
});

test("corrupt state file is ignored rather than thrown", (t) => {
  const ad = agentDir(t);
  mkdirSync(join(ad, "extensions/data/unify"), { recursive: true });
  writeFileSync(statePath(ad), "{ not json");
  assert.deepEqual(readState(ad), { migrations: {} });
});
