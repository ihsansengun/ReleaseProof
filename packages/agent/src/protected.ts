/**
 * Reads the material that decides what counts as a requirement from a
 * revision the pull request cannot change: the application's manifest (for
 * its list of documents), those documents, and the list of requirement
 * owners.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { hostEnv } from "./hostenv.ts";
import { resolveDoc } from "./ingest/context.ts";
import type { Doc } from "./schema.ts";
import { Authority, NO_AUTHORITY } from "./sources.ts";

const run = promisify(execFile);
export const AUTHORITY_FILE = ".releaseproof/authority.yml";
const MANIFEST = "releaseproof.yml";

export type ProtectedMaterial = {
  revision: string;
  authority: Authority;
  approvedDocs: Doc[];
  notices: string[];
};

const docsListed = (manifestText: string | null): string[] => {
  if (manifestText === null) return [];
  try {
    const docs = (parse(manifestText) as { docs?: unknown } | null)?.docs;
    return Array.isArray(docs) ? docs.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
};

function parseAuthority(text: string | null, notices: string[]): Authority {
  if (text === null) {
    notices.push(`No ${AUTHORITY_FILE} exists at the protected revision: no comment and no approval command is authoritative.`);
    return NO_AUTHORITY;
  }
  const parsed = Authority.safeParse(parse(text) ?? {});
  if (!parsed.success) {
    notices.push(`${AUTHORITY_FILE} at the protected revision is not valid and was ignored: no comment and no approval command is authoritative.`);
    return NO_AUTHORITY;
  }
  return parsed.data;
}

/**
 * From a working copy that is itself the protected revision (the CI stage's own
 * copy of the default branch). `appDir` is relative to `root`.
 */
export async function readProtectedCheckout(root: string, appDir: string): Promise<ProtectedMaterial> {
  const notices: string[] = [];
  const revision = (await run("git", ["-C", root, "rev-parse", "HEAD"], { env: hostEnv(process.env) })).stdout.trim();
  const read = (file: string) => readFile(file, "utf8").catch(() => null);
  const authority = parseAuthority(await read(path.join(root, AUTHORITY_FILE)), notices);
  const appRoot = path.join(root, appDir);
  const approvedDocs: Doc[] = [];
  const manifestText = await read(path.join(appRoot, MANIFEST));
  if (manifestText === null) notices.push(`The application has no manifest at the protected revision, so no document is approved yet; the ticket is the only authority.`);
  for (const relative of docsListed(manifestText)) {
    const resolved = await resolveDoc(appRoot, relative);
    if ("refused" in resolved) continue;
    const text = await read(resolved.file);
    if (text !== null) approvedDocs.push({ path: relative, text });
  }
  return { revision, authority, approvedDocs, notices };
}

/**
 * From a git ref in a local repository (command-line use). Returns undefined
 * if the ref cannot be resolved; the caller then has nothing established.
 */
export async function readProtectedRef(manifestFile: string, ref: string): Promise<ProtectedMaterial | undefined> {
  const dir = path.dirname(path.resolve(manifestFile));
  const git = (args: string[]) =>
    run("git", ["-C", dir, ...args], { env: hostEnv(process.env), maxBuffer: 16 * 1024 * 1024 }).then(
      (r) => r.stdout,
      () => null,
    );
  const revision = (await git(["rev-parse", "--verify", `${ref}^{commit}`]))?.trim();
  const top = (await git(["rev-parse", "--show-toplevel"]))?.trim();
  if (!revision || !top) return undefined;
  const appDir = path.relative(top, dir);
  const show = (file: string) => git(["show", `${revision}:${file.split(path.sep).join("/")}`]);
  const notices: string[] = [];
  const authority = parseAuthority(await show(AUTHORITY_FILE), notices);
  const approvedDocs: Doc[] = [];
  const manifestText = await show(path.join(appDir, MANIFEST));
  if (manifestText === null) notices.push(`The application has no manifest at ${ref}, so no document is approved yet; the ticket is the only authority.`);
  for (const relative of docsListed(manifestText)) {
    const file = path.normalize(path.join(appDir, relative));
    if (file.startsWith("..") || path.isAbsolute(file)) continue;
    const text = await show(file);
    if (text !== null) approvedDocs.push({ path: relative, text });
  }
  return { revision, authority, approvedDocs, notices };
}

/** Whether a file is, byte for byte, what the given revision holds at that path. */
export async function sameAsRevision(file: string, revision: string): Promise<boolean> {
  const absolute = path.resolve(file);
  const dir = path.dirname(absolute);
  const top = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"], { env: hostEnv(process.env) }).then(
    (r) => r.stdout.trim(),
    () => null,
  );
  if (!top) return false;
  const relative = path.relative(top, absolute).split(path.sep).join("/");
  const committed = await run("git", ["-C", top, "show", `${revision}:${relative}`], { env: hostEnv(process.env), maxBuffer: 16 * 1024 * 1024 }).then(
    (r) => r.stdout,
    () => null,
  );
  return committed !== null && committed === (await readFile(absolute, "utf8").catch(() => null));
}
