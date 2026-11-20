import test from "node:test";
import assert from "node:assert/strict";
import piUnify from "../src/index.ts";
import type { CommandOptions } from "../src/types.ts";

test("extension loads and registers a callable liveness command", async () => {
  const commands = new Map<string, CommandOptions>();
  piUnify({
    on: () => {},
    registerCommand: (name, options) => commands.set(name, options),
  });

  const command = commands.get("unify");
  assert.ok(command, "/unify command registered");

  const seen: string[] = [];
  await command.handler("", {
    cwd: "/tmp",
    isProjectTrusted: () => false,
    ui: { notify: (msg) => seen.push(msg) },
  });
  assert.equal(seen.length, 1, "one multi-line notify");
  assert.match(seen[0] as string, /^pi-unify: \d+ adapter\(s\) loaded, \d+ migrated$/m);
  assert.match(seen[0] as string, /^interception: 13 fs function\(s\) patched/m);
  assert.match(seen[0] as string, /^self-check: /m);
});
