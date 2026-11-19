import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fillTemplate } from "../src/env.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// Vocabulary, routes and selectors of the demonstration applications. None of
// it may appear in the agent: what it knows about an application has to come
// from the ticket, the manifest and the application itself. Extend this list
// whenever a demonstration application is added.
//
// "approve" used to be on this list for the time-off application. It was
// taken off when the agent gained its own, unrelated use of the word: the
// approval of requirement changes by a requirement owner.
//
// The second group is for the first application that was not written for
// this project (a project-management tool in PHP): its name, its nouns, and
// the names of its controllers and form dialogs.
const APPLICATION_TERMS =
  /\b(loyalty|cart|checkout|customers?|products?|orders?|payments?|welcome|shop|points|employees?|managers?|time-?off|leave requests?)\b|(?<!\/rest)\/api\/|\/login|data-testid|\b(kanban|kanboard|swimlanes?|boards?|subtasks?|columns?|php)\b|controller=|modal-content|csrf_token/i;

test("agent source contains no application-specific vocabulary, routes or selectors", async () => {
  const files = (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 5);
  for (const file of files) {
    const lines = (await readFile(path.join(SRC, file), "utf8")).split("\n");
    lines.forEach((line, i) => {
      assert.doesNotMatch(line, APPLICATION_TERMS, `${file}:${i + 1}`);
    });
  }
});

test("fixture bodies are templates owned by the application's manifest", () => {
  assert.deepEqual(fillTemplate({ user: { handle: "u-{{key}}" }, tags: ["{{key}}"], n: 1 }, "sc-1-a"), {
    user: { handle: "u-sc-1-a" },
    tags: ["sc-1-a"],
    n: 1,
  });
  assert.equal(fillTemplate(undefined, "k"), undefined);
});
