# Design: requirement-source authority

Status: **proposed, not implemented.** For review.

## The problem

Today a requirement is "documented" if its quote appears anywhere in one
pooled text: the ticket plus every document the application's manifest
lists (`behaviourSources` in `ingest/context.ts`, checked by `verifyQuotes`
in `analyse.ts`). Three things in that pool are controlled by the pull
request under test:

- the documents themselves, which are read at the pull request's head;
- the manifest's `docs:` list, which decides which files count;
- in CI, the copies of both, shipped by the build stage.

So a pull request can rewrite the README to describe its defect as intended
behaviour and have that text accepted as a documented requirement. In the
adversarial run the model noticed and kept to the ticket. Nothing in the
code made it do so.

The quote check answers "did the model invent this sentence?". It does not
answer "who is allowed to say this?". This design adds the second question
and answers it in code.

## Principle

**Authority comes from where a text was read, never from what it says.**
Code decides the trust level of every source before a model sees anything.
A model can extract and quote; it cannot assign or raise trust.

## 1. Sources and trust levels

Every piece of text that enters a run becomes a **source record**, built by
trusted code:

```
SourceRecord {
  id            "T1", "T2.c3", "D1", "P1" …
  kind          ticket-field | ticket-comment | approved-doc | amendment
                | pr-description | pr-doc-change | pr-diff | application
  trust         authoritative | pr-controlled | unverified
  origin        where it was read: Jira issue id, comment id, author
                account and timestamp; or repository, path and commit
  text, sha256
}
```

| Trust | What qualifies | Can set an expected value |
|---|---|---|
| **authoritative** | (a) A Jira issue's summary and description, fetched by the trusted stage over the authenticated API. (b) Jira comments whose author is a listed requirement owner. (c) A ticket fixture file read from the protected revision. (d) An approved document read from the protected revision. (e) An approved amendment (section 4) | Yes |
| **pr-controlled** | Pull request title and description; any text a pull request adds or changes in a document; the diff, including source comments; everything the running application shows or returns | Never |
| **unverified** | Jira comments by anyone else; local files whose revision cannot be established (CLI use without a base) | Never |

Definitions that make this checkable:

- **Protected revision.** The commit of the default branch that the trusted
  stage itself runs from. In CI this is the QA workflow's own commit, which
  a pull request cannot change. Its hash is recorded in the run. Documents
  are fetched at that commit by the trusted stage, not taken from the build
  stage's hand-off.
- **Approved documents.** The `docs:` list of the application's manifest *at
  the protected revision*. The pull request's own manifest still says how to
  start the application, but it no longer decides which files are
  requirements. A document the pull request adds to the list is
  pr-controlled until it is on the protected branch.
- **Requirement owners.** A new file read only from the protected revision,
  `.releaseproof/authority.yml`: the Jira accounts and GitHub logins allowed
  to state or approve requirements, per application or for the repository.
  It should sit behind branch protection and a code-owner rule; the design
  depends on that file not being editable by the pull request under test,
  which reading it from the protected revision guarantees.
- **Ticket fixtures** (the Jira-format files used today) are authoritative
  only when read from the protected revision. That is already how CI reads
  them. A fixture changed by the pull request is pr-controlled.

Text of a document that the pull request leaves unchanged is identical at
the protected revision, so reading the protected copy loses nothing.

## 2. Enforcement in code

**Requirements.** The analysis schema changes so that the model returns
`sourceId` and `quote` for each requirement and nothing about trust. Then
`verifyQuotes` becomes `attribute`:

1. Look up the source by id. Unknown id: the requirement is inferred.
2. Check the quote against *that source's text only*, not a pool.
3. Copy `trust`, `origin` and the verified quote onto the requirement from
   the source record. The model's opinion of the source is not read.
4. Result: `documented` if the source is authoritative; `claimed` if it is
   pr-controlled or unverified; `inferred` if there is no verifiable quote.

A quote that appears in both an authoritative source and a pr-controlled one
is attributed to the authoritative one. A quote that appears only in
pr-controlled text can never be documented, however it is labelled.

**Assertions.** `validatePlan` already removes assertions that do not cite a
documented requirement. It changes in two ways: the test becomes "cites a
requirement whose trust is authoritative", and each surviving assertion gets
`sourceId`, `trust` and the quote copied onto it by code. The plan, the
recorded steps, `run.json` and the report all carry them, so every
comparison in a report can be traced to an origin without the analysis.

**No promotion path.** The planner receives requirements already attributed.
It has no field in which to state trust, and the validator recomputes
everything it relies on from the source records. In TypeScript the
authoritative form is a distinct type that only `attribute` can construct,
so code that tries to build an assertion from a claimed or inferred
requirement does not compile.

**Prompts** will present authoritative and pr-controlled material in
separate, labelled sections. That helps the model; the guarantees above do
not depend on it.

## 3. Conflict detection

Two layers, because a model's judgement alone is not a guarantee.

**Deterministic (no model):**

- Every change the pull request makes to an approved document is computed
  as a diff against the protected copy and shown in the report under
  "Documentation changed by this pull request", always.
- If an authoritative quote used by any requirement lies in text the pull
  request deletes or rewrites, the report states it: "This pull request
  removes or changes the documented rule: '…'".
- A pull request that changes `.releaseproof/authority.yml` or the manifest's
  `docs:` list is flagged, and the change has no effect on the run.

**Model-assisted, checked in code:**

- The analyst extracts requirement-like statements from pr-controlled
  sources as `claimed` requirements and must relate each one to the
  authoritative requirements: *consistent*, *contradicts Rn*, *adds a rule
  no authoritative source states*, or *removes Rn*.
- Code checks that every claimed requirement has exactly one such verdict
  and that referenced ids exist.
- Contradictions and additions go to a "Conflicts with approved
  requirements" section with both quotes side by side, and become questions
  for the requirement owner.
- Tests run against the authoritative version. A claimed rule with no
  authoritative counterpart produces a blocked scenario, not an expectation.
- **Readiness cannot be "Ready" while a contradiction is unresolved.** With
  no failure it is "Incomplete", so a green Check never coexists with
  documentation that disagrees with the approved requirements.

## 4. Legitimate requirement changes

A product owner can change a requirement in three ways. None involves
editing a test: plans are regenerated when the authoritative sources change.

| Route | How | When it takes effect |
|---|---|---|
| **Jira** (primary) | Edit the ticket, or comment as a listed requirement owner. A later authoritative comment overrides earlier text, as today | Next run. The run fingerprint covers all authoritative sources, so a change forces a fresh plan |
| **Approve a documentation change in the pull request** | A listed requirement owner posts a comment on the pull request: `/releaseproof approve-requirements <commit>` | Next run of that commit. The changed document text becomes an authoritative *amendment*, recorded with approver, commit and the hash of the approved text |
| **Merge** | The documentation change reaches the protected branch through normal review | Every later run |

Rules for the approval command:

- It is read by the trusted stage through the GitHub API; the author is
  checked against `authority.yml` at the protected revision.
- It is bound to a commit and to the hash of the document changes at that
  commit. A new commit that alters those changes voids it; unrelated commits
  do not.
- It can be withdrawn with `/releaseproof revoke-requirements`.
- The report names the approver and links the comment wherever an amendment
  is the source of a requirement.

Why a command and not a GitHub review approval: approving a code review does
not mean "I, as product owner, change the requirement". The command is an
explicit act by a named person, and it can be audited.

`ticketHash` becomes a fingerprint of all authoritative sources (ticket,
approved documents, amendments), so re-runs replay an old plan only when
none of them changed.

## 5. Failing safely

- An assertion without an authoritative requirement is removed; a scenario
  left with none is blocked with the reason "no approved requirement states
  the expected outcome", and the gap becomes a question. Other scenarios run
  as normal. This is the existing mechanism with a stricter test.
- If Jira cannot be reached or authenticated, or the ticket named by the
  pull request does not exist, the run reports that and tests nothing. It
  does not fall back to pull-request text.
- If the protected revision has no approved documents (a new application),
  the ticket is the only authority. That is valid, and the report says so.
- If `authority.yml` is missing, no comment and no approval command is
  authoritative; the ticket body and protected documents still are.
- Each requirement in the report shows its source and trust level. A
  separate section lists what the pull request claimed and was not used.

## 6. What changes, and what does not

Unchanged: the three CI stages and their permissions, the manifest format,
the CLI commands, the executor, verdict computation, the report stage's
validation. The engine stays application-agnostic: nothing here knows about
any domain, only about where text came from.

| Area | Change |
|---|---|
| `src/sources.ts` (new) | Build source records; classify trust; diff head documents against the protected copy; read amendments |
| `src/ingest/jira.ts` | Keep issue id, comment ids, author account ids, timestamps |
| `src/ingest/github.ts` | Read a file at a given commit; read pull request comments with authors |
| `src/ingest/context.ts` | `RunContext` carries source records instead of a pooled text |
| `src/schema.ts` | `SourceRecord`; requirement gains `sourceId`, `trust`, `origin`, kind `claimed`; assertion gains `sourceId`, `trust`, `quote`; analysis gains `conflicts` |
| `src/analyse.ts` | `attribute` replaces `verifyQuotes`; prompt sections by trust |
| `src/validate.ts` | Authoritative-only assertions; provenance copied on; conflict verdicts checked |
| `src/pipeline.ts` | Fingerprint over authoritative sources |
| `src/report/*`, `src/ci/report.ts` | Source and trust per requirement; conflicts; documentation changes; claims not used; readiness rule |
| `src/ci/run.ts` | Fetch approved documents, the base manifest and `authority.yml` at the protected revision |
| CLI | `--base-ref` (default: merge base with the default branch). Without a resolvable base, local documents are *unverified* and the report says so; `--trust-local-docs` makes them authoritative explicitly and is recorded in the report |
| Workflows | None for the default route. Live Jira needs a `JIRA_API_TOKEN` secret in the QA step, handled like the model key (read once, removed from the environment, never passed to a child process) |

## 7. Regression tests

Unit tests with crafted inputs and a stub model that returns whatever the
attacker wants, so the tests exercise the code's guarantees rather than a
model's good sense:

1. **Modified README.** The pull request rewrites a rule in an approved
   document. The model returns the new sentence as documented, citing the
   document. Expect: attributed as `claimed`; no assertion survives on it;
   the deterministic diff and the "changes a documented rule" notice appear.
2. **Forged acceptance criteria.** The pull request description contains a
   block formatted exactly like the ticket's criteria. The model cites the
   ticket's source id with the forged quote. Expect: quote not found in that
   source, requirement downgraded.
3. **Misleading Jira-style content.** (a) A Jira comment by a non-owner says
   the criteria changed. (b) The application displays text styled as a
   ticket. (c) A file named like a ticket fixture is added by the pull
   request. Expect: none authoritative; (a) is listed as unverified.
4. **Malicious pull request description.** Instructions to drop criteria
   and report success. Expect: no change to the authoritative requirement
   set, compared with the same run without the description.
5. **Conflicting documentation.** Pull-request text contradicts a ticket
   rule. Expect: conflict recorded with both quotes; the scenario asserts
   the ticket's value; readiness is not "Ready".
6. **Trust cannot be raised.** The model output claims trust, or cites an
   authoritative id for text that exists only in a pr-controlled source.
   Expect: ignored, and attributed by where the text was found.
7. **Manifest and authority tampering.** The pull request adds a file to
   `docs:` or edits `authority.yml` to add itself. Expect: no effect, flagged.
8. **Approval.** A command by an owner at the head commit makes the change
   authoritative; by a non-owner, for another commit, or after the document
   changed again, it does not.
9. **Fail safe.** No authoritative source for one behaviour: that scenario
   is blocked, the others execute. Jira unreachable: nothing is tested.
10. **Fingerprint.** Changing an authoritative source forces a fresh plan;
    changing pr-controlled text does not change the requirement set.

Then, as already agreed and not part of this change: one blind
prompt-injection run with a controlled budget.

## 8. What this does not guarantee

- **That conflicts are always found.** Pairing a claim with the rule it
  contradicts is a model's judgement. The deterministic layer guarantees
  the documentation change is always shown and never adopted; it does not
  guarantee a subtle contradiction is labelled as one.
- **That an assertion's expected value is right.** Code guarantees the
  assertion cites an authoritative requirement and shows the quote beside
  the value. A model can still attach a wrong number to a real rule. The
  report makes that visible; it does not prevent it.
- **Anything about the ticket's own quality or Jira's permissions.** Whoever
  may edit the issue in Jira may change the requirement. A compromised
  owner account can approve anything.
- **Fixture tickets as a long-term source.** They are authoritative only
  because they sit on the protected branch. Live Jira is the intended
  source and has not yet been exercised.

## 9. Decisions for you

1. **Approving a documentation change inside a pull request.** Recommended:
   support Jira and the explicit comment command. Alternative: Jira only,
   which is simpler but means every documentation-led change needs a ticket
   edit first.
2. **Jira comments.** Recommended: authoritative only from listed owners;
   everyone else's comments are shown as unverified. Alternative: any
   comment on the ticket counts, as today, relying on Jira's permissions.
3. **Unresolved contradiction.** Recommended: readiness is at best
   "Incomplete" (neutral Check). Alternative: "Not ready" (red Check), which
   is stricter but blocks a pull request whose only issue is an unapproved
   documentation edit.
4. **CLI without a resolvable base.** Recommended: local documents are
   unverified unless `--trust-local-docs` is passed. Alternative: trust
   local files by default for developer convenience.
5. **Where owners are listed.** Recommended: `.releaseproof/authority.yml` on
   the protected branch. Alternative: GitHub teams or Jira project roles
   looked up at run time, which is less to maintain but needs wider token
   permissions.

## 10. Order of work, once approved

1. Source records, attribution, validator, fingerprint, with tests 1 to 7,
   9 and 10. No behaviour change for a pull request that touches no
   document.
2. Reports: provenance, conflicts, documentation changes, readiness rule.
3. Protected-revision reads in CI and `--base-ref` in the CLI.
4. Approval command, with test 8.
5. Live Jira with author identities (needs a Jira site and token).
6. The blind injection run.
