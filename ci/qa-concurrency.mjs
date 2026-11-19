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

export function concurrencyKey({ event, eventPr, metaPr, runId, metaRepo, thisRepo }) {
  const own = `run-${/^\d+$/.test(String(runId ?? "")) ? runId : "unknown"}`;
  // A request for an application in another repository shares a group with
  // nothing: its pull request numbers are not this repository's.
  if (metaRepo !== undefined && metaRepo !== "" && metaRepo !== thisRepo) return own;
  if (event === "pull_request") return number(eventPr) ? `pr-${number(eventPr)}` : own;
  if (event === "workflow_dispatch") return number(metaPr) ? `pr-${number(metaPr)}` : own;
  return own;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let metaPr;
  let metaRepo;
  try {
    const meta = JSON.parse(readFileSync(process.argv[2], "utf8"));
    metaPr = meta.pr;
    metaRepo = typeof meta.repo === "string" ? meta.repo : meta.repo === undefined ? undefined : "invalid";
  } catch {
    metaPr = undefined;
  }
  console.log(
    concurrencyKey({ event: process.env.TRIGGER_EVENT, eventPr: process.env.EVENT_PR, metaPr, runId: process.env.RUN_ID, metaRepo, thisRepo: process.env.THIS_REPO }),
  );
}
