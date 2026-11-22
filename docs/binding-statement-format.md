# The binding-approval statement and the hash of a set

Status: **implemented, and used by no run.** Stage 3 of RPAI-33; the design
is `docs/design/TRUSTED-BINDING.md`. Code: `packages/agent/src/remote/binding.ts`.
A remote run reports `verdictsTrusted: false` exactly as before, and nothing
in this document changes what a run does or reports.

This is the exact form two implementations must agree on: the engine, which
verifies, and whatever signs.

## What is checked at this stage, and what is not

Checked: that the control plane signed, for this run and this revision of
the criteria, exactly the set of bindings presented; and the rules about a
binding that need neither the criteria text nor a browser.

Not checked yet: where a binding's quote lies in the text, that an expected
value is the number written at its position, bounds and negations in the
quote, and everything about carrying a check out. Those come with the stage
that carries checks out. What this stage returns is a *signed set*, not a
verified check.

## The statement

A second kind of signed statement beside the criteria approval. Signed with
Ed25519 over these lines, joined by a line feed, in this sequence:

```
releaseproof-binding-approval-v1
bindingApprovalVersion        1
keyId
workspaceId
projectId
runId
targetOrigin                  as an origin: scheme and host
scopeSha256                   of the request, as in a criteria approval
snapshotId
snapshotSha256
bindingFormatVersion          1
bindingCount                  1 to 200
bindingsSha256
approvedBy
approvedAt
issuedAt
expiresAt
```

Every field is non-empty and holds no line break. The signature is 64 bytes
in base64url without padding, in its one canonical spelling.

The first line differs from a criteria approval's
(`releaseproof-criteria-approval-v1`), so neither can verify as the other,
with the same key or another. Each kind is also a strict object with its own
fields, and travels in its own list.

## How it is carried

Beside the criteria approvals, never among them:

```
{ "statements": [ statement, ... ],   at most 40
  "bindings":   [ binding, ... ] }    at most 200
```

- A run handed none has no signed set, and is what it is today.
- Evidence that is present and wrong in any respect is refused whole, with
  every reason. A statement that does not fit is never passed over in favour
  of one that does.

## When a statement is believed

All of:

- It parses, names a trusted key, and its signature verifies.
- Its run, workspace, project and target origin are the request's, and its
  `scopeSha256` is the request's.
- Its snapshot is one the run carries, whose own approval verified, at
  exactly that hash.
- It has not expired, is not dated more than five minutes ahead, expires
  after it was issued, was issued no earlier than the approval it states,
  and is valid for at most 24 hours.
- It is the only statement for its snapshot.
- The bindings presented for its snapshot are `bindingCount` in number and
  hash to `bindingsSha256`.

And of the bindings: each parses; none has a problem listed below; no two in
the run share an id; each is for a snapshot a statement covers, at the
statement's revision.

Replay is refused by scope: a statement names its run and the run's scope
hash, and a run starts once (the existing ledger).

## A binding

A strict object: an unknown field is a refusal.

| Field | Form |
|---|---|
| `formatVersion` | `1` |
| `id` | plain name: letters, digits, `-`, `_`; at most 64 |
| `snapshotId`, `snapshotSha256` | the snapshot and its revision |
| `quote` | `{ start, end }`, UTF-16 code units into the snapshot's text |
| `locale`, `timezone` | a language tag; a time zone name |
| `background` | up to 20 of `{ method, path }` |
| `tolerated` | up to 20 of `{ method, path, status }`, status 400 to 599 |
| `settling` | `{ within, readings }`: 1 to 120 seconds; 3 to 10 readings |
| `setup` | `{ kind: "fresh-browser" }` or `{ kind: "fixture", method, path, body }` |
| `steps` | 1 to 60 of the steps below |
| `observation` | a reading |
| `expected` | `{ start, end, value }`, offsets into the quote |

A reading is `{ path, locator, valueKind, unit }`. A locator is
`{ by: "testid", value }` or `{ by: "role", role, name }`. `valueKind` is
`number` or `amount`. A path begins with `/` and has no query, fragment or
space. A number is text in plain decimal form: optional minus, no leading
zeros, optional fraction.

Steps:

| `kind` | Fields |
|---|---|
| `open` | `path` |
| `fill` | `path`, `locator`, `value`: `{ from: "literal", text }` or `{ from: "fixture", field }` |
| `act` | `path`, `locator`, `expects`: `{ write: "one", method, path }` or `{ write: "none" }` |
| `see` | `reading`, `expected`: `{ from: "quote", start, end, value }` or `{ from: "literal", value }` |

Refused at this stage, whatever is signed:

- text anywhere in it that is not in Unicode NFC;
- no `see` step (condition binding is mandatory);
- a fixture body without `{{key}}`;
- an `act` that expects a write also listed in `background`;
- a `fill` from a fixture in a check that has none;
- a quote longer than 600 code units, or an expected value outside it.

## The hash of a set

`bindingsSha256` is the SHA-256, in lowercase hexadecimal, of the UTF-8 bytes
of `JSON.stringify` of:

```
[ "releaseproof-bindings-v1", [ B, B, ... ] ]
```

with the bindings sorted by `id` in UTF-16 code-unit sequence, ids unique,
and each binding `B` written as this list, in this sequence:

```
[ formatVersion,
  id,
  snapshotId,
  snapshotSha256,
  [ quote.start, quote.end ],
  locale,
  timezone,
  [ [ method, path ], ... ],                    background, as given
  [ [ method, path, status ], ... ],            tolerated, as given
  [ settling.within, settling.readings ],
  SETUP,
  [ STEP, ... ],                                as given
  READING,                                      the observation
  [ expected.start, expected.end, expected.value ] ]
```

```
SETUP     [ "fresh-browser" ]
          [ "fixture", method, path, body ]
READING   [ path, LOCATOR, valueKind, unit ]
LOCATOR   [ "testid", value ]
          [ "role", role, name ]
STEP      [ "open", path ]
          [ "fill", path, LOCATOR, [ "literal", text ] ]
          [ "fill", path, LOCATOR, [ "fixture", field ] ]
          [ "act", path, LOCATOR, [ "one", method, path ] ]
          [ "act", path, LOCATOR, [ "none" ] ]
          [ "see", READING, [ "quote", start, end, value ] ]
          [ "see", READING, [ "literal", value ] ]
```

Positions, counts, statuses and the two settling numbers are JSON numbers and
whole. Every other number is text. Nothing is normalised: text is hashed as
written, and text not in NFC is refused, never converted.

The hash of one binding, by which a result will name it, is the SHA-256 of
`JSON.stringify([ "releaseproof-binding-v1", B ])`.

Changing any of this changes `bindingFormatVersion`. A test holds two
vectors (one binding and one set) and fails if the form drifts.
