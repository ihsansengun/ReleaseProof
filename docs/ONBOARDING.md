# Onboarding an application

What a team adds to its repository so ReleaseProof can test it. Everything
is configuration beside the application; nothing in the application's own
code changes, and nothing about the application goes into ReleaseProof.

Status: the manifest fields below are implemented and tested. Running from
another repository's workflows is not yet implemented (see the end).

## The manifest: `releaseproof.yml`

In the application's directory, or at the top of the repository.

```yaml
baseUrl: http://localhost:8080      # replaced by the sandbox's address in CI

# Accounts the application already has when it starts. Test credentials of a
# throwaway installation only: this file is readable by everyone who can
# read the repository.
accounts:
  admin:
    description: the administrator every new installation has
    username: admin
    password: admin

start:
  dockerfile: .releaseproof/Dockerfile   # or: run / install / build with the generic Node image
  port: 8080
  env:                                    # never secrets
    DATA_DIR: /data
  writable: [/data]                       # in-memory, 128 MB each, at most 5
  instances: per-scenario                 # or: shared (the default)

docs: [README.md]                         # documents that count as requirements
signIn:
  allow: ["POST /"]                       # requests discovery may send to sign in
```

| Need | How it is met |
|---|---|
| **Which commit is running** | `version: { path }` if the application can report it. If it cannot, leave `version` out: in CI the trusted stage starts the image itself and records that as the basis. The report says which of the two applied. The command line refuses to run without one or the other unless told to skip the check |
| **Accounts** | `accounts`, for applications that ship with users; or `fixtures` with `account: true`, for applications that can create users on request. The model is given a placeholder for the password, never the value |
| **Other test data** | `fixtures`, where the application has an endpoint for it. Otherwise the planner writes a preparation step, and the executor creates the data through the application's interface before the checks. If preparation fails, the scenario is blocked, never failed |
| **Clean state** | `instances: per-scenario` starts a new container for every scenario and every repeat. Nothing carries over, and identifiers the application assigns come out the same on a repeat |
| **A runtime other than Node** | `start.dockerfile`: a Dockerfile of the application's own, built with the manifest's directory as its context |
| **Somewhere to write** | `start.writable`. Everything else is read-only |

## What the Dockerfile may and may not decide

It decides what is installed and how the application starts. It does not
decide how the container runs. Whatever it says, the container is started:

- as user 10001, with a read-only root filesystem, no capabilities and no
  way to gain privileges;
- on a network with no route out, and no route to the machine it runs on;
- with memory, CPU and process limits;
- with only the environment the manifest lists (plus what the image
  defines, which the build put there without access to any secret).

Consequences worth knowing before writing one:

- Do not declare `VOLUME`. A declared volume is storage outside the
  sandbox's control, and the isolation check refuses to run the image. Use
  `start.writable`.
- The application must run as an unprivileged user and listen on a port
  above 1024.
- It must work with no network: assets bundled, no call home at start.
- `HEALTHCHECK` is ignored; readiness is judged by whether the port answers.
- A `LABEL` cannot set the commit; the build stage sets it last.

## The requirement-owner list: `.releaseproof/authority.yml`

Who may state or amend requirements, by GitHub numeric id and Jira account
id. Read from the default branch only. See
[design/REQUIREMENT-AUTHORITY.md](design/REQUIREMENT-AUTHORITY.md).

## Not implemented yet

- **Workflows in another repository.** Today the build and QA workflows run
  in ReleaseProof's own repository against applications inside it. Calling
  them from an application's repository is the next change.
- **Other services.** One container only: no database, cache or mail server
  beside the application.
- **Sign-in other than a form** the executor can fill in.
