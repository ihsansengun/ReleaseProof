/**
 * The environment given to every process the engine starts: the browser, the
 * container client and the trusted-side probes. It is an allow-list. Anything
 * not named here, credentials included, is not passed on, so a child process
 * cannot leak what it was never given.
 */
const ALLOWED = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|TMPDIR|DISPLAY|LC_[A-Z]+|XDG_[A-Z_]+|FONTCONFIG_[A-Z_]+|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|PLAYWRIGHT_BROWSERS_PATH)$/;

export function hostEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => ALLOWED.test(entry[0]) && entry[1] !== undefined),
  );
}

/** Names that must never reach a child process or a container, whatever else changes. */
export const PRIVILEGED = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ANTHROPIC|GITHUB|ACTIONS_|JIRA/i;
