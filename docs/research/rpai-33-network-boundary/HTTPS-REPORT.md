# RPAI-33: HTTPS spike and proposed final architecture

23 November 2026. Isolated experiments only; no engine code changed; trusted verdicts remain disabled.
Environment: Chromium 157 headless (Playwright 1.63), Node 22, Linux. Pretend customer sites served over TLS
under names the browser cannot resolve itself (`app.test`, `shop.test`, `widget.test`), with certificates from
a stand-in "public" authority. `shop.test` is the Next.js 16.4.6 shop from `apps/shop` behind TLS.
Scripts: `https/h1` to `h6`.

## 1. Answers to the owner's questions

### Can the proxy safely observe, allow and block HTTPS requests? Yes.

The proxy ends the browser's TLS connection with a certificate of its own and opens its own verified TLS
connection to the site. In between it reads each request (h1, h2):

- A request the engine released (it bears the per-check mark) is forwarded, with the mark removed. The mark
  never reached the application in any request.
- An unmarked request is refused and recorded.
- A host that is not on the check's list is refused before any TLS is spoken.
- A site whose certificate does not verify against the public authority is refused by the proxy (502). The
  proxy, not the browser, is now what verifies the site, so this check is essential.
- The browser trusts **one key only**, the proxy's, pinned by its hash on the command line. Without the pin
  the browser refuses the proxy's certificate; no general "ignore certificate errors" setting is used. Pages
  are secure contexts with their real `https://` origin, so cookies, storage and browser features behave as
  in production.

### Do navigation, forms, server actions and leave-time requests remain observable? Yes.

Same results as over plain `http` (h2, h3): fetch, XHR, beacon, keepalive, form POST, 303 and 307 redirects,
frame and worker requests are paused by the engine and forwarded when released. Popup, service-worker,
WebSocket and all four kinds of leave-time request were refused and logged by the proxy; none reached the
server. The shop journey over HTTPS (sign in, add to cart, pay) gave a loyalty balance of 0 before and 124
after, with nothing refused and no leave-time request.

### Can browser traffic bypass the proxy? Yes, unless the browser is isolated by the operating system.

- **WebRTC bypasses it.** With the proxy configured and the browser resolving no names, a page still made the
  browser send UDP packets straight to an address of its choosing (4 packets for a STUN server, 1 for a TURN
  server). The command-line settings tried (`--force-webrtc-ip-handling-policy`,
  `--webrtc-ip-handling-policy=disable_non_proxied_udp`, `--disable-quic`) did not stop it (h4).
- Everything else tried went through the proxy and was refused there: direct `https://` and `ws://` to an IP
  address, plain `http://`, another host. WebTransport sent nothing in this build (not established why).
- **In a network namespace of its own, nothing escaped** (h5). The browser was started with only a loopback
  interface, on which the only listener is a relay to the proxy. The WebRTC attempts sent 0 packets outside;
  the page still loaded, a released write still arrived, a leave-time write was still refused. The proxy also
  caught and refused a request of the browser's own (to a Google service) that no page asked for.

Browser settings are therefore not a boundary. The operating system is.

### What additional security controls are required?

1. **Network isolation of the browser process** by the operating system (namespace, container network or
   firewall): its only reachable address is the proxy. Required, not optional. This is the worker-level
   outbound restriction already on the KAN-16 checklist; the spike shows why browser confinement cannot
   replace it.
2. **The proxy verifies every site certificate** against the public authorities, and fails closed.
3. **A fresh interception key per check**, held in memory, trusted by that check's browser only (pinned by
   hash), and discarded with it. It must never be installed in any machine trust store, and never leave the
   worker. A leaked interception key that some browser trusted would let its holder impersonate any site to
   that browser.
4. **A per-check mark** that is random, compared in constant time, attached only to requests for hosts on the
   check's list, and stripped before forwarding.
5. **A host list per check**, approved with the binding: the target, and any other host the journey needs.
   Everything else is refused before TLS.
6. **The proxy sees everything the page sends and receives, in clear**: passwords, session cookies, personal
   data. It must keep no bodies, log only method, host, path and field names, and run in the same trust
   boundary and lifetime as the browser. This is a new place where customer data exists unencrypted and must
   be stated to customers.
7. **The engine launches its own browser** per check. Today a browser is handed in.

### Is this practical for real customer websites? Mostly yes, with stated limits.

Works as it stands: server-rendered sites, React and Next.js applications, forms, fetch-based APIs, redirects,
sites that load scripts from or embed frames of other hosts (h6; those hosts must be on the list).

Does not work yet, or is unknown:

| Case | Status |
|---|---|
| WebSocket applications | Refused. The upgrade request is not paused by the engine, so it cannot be marked. Needs its own rule. |
| Sign-in through another site (SSO, a hosted payment page) | Top-level navigation to another origin is outside the binding rules today. Needs design. |
| Applications that need a service worker | Service workers stay blocked. |
| Sites that require a client certificate or sit behind another proxy | Not tested. |
| Frames in a separate browser process (site isolation) | In this headless build the page's session paused a cross-site frame's requests. Other configurations not tested; unmarked requests would be refused, so it fails closed. |
| HTTP/2 and HTTP/3 to the browser | The spike proxy speaks HTTP/1.1 to the browser. Works; slower on heavy pages. Not measured. |
| Other Chromium versions | One build tested. The certificate pin and resolver settings are command-line switches that could change. |
| Where the worker runs | Creating a network namespace needs privilege. Available on a dedicated worker; on a shared CI runner it may not be. The existing CI path does not use the runner and is unaffected. |

## 2. Identifying the intended action

Stage 0 found that method and path do not identify a Next.js server action. The HTTPS shop run (h3) shows
what does, for anything submitted through a form:

- Before pressing, the engine asked the button it holds for its form's field names. For "Pay now" these were
  `$ACTION_ID_409b…` and `card`; for "Sign in", `$ACTION_ID_4063…`, `email`, `password`.
- The paused request carried the same names in its body, and for server actions the same identifier in its
  `Next-Action` header.

Proposed rule (**form-bound write**): the write an act expects is released only if it is the submission of the
form the pressed element belongs to: every field name the form held before the press appears in the request,
and every value the engine itself typed into that form appears with it. This ties the write to the element
the approver bound, in the engine's own world, without the binding having to name framework identifiers that
change on every build. It is checked while the request is held.

For a button that is not in a form (a click handler that calls `fetch`), there is nothing in the page to tie
the request to. There the binding may carry an approved description of the request (header names or body
field names, shown in the interpretation the approver signs); without one, the method and path and the `see`
conditions stand as today, and the report says so.

## 3. Proposed final architecture

1. **Isolated browser per check**, started by the engine in a network namespace whose only exit is the proxy.
2. **Release-only proxy** with TLS interception under a per-check key; verifies sites; host list; refuses and
   records everything unmarked.
3. **Hold and decide.** Every request is paused. During typing and a no-write act, a main-frame navigation or
   a write ends the check as Unverified. During a write act, exactly one write is released, and only if it is
   the form-bound write (or matches the approved request description). Decisions use the paused request and
   the engine's own state only.
4. **Node-bound acts** as merged in PR #54, for documents replaced without the network.
5. **Leave-time by observation.** Listeners run. An unmarked write at leave is refused and makes the check
   Unverified. The present rule (refuse when a listener exists) is replaced only once this is built, reviewed
   and tested.
6. **Removed:** frame and window counting for forms, and with it the two unguaranteed browser behaviours.

### Implementation stage 1–2, as small PRs (not started; needs approval)

| PR | Content | Essential |
|---|---|---|
| a | Proxy module: release-only, TLS interception, per-check key and mark, host list, upstream verification, record of refusals. Unit-tested alone; used by nothing. | Yes |
| b | Isolated browser launcher: network namespace, relay, certificate pin, resolver rule; fails closed if isolation cannot be established. Used by nothing. | Yes |
| c | Runner uses a and b: hold-and-decide policy, form-bound write, leave-time by observation; removal of frame counting; the runner's suite moved over. Independent security review of the whole. | Yes |
| d | Binding field for an approved request description, for writes not sent by a form (with format version 2). | Optional for the first demonstration |
| e | WebSocket rule; SSO and hosted-payment navigations. | Needed for many real customers; not for the demonstration |

## 4. Remaining limitations and risks

- **A new place holds customer data in clear** (control 6). This is a product and trust question as much as
  a technical one.
- **Privilege.** Namespace isolation needs a worker we control. If a deployment cannot provide it, trusted
  checks must be refused there rather than run without isolation.
- **Form-bound write is a rule about names and typed values**, not proof of cause. An application could send
  a request with the same field names by other means. For an honest application that is the same action; a
  hostile one is out of scope under the two-tier model.
- **Storage written at leave** is still not observed.
- **Legibility** remains the least understood essential gate and is untouched by this work.
- **One browser build, one operating system, headless.** No performance measurement beyond page loads of
  0.6 to 0.9 seconds for the shop.
- **Not tested:** client certificates, upstream proxies, IPv6, out-of-process frames, HTTP/2 to the browser,
  very large uploads, long-lived streaming responses.
