import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors the host's getAgentDir() locally so tests need no host dependency.
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured) {
    return expand(configured, join(homedir(), ".pi/agent"), env);
  }
  return join(homedir(), ".pi/agent");
}

export function unifyAdapterDir(ad: string): string {
  return join(ad, "extensions/unify");
}

export function settingsDir(ad: string): string {
  return join(ad, "extensions/settings");
}

export function dataRoot(ad: string): string {
  return join(ad, "extensions/data");
}

export function backupDir(ad: string): string {
  return join(ad, "extensions/data/unify/backup");
}

export function statePath(ad: string): string {
  return join(ad, "extensions/data/unify/state.json");
}

// Descriptor paths are literal: only ~, $VAR/${VAR} and a leading agent-dir
// token are expanded. Matching later happens on this expanded absolute form.
export function expandPath(p: string, ad: string): string {
  return expand(p, ad, process.env);
}

function expand(p: string, ad: string, env: NodeJS.ProcessEnv): string {
  return p
    .replace(/^~(?=$|\/)/, homedir())
    .replace(/\$\{(\w+)\}|\$(\w+)/g, (whole: string, braced: string | undefined, bare: string | undefined) =>
      env[(braced ?? bare) as string] ?? whole,
    )
    .replace(/^<agent>/, ad);
}
