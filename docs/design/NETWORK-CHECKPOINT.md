# Design: the network checkpoint

Status: **built as a part by itself (`packages/agent/src/remote/checkpoint.ts`) and used by nothing.** No run
and no check goes through it yet. (A test would notice an ordinary use of it. That test is a tripwire against
wiring it in by accident, not a lock against doing so on purpose.) Trusted verdicts stay disabled. The research behind it is in
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
- Everything else is refused and counted: a request without the mark, for another origin, for a socket
  (`Upgrade`), or one that names one origin and asks another. What is not a request at all (bytes the
  reader of requests rejects) ends its connection with nothing said and is not counted.
- A released request whose `Connection` header names its own length, its encoding or its addressee for
  removal is refused: sent on without its length, its body would be read by the application as a second
  request that nobody released. (A browser does not let a page set that header; whoever holds the mark could.)
- For an `https` origin the checkpoint ends the browser's connection with a certificate it makes itself for
  that one name under its key, and opens its own connection to the application, **whose certificate it
  verifies itself** against the authorities Node trusts (its own list, and any added through
  `NODE_EXTRA_CA_CERTS`; not the operating system's store). A site that does not verify is not spoken to (502).
- The browser is told to accept the key by its pin (`keyPin`, for `--ignore-certificate-errors-spki-list`).
  There is no authority certificate: nothing exists that could sign for another key, and nothing is put in any
  trust store. Two things this does not say: under the pin the browser accepts any certificate with that key,
  whatever name is on it (the key is the checkpoint's alone, so the name adds nothing); and the browser still
  trusts the public authorities it always trusts, which matters only if it can reach something other than the
  checkpoint, and that is the next part's business.
- Answers, redirects included, are handed back. The checkpoint follows nothing. Requests and answers are
  written out again on the way, so the spelling of header names, the framing of bodies and, for an http
  origin, a path the address rules normalise can differ from what was sent; what is said in them does not. An answer that is
  not a final answer (a status outside 200 to 599, a change of protocol, nothing at all within the time) is a
  failure: the browser gets 502.
- A request is counted as **forwarded from the moment the connection to the application stands** (verified,
  for https), because from then the application may have acted on it, whatever it answers or does not.
- Closing it ends every connection, the application's side included, and lets go of the mark and of what the
  browser's connections are ended with. Nothing is counted afterwards.
- It listens on the loopback address only, or on a socket path that only its owner may use. A connection of
  the browser's lasts ten minutes at most and there are 256 at most.

## What it keeps

In memory, and nowhere else:

- **Counts** of how requests were dealt with, by outcome (a fixed list). These always go on.
- **Notes**, one per request, up to 2,000: the outcome, the method, the origin, the path **without its query**
  (at most 512 characters), and whether there was a query. The origin is one from the list or the word
  `other`: a name that is not on the list is the asker's text and is not kept.

No query, header, cookie or body is kept. The module writes no file and prints nothing; tests hold that, by
its text and by running it in a process of its own.

What is kept is copied out of the request, so that the rest of the request is let go: a test looks through
everything a process holds after requests have passed and finds their paths and none of their queries or
cookies. At most 2,000 notes of at most 512 characters of path: about a megabyte of text (measured: two to
three megabytes of memory under a flood of 30,000 long addresses, and no growth beyond that).

**A path is kept, and a path can carry something secret** (a link to reset a password, a session in the
address). It is also text a page chose. The checkpoint never writes or prints one.

**Gate before activation (owner's decision, 23 November 2026):** paths from these notes must be made safe
before they reach any report a customer sees or any log that is kept. That is to be done in the part that
uses the checkpoint, and is mandatory before trusted verdicts are activated. It is not enforced here.

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
- **Not for an address in place of a name over https**, nor for an address in brackets or a name with a
  trailing dot. Over http a plain address is served, as tests and local applications have.

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
- **The mark is one value for the whole check**, not tied to a method or an address. Which requests get it
  is the engine's decision, made where they are held.
- **A hostile application can waste a check**, not falsify it: it can fail to answer, answer slowly a byte
  at a time (the time limit is on silence, before an answer and in the middle of one, not on the whole
  answer), keep sending answers that are not final ones, or send bodies of any size. A connection of the
  browser's ends after ten minutes whatever is said on it.
- **One connection to the application for each request**; none is kept for the next.
- **The oldest version of TLS spoken** is 1.2, by this code and by Node's own default.
- **Notes are in the order requests were dealt with**, not the order they were sent; and a request the
  browser gave up on after it was sent is counted as forwarded and as failed.
- **Answers before the final one** (a status in the 100s) are not passed on.
- **Anything on the machine that can reach the loopback address** can ask the checkpoint, fill its notes
  (the counts go on) and use up its 256 connections for as long as it keeps them, which keeps the browser
  out: a check that cannot run, not a wrong result. It cannot have anything forwarded without the mark.
- **Known and not yet put right** (found by the third review, 24 November 2026; none lets anything through
  that was not released, and none is a wrong count of what reached the application):
  - *The silence limit in the middle of an answer also runs while the browser is the one not reading.* A
    browser that stops reading a large answer for the whole time (30 seconds) loses the rest of it, and that
    cut is not counted as a failure. Not seen with a real browser.
  - *An https application that accepts a connection and never completes TLS* fails, and is counted, but
    the browser's connection is ended with nothing said, not with 502, after twice the time.
  - *An answer with a `Transfer-Encoding` other than `chunked`* is handed to the browser as it came, on a
    connection that is then kept. The browser tested read it to the end without confusion; another reader
    might not.
  - *A request with an `Expect` Node does not know* is answered 417 by Node and not counted. Nothing of it
    reaches the application.
  These are to be put right, with tests, before the checkpoint is used by a check (the third part).
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
