import { resolveDoc } from "../ingest/context.ts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadManifest } from "../env.ts";
import { loadPullRequest } from "../ingest/github.ts";
import { buildImage, IMAGE } from "./sandbox.ts";

const run = promisify(execFile);
const MANIFEST = "releaseproof.yml";

/** The application directories (those holding a manifest) that a set of changed files belongs to. */
export function appsTouched(changed: string[], hasManifest: (dir: string) => boolean): string[] {
  const apps = new Set<string>();
  for (const file of changed) {
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
      if (hasManifest(dir)) {
        apps.add(dir);
        break;
      }
      if (dir === "." || dir === "/") break;
    }
  }
  return [...apps].sort();
}

export type BuildMeta = { pr: number; headSha: string; appDir?: string; skip?: string };

/**
 * The build: the only place pull-request code is touched, and only inside
 * `docker build`. It runs with no secrets. It is run by trusted code, which
 * first establishes that the files in front of it are exactly the commit the
 * code host reports for the pull request, so that the commit label it puts
 * on the image is a statement by this code and not by the pull request.
 *
 * It hands on the image, the manifest with the documents it lists, and a
 * small description of what was built.
 */
export async function ciBuild(options: {
  prDir: string;
  repo: string;
  pr: number;
  outDir: string;
  dockerfile: string;
}): Promise<BuildMeta> {
  const { prDir, outDir } = options;
  await mkdir(path.join(outDir, "context"), { recursive: true });
  const headSha = (await run("git", ["-C", prDir, "rev-parse", "HEAD"])).stdout.trim();
  const meta: BuildMeta = { pr: options.pr, headSha };
  const done = async (skip?: string) => {
    if (skip) meta.skip = skip;
    await writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  };

  const pullRequest = await loadPullRequest(options.repo, options.pr);
  if (pullRequest.headSha !== headSha) {
    return done(`The files to build are at commit ${headSha.slice(0, 12)}, which is not the commit the code host reports for pull request #${options.pr}. Nothing was built.`);
  }
  if (pullRequest.headRepo !== options.repo) {
    return done("Pull requests from forks need a maintainer's go-ahead, which is not implemented yet.");
  }
  const apps = appsTouched(
    pullRequest.files.map((f) => f.path),
    (dir) => existsSync(path.join(prDir, dir, MANIFEST)),
  );
  if (apps.length === 0) return done("The pull request changes no application that has a releaseproof.yml manifest.");
  if (apps.length > 1) return done(`The pull request changes more than one application (${apps.join(", ")}); one at a time is supported.`);
  const appDir = apps[0]!;
  meta.appDir = appDir;

  const manifestFile = path.join(prDir, appDir, MANIFEST);
  if ("refused" in (await resolveDoc(path.join(prDir, appDir), MANIFEST))) {
    return done(`The manifest of ${appDir} is not a regular file.`);
  }
  const manifest = await loadManifest(manifestFile).catch((error: Error) => error);
  if (manifest instanceof Error) return done(`The manifest of ${appDir} is not valid: ${manifest.message.split("\n")[0]}`);
  if (!manifest.start) return done(`The manifest of ${appDir} has no "start" section, so the application cannot be started in CI.`);

  // An application may bring its own Dockerfile. It is pull-request content
  // like any other: it must be a regular file inside the application
  // directory, and it only ever runs inside the build.
  let dockerfile = options.dockerfile;
  let contextDir = prDir;
  if (manifest.start.dockerfile) {
    const own = await resolveDoc(path.join(prDir, appDir), manifest.start.dockerfile);
    if ("refused" in own) return done(`The Dockerfile the manifest of ${appDir} names is ${own.refused}.`);
    dockerfile = own.file;
    contextDir = path.resolve(prDir, appDir);
  }
  await buildImage({ contextDir, dockerfile, start: manifest.start, sha: headSha });
  await run("docker", ["save", "--output", path.join(outDir, "image.tar"), IMAGE], { timeout: 10 * 60_000 });

  // The manifest and the documents it lists travel as plain files.
  const root = path.resolve(prDir, appDir);
  await copyFile(manifestFile, path.join(outDir, "context", MANIFEST));
  for (const relative of manifest.docs) {
    // Symbolic links are refused: one could point at a file on this runner.
    const resolved = await resolveDoc(root, relative);
    if ("refused" in resolved) continue;
    const source = resolved.file;
    const target = path.join(outDir, "context", relative);
    if (!path.resolve(target).startsWith(path.resolve(outDir, "context") + path.sep)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return done();
}
