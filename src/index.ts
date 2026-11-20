import { join } from "node:path";
import { loadAdapters } from "./adapters.ts";
import { installIntercept } from "./fs-intercept.ts";
import { agentDir } from "./paths.ts";
import type { ExtensionAPI } from "./types.ts";

// This package must load before the plugins it adopts (see README), so the
// intercept is installed here in the factory rather than in session_start.
export default function piUnify(pi: ExtensionAPI): void {
  const ad = agentDir();
  const warnings: string[] = [];
  const { adapters, warnings: loadWarnings } = loadAdapters(ad, [join(import.meta.dirname, "../adapters")]);
  warnings.push(...loadWarnings);
  const intercept = installIntercept({
    agentDir: ad,
    adapters,
    cwd: process.cwd(),
    projectTrusted: false,
    onWarn: (msg) => warnings.push(msg),
  });

  pi.registerCommand("unify", {
    description: "Show pi-unify status",
    handler: async (_args, ctx) => {
      const health = intercept.health();
      const summary = `pi-unify: ${adapters.length} adapter(s), ${health.patched.length} fs function(s) intercepted`;
      const problems = [...health.problems, ...warnings];
      ctx.ui.notify(problems.length ? `${summary}; ${problems.length} problem(s)` : summary, "info");
    },
  });
}
