import fs from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./paths.ts";

export interface MigrationRecord {
  migratedAt: string;
  config?: { from: string; to: string };
  data?: { from: string; to: string }[];
}

export interface MigrationState {
  migrations: Record<string, MigrationRecord>;
}

// Record of which plugins have been adopted and where their files went. Written by
// /unify:migrate and cleared by /unify:eject; read by the diagnostics view.
export function readState(agentDir: string): MigrationState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(agentDir), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.migrations && typeof parsed.migrations === "object") {
      return { migrations: parsed.migrations as Record<string, MigrationRecord> };
    }
  } catch {
    // Corrupt or unreadable state must never break startup; it just means "nothing adopted yet".
  }
  return { migrations: {} };
}

export function writeState(agentDir: string, state: MigrationState): void {
  const path = statePath(agentDir);
  const tmp = `${path}.tmp`;
  fs.mkdirSync(dirname(path), { recursive: true });
  // Temp + rename: a crash cannot truncate the file holding every record.
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, path);
}
