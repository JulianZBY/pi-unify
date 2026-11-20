// First import on purpose: evaluating ./probe.ts installs the read probe, which
// must happen before any adapter or plugin work below.
import "./probe.ts";
import { join } from "node:path";
import { loadAdapters } from "./adapters.ts";
import { installIntercept } from "./fs-intercept.ts";
import { agentDir } from "./paths.ts";
import { earlyReads, selfCheck, setSelfCheck } from "./probe.ts";
import type { ExtensionAPI, InterceptOptions } from "./types.ts";

function selfCheckMessage(hits: string[]): string {
  return (
    `pi-unify: ${hits.length} adopted config file(s) were read before interception was installed` +
    " — pi-unify must be first in `packages`. Move it to the top and /reload."
  );
}

// This package must load before the plugins it adopts (see README), so the
// intercept is installed here in the factory rather than in session_start.
export default function piUnify(pi: ExtensionAPI): void {
  const ad = agentDir();
  const warnings: string[] = [];
  const { adapters, warnings: loadWarnings } = loadAdapters(ad, [join(import.meta.dirname, "../adapters")]);
  warnings.push(...loadWarnings);
  const options: InterceptOptions = {
    agentDir: ad,
    adapters,
    cwd: process.cwd(),
    projectTrusted: false,
    onWarn: (msg) => warnings.push(msg),
  };
  const intercept = installIntercept(options);

  const hits = earlyReads(adapters, ad);
  setSelfCheck({ hits, ok: hits.length === 0 });

  pi.on("session_start", (_event, ctx) => {
    // Project overrides are only read once the host reports the project trusted;
    // the intercept re-reads this flag per call, so no second patch is needed.
    options.projectTrusted = ctx.isProjectTrusted();
    if (!ctx.hasUI || hits.length === 0) return;
    ctx.ui.notify(selfCheckMessage(hits), "warning");
  });

  pi.registerCommand("unify", {
    description: "Show pi-unify status",
    handler: async (_args, ctx) => {
      const health = intercept.health();
      const checked = selfCheck();
      const summary = `pi-unify: ${adapters.length} adapter(s), ${health.patched.length} fs function(s) intercepted`;
      const problems = [...health.problems, ...warnings];
      const problemsPart = problems.length ? `; ${problems.length} problem(s)` : "";
      const selfCheckPart = checked.ok ? "" : `; ${checked.hits.length} adopted config file(s) read before interception`;
      ctx.ui.notify(`${summary}${problemsPart}${selfCheckPart}`, "info");
    },
  });
}
