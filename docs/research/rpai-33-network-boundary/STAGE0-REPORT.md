# RPAI-33 Stage 0: feasibility of an engine-owned network boundary

23 November 2026. Isolated experiments only; no engine code changed; trusted verdicts remain disabled.
Environment: Chromium 157 (headless, Playwright 1.63), Next.js 16.4.6 shop from `apps/shop` (production build, `TEST_MODE=1`), plain-`http` targets on loopback. Scripts: `stage0/` (`e1-hold`, `e1b-policy`, `e2-coverage`, `e3-leave`, `e4-listeners`, `e5-shop`, `e6-pass`).

## 1. Findings

**F1. A navigation can be held while the engine acts.** With every request paused by the engine (CDP `Fetch`), a main-frame document request the engine does not release never reaches the server and the old document stays in place. Tested for `location.replace`, `location.href`, form POST, meta refresh, `reload`, `history.back`, triggered on focus, on a timer, and while an element was disabled. Ending the held request with a 204 answer or a failure both leave the old document intact. This is not a timing check: the request cannot proceed until the engine decides.

**F2. While a navigation is held the page cannot be questioned.** `Runtime.evaluate` and `Page.getFrameTree` got no answer in any held case until the held request was ended. The decision must therefore be made from the pause event and the engine's own state, and at once. This confirms the behaviour the last review measured, and turns it from an unstated assumption into a design constraint.

**F3. The hold does not cover documents made without the network.** A `javascript:` address, `document.open` and a `blob:` navigation were not paused. With real keyboard input, text was typed into the replacement document in the first two cases. The node-bound acts merged in PR #54 are what stops this (the node belongs to the old document), so they must stay. The two mechanisms are complementary, not alternatives.

**F4. The browser's debugging interface alone is not a complete ledger.** On the page's session it did not report requests from a popup, a service worker, a WebSocket, or anything sent as a page closes. A forwarding proxy owned by the experiment saw every request the server received in all 26 scenarios.

**F5. A proxy that forwards only what the engine released closes the gap structurally.** The engine marks each request it releases with a per-check secret header; the proxy strips it and forwards, and refuses everything unmarked. Result: fetch, XHR, beacon, keepalive, form POST, 303 and 307 redirects, frame and worker requests passed; popup, service worker, WebSocket and leave-time requests were refused and logged, and none reached the server. No grace period or event ordering is involved.

**F6. Leave-time activity is observable and containable.** 12 runs each of 9 listener kinds: the proxy saw every request sent on `pagehide`, `visibilitychange` and `unload` (including from a frame, ten at once, and after a 400 ms busy listener); with the proxy sealed none reached the server (0 of 84 runs). A listener that sends nothing produced nothing.

**F7. The shop's leave-time listener is Next.js's own and sends nothing.** `next/dist/client/components/router-reducer/fetch-server-response.js` registers `pagehide` to set a flag (`isPageUnloading = true`) that suppresses error logging. It is present on every page of every App Router application. Under the current rule every such application is Unverified; under observation it passes this gate.

**F8. The real shop works through the whole arrangement.** Sign in, add to cart, pay, read the balance (0 before, 124 after), a new page per step, every request paused and decided, acts done on the held node, proxy in the path. All three writes were Next.js server actions (a `fetch` POST to the page's own path), each paused and released. No request was seen only by the proxy; no leave-time request occurred.

**F9. For Next.js server actions, method and path do not identify the action.** Every action on a page POSTs to that page's path; in one run a wrong selector pressed "Sign out" on the checkout page and the write matched `POST /checkout`. The action is named by the `Next-Action` header. Today only the `see` conditions stand against this.

## 2. Scenario coverage

| Scenario | Result | Evidence |
|---|---|---|
| Page navigates away while engine types or waits (replace, href, form, meta, reload, back) | Covered: held, second page never loads | e1, e1b |
| Document replaced without network (`javascript:`, `document.open`, `blob:`) | Not covered by the hold; covered by node-bound acts and address checks | e1, e1b |
| Expected write by fetch, XHR, beacon, keepalive, form POST | Covered: paused, released, seen by proxy | e2, e6 |
| Redirect after a write (303, 307) | Covered: each hop paused separately | e2, e1b |
| Write from a same-origin frame or `about:blank` frame | Seen and paused; cannot be told from the page's own for a form into the top frame | e1b |
| Write from a dedicated or nested worker | Paused by `Fetch`, not reported by `Network`; seen by proxy | e2 |
| Write from a popup | Not seen on the page's session; refused by pass-mark proxy | e2, e6 |
| Service worker request | Not seen on the page's session; refused by pass-mark proxy (engine also blocks service workers) | e2, e6 |
| WebSocket | Proxy sees only a tunnel request; refused under pass-mark | e2, e6 |
| Leave-time beacon, keepalive, plain fetch at page close | Not seen by debugging interface; always seen by proxy; refused when sealed or unmarked | e3, e6 |
| Leave-time listener that sends nothing (Next.js) | Nothing sent; no reason to refuse | e3, e4, e5 |
| Leave-time listener that writes only to browser storage | Not observable by any tested mechanism | not tested further |
| Timer-sent write that lands in the act's window | Counted as the act's (unchanged limit) | prior review |
| Frame or popup sends a form into the top frame | Indistinguishable at the pause; same origin, so same principal under the two-tier model | e1b |
| Next.js server actions end to end | Works | e5 |
| HTTPS target | Not tested. The proxy sees only a tunnel; the pass mark needs TLS interception | uncertain |
| Channels outside HTTP (WebRTC, WebTransport) | Not tested; would bypass the proxy | uncertain |
| Upper bound on how late a leave-time request can come | Not established (a 3 s busy listener sent nothing in 4.5 s); irrelevant under pass-mark | e6 |
| Other browsers or Chromium versions, headed mode, heavy load | Not tested | uncertain |

## 3. Recommended architecture

1. **Pass-mark proxy as the only route to the target.** Nothing reaches the application unless the engine paused it, decided, and released it. Unmarked requests are refused and recorded; an unmarked write makes the check Unverified.
2. **Hold with a fixed policy.** During typing and a no-write act: any main-frame document request or write is ended and the check is Unverified. During a write act: the one expected write is released; anything else is refused. Decisions use only the pause event and engine state (F2).
3. **Node-bound acts stay** as merged, for documents replaced without the network (F3).
4. **Leave-time by observation.** Listeners are allowed to run. An unmarked write at leave is refused and makes the check Unverified; a listener that sends nothing does not. The current refuse-on-listener rule is retired only when this is implemented, reviewed and tested.
5. **Remove** the frame and window counting for forms and the reliance on the two unpromised browser behaviours; under the two-tier model a same-origin frame is the same principal as the page.

## 4. Changes to the proposed stages

- Stage 1 (hold and ledger) and stage 2 (leave-time) become one mechanism and should be one stage, in two or three PRs.
- New item in that stage: the browser is launched by the engine with the proxy as its only route; today a browser is passed in.
- New optional item: allow a binding to name the `Next-Action` (or another request header) as part of the expected write (F9). Not essential for the first demonstration because `see` conditions cover it.
- New essential item before real customers, not before the demonstration: HTTPS targets (TLS interception with an engine CA), and worker-level network isolation so that the proxy cannot be bypassed (already on the KAN-16 checklist).
- Stages 3 to 8 unchanged. Legibility remains the least understood essential gate.

## 5. Remaining limitations and risks

- **HTTPS is unproven.** Everything here ran on plain `http`. Real customer targets are HTTPS. This is the largest open technical risk in the proposal.
- **Proxy bypass.** Without network isolation at the worker, non-HTTP channels are not covered.
- **WebSocket applications** would be refused until a rule for them exists.
- **Storage written at leave** is not observed. This is ordinary application behaviour that a person leaving the page also causes; it is stated, not solved.
- **Attribution is to the origin and the act's window**, not to the press. A hostile application can still send the expected write itself; per the two-tier model this is out of scope and reports must say "displayed", not "true".
- **One browser version.** The hold rests on documented `Fetch` behaviour rather than timing, but was measured on one Chromium build.
- **Performance** was not measured beyond the shop loading in about 0.6 s per page with every request paused.
