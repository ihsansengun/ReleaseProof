import { readFile } from "node:fs/promises";
import type { APIRequestContext } from "playwright";
import { parse } from "yaml";
import { Manifest } from "./schema.ts";

export async function loadManifest(file: string, baseUrlOverride?: string): Promise<Manifest> {
  const raw = parse(await readFile(file, "utf8"));
  return Manifest.parse(baseUrlOverride ? { ...raw, baseUrl: baseUrlOverride } : raw);
}

/** Which commit the environment says it is running, if it says. */
export async function deployedSha(request: APIRequestContext, manifest: Manifest): Promise<string | undefined> {
  if (!manifest.version) return undefined;
  const response = await request.get(new URL(manifest.version.path, manifest.baseUrl).toString());
  if (!response.ok()) return undefined;
  const body = (await response.json().catch(() => null)) as { sha?: unknown } | null;
  return typeof body?.sha === "string" ? body.sha : undefined;
}

/** Substitutes "{{key}}" in every string of a JSON-like value. */
export function fillTemplate(value: unknown, key: string): unknown {
  if (typeof value === "string") return value.replaceAll("{{key}}", key);
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, key)]));
  }
  return value;
}

/**
 * Creates the scenario's fixtures through the endpoints the manifest declares.
 * The key is derived from scenario and alias only, so a later replay gets the
 * same identities.
 */
export async function createFixtures(
  request: APIRequestContext,
  manifest: Manifest,
  scenarioId: string,
  wanted: Record<string, string>,
): Promise<Record<string, unknown>> {
  const created: Record<string, unknown> = {};
  for (const [alias, type] of Object.entries(wanted)) {
    const fixture = manifest.fixtures[type];
    if (!fixture) throw new Error(`The environment manifest declares no "${type}" fixture.`);
    const response = await request.fetch(new URL(fixture.path, manifest.baseUrl).toString(), {
      method: fixture.method,
      data: fillTemplate(fixture.body, `${scenarioId}-${alias}`.toLowerCase()) as object | undefined,
    });
    if (!response.ok()) {
      throw new Error(`Fixture "${type}" failed with HTTP ${response.status()} at ${fixture.path}.`);
    }
    created[alias] = await response.json();
  }
  return created;
}
