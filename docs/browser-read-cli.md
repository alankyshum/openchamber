# Read-only browser contract

Status: **implemented contract.** This document defines what
`browser.extract`, `browser.scrollWithin`, and `browser.navigate` must be. The
page scripts (`packages/ui/src/lib/browser/pageActions.ts`), the validation
(`packages/web/server/lib/openchamber-control/service.js`), and the CLI are
built against it, not the other way round.

## Purpose

The in-app browser already carries the user's real logged-in session. That makes
it the only place some pages can be read at all, and the reason this surface has
to be narrow: a general-purpose automation tool pointed at a logged-in account
can do anything the account can do. The read surface exists so a caller can
extract repeated structured items from a page it is looking at, and provably
nothing else.

## Scriptable CLI

The package installs `openchamber-browser`, a separate executable with no
generic action argument. Its complete command surface is:

```text
openchamber-browser open --url URL [--viewport mobile|tablet|desktop]
openchamber-browser navigate --url URL --expected-origin ORIGIN
openchamber-browser snapshot [--selector CSS]
openchamber-browser extract --spec FILE|-       # JSON file or stdin
openchamber-browser scroll --direction up|down|top|bottom [--selector CSS]
openchamber-browser scroll-within --selector CSS --direction up|down|top|bottom
openchamber-browser inspect --selector CSS
openchamber-browser back | forward
openchamber-browser resize --viewport mobile|tablet|desktop|fill
```

Use `--port` to select the existing loopback control server. `--server` and
`OPENCHAMBER_URL` are accepted only for trusted loopback origins; foreign
origins are rejected outright (there is no unsafe override, and the Threads
integration cannot opt into one). Authentication is transport-only:
`OPENCHAMBER_TOKEN` (or `--token`) and the desktop/session credentials are
forwarded only to that loopback origin and are never included in an output
envelope. Redirects are not followed. The browser session itself is not logged
in, copied, or persisted by the CLI. Every request includes `mode: "read"`.

The machine-readable output is one JSON object per invocation: success is
`{"ok":true,"action":"...","result":...}` and failure is
`{"ok":false,"error":"..."}`. Exit codes are stable: `0` success, `2`
invalid arguments/spec, `3` unreachable/no panel, `4` server rejected the
request, `5` timeout, and `8` response too large. `click`, `type`, and
`capture` are not commands and cannot be supplied as an action or spec value.

"Read-only" here means: no click, no typing, no form submission, no state the
site would record as an action by the user. It does not mean "invisible" — see
[Honest limits](#honest-limits).

## The read action set

`OPENCHAMBER_BROWSER_READ_ACTIONS` is an explicit allowlist, exported from
`openchamber-control/actions.js`. Membership is granted, never inferred: a new
action added to `OPENCHAMBER_WEB_ACTION_DEFINITIONS` is *not* read-safe until it
is named here.

| Action | In read set | Why |
| --- | --- | --- |
| `browser.open` | yes | Opens a tab; creates the view the rest operate on |
| `browser.navigate` | yes | Address-bar navigation to an explicit URL |
| `browser.snapshot` | yes | Existing bounded page read |
| `browser.extract` | yes | New — bounded declarative item extraction |
| `browser.scroll` | yes | Existing window scroll |
| `browser.scrollWithin` | yes | New — bounded scroll of one container |
| `browser.inspect` | yes | Existing computed-style read |
| `browser.back` / `browser.forward` | yes | History movement, no page action |
| `browser.resize` | yes | Changes layout only |
| `browser.click` | **no** | Acts as the user |
| `browser.type` | **no** | Acts as the user |
| `browser.capture` | **no** | Writes a file into the project directory |

`browser.click` and `browser.type` remain available to the general agent tool
and are unchanged. What is frozen here is that the read surface cannot reach
them, and that the CLI built on it exposes no subcommand, flag, spec field, or
environment override that resolves to an action outside this table.

## `browser.extract`

Reads many repeated items — feed cards, table rows, comments — in one call,
returning only the fields the caller named.

```
browser.extract {
  selector?:     string   // scope subtree; defaults to document
  itemSelector:  string   // required; each match becomes one item
  fields:        Field[]  // required; 1..MAX_FIELDS entries
  max?:          integer  // 1..MAX_ITEMS, default MAX_ITEMS
  includeText?:  boolean  // default false; adds item innerText
}
```

### The `Field` shape

This is the part the whole design rests on. A field says *where* to read from by
naming one of a fixed set of sources. There is no source that accepts an
expression, a function body, a template, or a property path, so no caller-
supplied string is ever evaluated — the worst a hostile `fields` entry can do is
select the wrong element.

```
Field {
  name:      string   // required; ^[a-z][a-zA-Z0-9_]{0,39}$; unique within fields[]
  from:      enum     // required; see below
  selector?: string   // relative to the item; defaults to the item element
  attr?:     string   // required iff from === 'attr'; forbidden otherwise
  max?:      integer  // 1..MAX_FIELD_CHARS, default MAX_FIELD_CHARS
}
```

| `from` | Reads | Result when absent |
| --- | --- | --- |
| `text` | exact `innerText`/`textContent` | `""` |
| `attr` | `getAttribute(attr)` | `null` |
| `aria` | the `accessibleName()` helper | `""` |
| `href` | `href` resolved to an absolute URL | `null` |
| `datetime` | `time[datetime]` attribute **and** its exact visible label, as `{ iso, label }` | `null` |
| `ariaPressed` | tri-state toggle: `true` / `false` / `null` | `null` |

`ariaPressed` is tri-state on purpose. A toggle whose state cannot be read
unambiguously must come back as `null`, never `false`. A guessed `false` is
indistinguishable from an observed one, and it is the failure mode that would
make a future write feature act on a wrong belief.

`datetime` returns both halves because they answer different questions and
degrade separately: the machine timestamp may be absent while the visible label
("2h") is present. Neither is ever synthesized from the other.

`additionalProperties: false`. An unknown key inside a field entry is a `400`,
not an ignored key — a silently dropped spec reads as an empty result and sends
the caller hunting in the wrong place.

### Result envelope

```jsonc
{
  "ok": true,
  "url": "https://…", "title": "…",
  "scope": "document" | "<selector>",
  "itemSelector": "<selector>",
  "items": [
    {
      "index": 0,
      "selector": "article[data-testid=\"post\"]",  // cssPath() of this item
      "values": { "author": "…", "permalink": "https://…", "liked": null },
  "text": "…",                                  // exact item text, only when includeText
      "truncatedFields": ["body"]                   // omitted when empty
    }
  ],
  "scrollY": 0, "maxScrollY": 4200, "atTop": true, "atBottom": false,
  "viewport": { "width": 1280, "height": 800 },

  // Truncation flags — present only when they bit:
  "itemsTruncated": true, "itemsOnPage": 240,
  "fieldsTruncated": true,
  "budgetExhausted": true, "itemsReturned": 42
}
```

Failure is always `{ "ok": false, "error": "<one sentence>" }` — an invalid
selector, a scope that matches nothing, or an `itemSelector` with no matches.
Scripts resolve this shape rather than throwing, so a failed match is
explainable instead of an opaque evaluation error.

Every item carries the `cssPath()` selector generated for it. That is the seam
that makes "extract the comments under *this* post" work without a second
contract: an item selector from one extract is a valid `selector` scope for the
next.

## `browser.scrollWithin`

`browser.scroll` moves the window. Infinite feeds usually live in their own
scrolling container, where window scrolling does nothing at all.

```
browser.scrollWithin {
  selector:  string   // required; the container, or any element inside it
  direction: enum     // required; 'up' | 'down' | 'top' | 'bottom'
  rounds?:   integer  // 1..MAX_SCROLL_ROUNDS, default 1
  settleMs?: integer  // 0..MAX_SETTLE_MS, default 350
}
```

Resolution walks from the matched element to its nearest scrollable ancestor, so
a caller can pass an item selector it already has rather than having to name the
container. Scrolling is instant, never smooth: the page's own animation would
still be running when the next action reads the result.

```jsonc
{
  "ok": true,
  "selector": "div.feed", "direction": "down",
  "requestedRounds": 8, "rounds": 3,
  "scrollTop": 5400, "maxScrollTop": 5400,
  "atTop": false, "atBottom": true,
  "heightBefore": 4000, "heightAfter": 12000,
  "grew": true,
  "roundsCapped": true   // only when MAX_SCROLL_ROUNDS bit
}
```

`grew` reports whether `scrollHeight` increased across the rounds. It is the
whole basis of feed pagination: it is the only thing that distinguishes "the
feed loaded more" from "the feed has ended", and a caller that cannot tell those
apart either stops early or scrolls forever.

`scrollTop`/`maxScrollTop` are deliberately named differently from
`browser.scroll`'s `scrollY`/`maxScrollY`. They measure a container, not the
window, and conflating them would make a result from one action silently
wrong when read as the other.

## `browser.navigate`

```
browser.navigate { url: string, expectedOrigin: string } // absolute http(s), exact same-origin
```

Movement without interaction. `browser.open` creates a tab and applies a
viewport; `navigate` does neither — it drives the existing tab and fails when
there is none, rather than quietly opening one and returning a result about a
page the caller never asked for.

Validation is deliberately split, because neither half can do the other's job:

- **Server** (`service.js`) parses the URL with the same absolute-`http(s)`
  check `browser.open` already uses and requires `expectedOrigin` to be an exact
  origin matching the target. This is an enforceable caller authorization
  constraint, even though the server cannot know what page is open.
- **Renderer** compares `expectedOrigin`, the target origin, and the current
  page origin, returning `{ ok: false, error }` when any differ. Cross-origin
  movement is how a read session gets walked off the site it was authorized for.

Host allowlisting beyond same-origin is **not** OpenChamber's job. This surface
stays site-agnostic; the `threads.com`-only rule lives in the consuming skill.
For tunneled loopback pages, the renderer loads an ephemeral local tunnel
origin but maps it back to the requested host origin for display and persistence.
Renderer navigation reports the actual final URL and rejects a cross-origin
redirect rather than silently treating it as the requested page.

## Caps

Bounded by the caps, not by the size of the page — the same property
`buildSnapshotScript` already has. Existing snapshot caps (`MAX_TEXT_CHARS`
6 000, `MAX_ELEMENTS` 120, `MAX_LABEL_CHARS` 80) are unchanged.

| Cap | Value | Reasoning |
| --- | --- | --- |
| `MAX_ITEMS` | 100 | A screen of feed cards is tens; 100 spans several scroll rounds without a second call |
| `MAX_FIELDS` | 12 | Wider than any real card (author, url, time, body, four counts, two states) and narrow enough to bound the product |
| `MAX_FIELD_CHARS` | 1 000 | A social post body fits; a field is a value, not a document |
| `MAX_ITEM_TEXT_CHARS` | 2 000 | `includeText` is a fallback for un-modelled markup, so it is looser than a field but still per-item |
| `MAX_TOTAL_CHARS` | 512 000 | The real ceiling — see below |
| `MAX_SCROLL_ROUNDS` | 20 | Enough to walk a feed; short enough to stay under the 20 s action budget with a settle delay |
| `MAX_SETTLE_MS` | 2 000 | 20 × 2 000 ms = 40 s, so the two are capped jointly (below) |

**`MAX_TOTAL_CHARS` exists because the per-item caps multiply.** 100 items × 12
fields × 1 000 chars is 1.2 M characters, and
`POST /api/browser-control/result` parses with `express.json({ limit: '2mb' })`.
Worst case would land near that limit, where the failure is not a truncated
result but a rejected body surfacing to the agent as an unexplained timeout. The
script therefore accumulates a character budget across items and stops when it
is exhausted, reporting `budgetExhausted` and `itemsReturned`. 512 000 keeps the
worst case at roughly a quarter of the transport limit with JSON overhead.

**Rounds and settle are capped jointly.** `rounds × settleMs` must not exceed
15 000 ms, or the request is rejected with a `400` before it is sent. The
alternative is a call that is individually within every cap and still guaranteed
to blow the 20 s budget — a timeout the caller cannot diagnose from the values
it passed.

**Every cap that bites is reported.** `itemsTruncated` + `itemsOnPage`,
`fieldsTruncated`, `budgetExhausted` + `itemsReturned`, `roundsCapped`. A capped
list that reports only its own length reads as the whole page, and a caller acts
as if it had seen everything.

## Redaction boundary

The extraction returns **only** the fields the caller named, from elements
matched under `itemSelector` within `selector`. There is deliberately no way to
ask for:

- `document.cookie`, `localStorage`, `sessionStorage`, or `indexedDB`
- request or response headers, or any network detail
- `innerHTML`, `outerHTML`, or any raw-HTML dump of anything
- the full document text (that is `browser.snapshot`, with its own caps)
- any script, `<meta>`, or `<link>` content

`from: 'attr'` is the one source that reads a caller-named string off the page,
so it carries its own rule: `attr` must match
`^[a-zA-Z][a-zA-Z0-9:_.-]{0,63}$` and must **not** match
`/(token|csrf|auth|session|secret|key|nonce|signature|jwt|bearer)/i`. Pages
routinely park CSRF tokens and session identifiers in `data-` attributes, and
without this rule the attribute reader is a credential exfiltration path wearing
a field name.

Credentials are never handled at all: the browser panel holds the session as
ordinary Chromium cookies, and no code here reads, copies, forwards, or persists
them.

## Mutation boundary

The read surface performs no click, no typing, no form submission, no
`requestSubmit()`, no synthetic keyboard or pointer event, and no
history-altering navigation other than `browser.navigate` to an explicitly
supplied same-origin URL.

Two structural properties, not two conventions:

1. The page scripts for `extract` and `scrollWithin` contain no call that
   dispatches an event or invokes `.click()`. They read and they scroll.
2. The CLI has no generic action passthrough. Its subcommand table resolves only
   into `OPENCHAMBER_BROWSER_READ_ACTIONS`, and a test asserts the intersection
   of that set with `{ browser.click, browser.type, browser.capture }` is empty
   — so adding a mutating subcommand later fails the suite instead of shipping.

## Transport and auth

The CLI reaches the panel over the existing control route rather than a new one,
so there is one request/response envelope and one place where actions are
validated:

```
POST /api/openchamber/control
Authorization: Bearer $OPENCHAMBER_TOKEN
{ "action": "browser.extract", "input": { … }, "contextDirectory": "…", "mode": "read" }
```

Server address and token come from `OPENCHAMBER_URL` / `OPENCHAMBER_TOKEN`, or
an explicit `--server` flag. They are never written to stdout, stderr, a log
line, an error message, or any file; every error path scrubs them.

There is no login flow. The CLI depends entirely on the session already in the
panel, and when no panel is attached it exits `3` immediately — the broker
answers "nobody is listening" with a `503` rather than blocking, precisely so
this case never presents as a twenty-second silent hang.

Timeouts follow the existing policy: `browser.navigate` gets the 45 s
open-class budget because it waits for a navigation to settle; `extract` and
`scrollWithin` keep 20 s.

Exit codes are stable: `0` success, `2` invalid arguments or spec, `3` browser
unreachable / no panel, `4` action rejected by the server (4xx), `5` timeout,
`8` response exceeded the size limit.

## Validation is mechanically checkable

Every parameter in this contract is checkable by the guard style already in
`service.js` — `asNonEmptyString`, an enum membership test, or an integer range
test — with no dynamic code path anywhere:

| Parameter | Guard |
| --- | --- |
| `selector`, `itemSelector` | `asNonEmptyString` |
| `direction`, `from` | membership in a frozen array |
| `max`, `rounds`, `settleMs` | `Number.isInteger` + range |
| `includeText` | `=== true` |
| `url` | `new URL()` + protocol check, then renderer-side origin equality |
| `fields` | array, length 1..`MAX_FIELDS`, each entry an object with known keys only, unique `name`, `attr` present iff `from === 'attr'` |
| `name`, `attr` | regex, plus the `attr` denylist |

An invalid call is rejected on the server before a client is woken, so a usage
error comes back as something the caller can correct rather than as a round trip
and a timeout.

## Change seams

Two kinds of change are expected, and both are meant to be cheap:

- **A site's markup changes.** Nothing in OpenChamber knows about any site.
  Selectors live in the caller's extraction spec, which the CLI loads from a
  JSON file (or stdin) rather than from a shell line — so a redesign is a data
  edit under version control, and a diff.
- **A profile needs re-deriving.** `browser.snapshot` on the same page returns
  the interactive elements with the same `cssPath()` selectors that `extract`
  emits, so a broken spec is repaired by snapshotting and reading, not by
  guessing.

Adding a new `from` source is the one change that is deliberately *not* cheap:
it requires editing the enum, the validator, the schema, and the page script
together. That friction is the point — it is what keeps the enum from growing an
escape hatch.

## Honest limits

- **Reading a page is not invisible.** Navigating and scrolling issue ordinary
  requests, and a site may record impressions, mark notifications seen, or
  count a view. This surface guarantees no *deliberate* action is taken as the
  user; it cannot guarantee the account looks untouched.
- **Same-origin is enforced twice:** the service requires and forwards an exact
  `expectedOrigin`, while the renderer compares it with both the current page
  and target URL before loading. The renderer is still the component that would
  be wrong if the panel's notion of "current page" lagged a redirect.
- **The read set is only as good as the allowlist.** The shared control route
  carries an explicit `mode`; `service.execute(..., { mode: 'read' })` rejects
  every browser action outside the read allowlist before waking the browser.
  Callers using the general write mode retain the existing interactive browser
  capability by design. The read CLI always sends read mode and has no generic
  action passthrough.
