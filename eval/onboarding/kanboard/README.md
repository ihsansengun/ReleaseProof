# Kanboard onboarding spike, 19 November 2026

A check, with no model and at no cost, of whether an application that was not
written for ReleaseProof can run under the sandbox's restrictions without
changes. Kanboard is an open-source project management application (PHP,
SQLite, MIT licence), developed by people unconnected to this project.

Nothing here uses ReleaseProof's engine. It is the evidence the onboarding
work is based on, kept so it can be repeated.

- Source: `kanboard/kanboard` at commit
  `51d6e6f72d3f967ecbcbfff8ed38012613bb96ea`, copied into the image unchanged.
- Where: a local Docker container. No GitHub Actions run, no paid run.
- Test data: synthetic only. The one account used that was not created by
  the walk-through is Kanboard's public default (`admin` / `admin`), which
  exists in every fresh installation and here lives in a throwaway container.

## Files

| File | What it is |
|---|---|
| `Dockerfile.releaseproof` | Draft of the test image an onboarding would add. **Not yet built**: the Alpine package mirror was not reachable from the environment the spike ran in |
| `Dockerfile.local` | The variant that was built and run. It takes the upstream `kanboard/kanboard` image only for its PHP runtime (PHP 8.5.12 with the extensions Kanboard checks for) and copies the pinned source over it |
| `browse.cjs` | The browser walk-through (Playwright, headless Chromium) |
| `run.sh` | Builds, starts with the restrictions below, runs the walk-through, removes the container and network |

To repeat it:

    git clone https://github.com/kanboard/kanboard && git -C kanboard checkout 51d6e6f72d3f967ecbcbfff8ed38012613bb96ea
    ./run.sh kanboard Dockerfile.local

## Restrictions the container ran under

    --network <internal network, no published ports>
    --read-only
    --tmpfs /tmp:rw,size=64m,mode=1777
    --tmpfs /data:rw,size=64m,uid=10001,gid=10001,mode=0700
    --cap-drop ALL --security-opt no-new-privileges --user 10001:10001
    --pids-limit 256 --memory 512m --cpus 1
    -e DATA_DIR=/data -e LOG_DRIVER=stderr

These were applied by hand to match `packages/agent/src/ci/sandbox.ts`. Two
differences from the real sandbox: the firewall rule that blocks the host
from the sandbox network was not in place, and the trusted-side isolation
check was not run.

## Results

| Check | Result |
|---|---|
| Start-up | Ready in under a second. `healthcheck.php` returns 200. The first page request creates the database in 0.39 s |
| Authentication | The default account signs in. A wrong password shows "Bad username or password". The sign-in form carries a CSRF token |
| Persistence | A project, a task and a second user created through the interface were present in a new browser session |
| Navigation | Dashboard, project, board with its four default columns, task dialog and user list load in headless Chromium |
| A permission rule | The second user received 403 on the first user's private project |
| Offline | No request left the application's address; no failed request; no page error |
| From inside the container | Writes to `/app` and `/` refused (read-only); no name resolution; no route out; seven environment variables (two set for the test, five from the image and shell), none a credential |
| Fresh state | A new container starts empty, and identifiers come out the same every time (project 1, user 2) |
| Size | Image 164 MB; 22 MB of memory in use; one process |

## The two questions

**Does it need a version endpoint?** No, and it has none. Kanboard reports a
release name, not a commit. ReleaseProof therefore has to establish which
commit is running from the build it controls, not by asking the application.

**Does it need test-data endpoints?** No. The default account plus set-up
through the interface was enough to create users, projects and tasks. A new
container per scenario gives each scenario a clean, repeatable state.

## Changes needed to onboard

- **Application code: none.**
- **Configuration:** `DATA_DIR=/data` (moves the database to a writable
  mount) and `LOG_DRIVER=stderr`, both settings Kanboard already reads from
  the environment. PHP's built-in web server is used in place of the
  upstream image's nginx and process supervisor, which run as root.
- **Files an onboarding adds, beside the application:** one test Dockerfile
  of about 12 lines, a manifest, the requirement-owner list and two workflow
  files. Only the Dockerfile was drafted here.

Effort: about 10 minutes from the first build attempt to a complete
walk-through, after reading the source. Most of it went on the network
limits of the environment, not on Kanboard.

## What it showed about testing this application

- **Forms open as dialogs.** A form's Save button is added by script when the
  form is opened from its link. Opening the form's address directly gives a
  form with no button. A tester has to navigate as a user does.
- **Sign-in lockout.** A captcha appears after 3 failed sign-ins and the
  account locks after 6, for 15 minutes. A new container per scenario avoids
  carrying this between scenarios.
- **One request at a time.** PHP's built-in server handles requests
  serially, which is enough for one browser.
- **The image's own health check does not apply.** The upstream image
  declares a health check against port 80; with the built-in server on 8080
  Docker reports the container as never healthy. Readiness has to be judged
  by the caller.

## Limits of this spike

- `Dockerfile.releaseproof` is unbuilt. It is expected to build on a GitHub
  runner; that is not verified.
- The host firewall rule and the trusted-side isolation check were not
  exercised. From inside the container the host's bridge address answered
  "connection refused" on port 22, where the real sandbox drops the packet.
- One pass, one commit, one happy path. It says the application can run and
  be driven; it says nothing yet about how well ReleaseProof tests it.
