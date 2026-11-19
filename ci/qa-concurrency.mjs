// Decides which QA runs may replace one another. Dependency-free, so the QA
// workflow can run it straight after checkout.
//
// Two runs share a key only when they are for the same pull request. The key
// never comes from text a pull request controls:
//   - for a build started by a pull-request event, the number is GitHub's own
//     record of that event; what the build says about itself is ignored
//   - for a manually started build, the number is the one the maintainer
//     typed, carried by the default branch's workflow
//   - anything else gets a key of its own and can cancel nothing
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const number = (value) => (/^[1-9]\d{0,8}$/.test(String(value ?? "")) ? String(value) : undefined);

export function concurrencyKey({ event, eventPr, metaPr, runId }) {
  const own = `run-${/^\d+$/.test(String(runId ?? "")) ? runId : "unknown"}`;
  if (event === "pull_request") return number(eventPr) ? `pr-${number(eventPr)}` : own;
  if (event === "workflow_dispatch") return number(metaPr) ? `pr-${number(metaPr)}` : own;
  return own;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let metaPr;
  try {
    metaPr = JSON.parse(readFileSync(process.argv[2], "utf8")).pr;
  } catch {
    metaPr = undefined;
  }
  console.log(
    concurrencyKey({ event: process.env.TRIGGER_EVENT, eventPr: process.env.EVENT_PR, metaPr, runId: process.env.RUN_ID }),
  );
}
