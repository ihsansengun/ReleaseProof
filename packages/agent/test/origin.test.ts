import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { request } from "playwright";
import { createFixtures, deployedSha } from "../src/env.ts";
import { Manifest } from "../src/schema.ts";

test("a redirect from the application is not followed by the agent's own requests", async () => {
  let elsewhereHits = 0;
  const elsewhere = createServer((_req, res) => {
    elsewhereHits++;
    res.end(JSON.stringify({ sha: "stolen", id: 1 }));
  }).listen(0);
  const target = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/collect`;
  const app = createServer((_req, res) => {
    res.writeHead(307, { location: target });
    res.end();
  }).listen(0);
  const baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const manifest = Manifest.parse({
    baseUrl,
    version: { path: "/version" },
    fixtures: { user: { description: "a user", method: "POST", path: "/users", body: { name: "{{key}}" } } },
  });
  const context = await request.newContext();
  try {
    assert.equal(await deployedSha(context, manifest), undefined);
    await assert.rejects(createFixtures(context, manifest, "S1", { a: "user" }), /HTTP 307/);
    assert.equal(elsewhereHits, 0);
  } finally {
    await context.dispose();
    app.close();
    elsewhere.close();
  }
});
