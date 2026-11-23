# Design: the network checkpoint

Status: **built as a part by itself (`packages/agent/src/remote/checkpoint.ts`) and used by nothing.** No run
and no check goes through it yet. Trusted verdicts stay disabled. The research behind it is in
`docs/research/rpai-33-network-boundary/`.

## Why

The check runner decides what a page did from what the browser tells it. Three review rounds showed that this
has no end: each rule about which document sent what rested on the order or the completeness of the browser's
reports, and the reports are neither ordered across channels nor complete (requests of a popup, of a service
worker, of a socket, and everything sent as a page is left are not told of on a page's session).

The owner's decision of 23 November 2026 is to stop inferring and to own the path instead:

- The engine holds every request of the page before it is sent and decides while it is held.
- The only way from the browser to the application is a proxy of the engine's own, which forwards what the
  engine released and nothing else.

This note is about the second part.

## The threat model it serves (owner's decision, 23 November 2026)

1. **Against a hostile application** the engine protects its own boundaries, its evidence and the integrity
   of its result. Acts stay bound to the authorised origin and document.
2. **For an honest application**, however it is built, a verdict reflects what could be observed of the
   approved journey.

ReleaseProof does not claim to establish the truth of data that a malicious application deliberately
falsifies.

## What the checkpoint does

One rule: **nothing reaches the application unless the engine released it.**

- A checkpoint is opened for one check, with the list of origins that check may reach (at most eight).
- It makes a **mark** (32 random bytes) and a **key** (P-256), both held in memory only, for that checkpoint
  alone.
- The engine attaches the mark, in the header `x-releaseproof-released`, to each request it lets go. The
  checkpoint forwards a request only if it bears exactly the mark (compared in constant time, given once) and
  is for an origin on the list; it removes the mark first. The application never sees it.
- Everything else is refused (403) and noted: a request without the mark, for another origin, for a socket
  (`Upgrade`), or one that names one origin and asks another.
- For an `https` origin the checkpoint ends the browser's connection with a certificate it makes itself for
  that one name under its key, and opens its own connection to the application, **whose certificate it
  verifies itself** against the system's authorities. A site that does not verify is not spoken to (502).
- The browser is to trust the key by its pin (`keyPin`, for `--ignore-certificate-errors-spki-list`) and
  nothing else. There is no authority certificate: nothing exists that could sign for another key, and nothing
  is put in any trust store.
- Answers, redirects included, are handed back as they are. The checkpoint follows nothing.
- Closing it ends every connection and forgets the key and the mark.

## What it keeps

For each request: how it was dealt with (one of a fixed list), the method, the origin, the path **without its
query**, and whether there was a query. Nothing else: no query, header, cookie, body, password or token is
kept, written or logged. The module writes no file and prints nothing; a test holds that.

The checkpoint does see everything the page sends and receives in clear while it passes. That is what ending
the connection means. By the owner's decision it is approved **for controlled testing with dedicated
synthetic accounts and test data only**; real customer credentials and sensitive production information are
not to pass through it at this stage.

## What it is not

- **Not the whole boundary.** A browser can send what goes through no proxy: measured, a page made the browser
  send UDP packets by WebRTC straight to an address of its choosing, and the browser's own settings did not
  stop it. That is closed by the operating system (a network namespace whose only way out is the checkpoint),
  which is the next part, and by the owner's rule a check refuses to run if the browser cannot be isolated.
- **Not a judge of which request is the intended one.** It forwards what bears the mark. Which request the
  engine releases, and how it tells the intended act's request from another, is decided where the requests
  are held, and is a later part with its own review.
- **Not for sockets.** An `Upgrade` is refused. Applications that need one cannot be checked through it yet.
- **Not HTTP/2 towards the browser.** It speaks HTTP/1.1 to the browser.

## Limits to know about

- **Where a name is** is asked of the system's resolver by the checkpoint. A name on the list that resolves to
  an address inside the worker's own network would be reached. The worker's network rules stand against that,
  not the checkpoint.
- **The mark is as secret as the engine keeps it.** It is sent only on the loopback connection to the
  checkpoint and stripped there. Script of a page does not see request headers the engine adds while a request
  is held (measured in the research). If it ever leaked to a page, that page could have its own requests
  forwarded; they would still be for a listed origin only.
- **A request the engine marks for an origin that is not on the list** is refused before any connection, so
  the mark is not sent there. The engine is to mark only requests for listed origins all the same.
- **One browser build** was used for the browser tests.
- **No measurement of speed** beyond the tests passing.

## Stages

| Part | What | State |
|---|---|---|
| a | This checkpoint, by itself | built, used by nothing |
| b | A browser that cannot go round it; a check refuses to run otherwise | not started |
| c | The check runner holds every request, decides, and uses a and b; leave-time by what is observed; how the intended act's request is told from another | not started |

Each part is merged only after independent security review, passing tests and the owner's approval. The
existing restrictions of the runner stay as they are until c is built and reviewed.
