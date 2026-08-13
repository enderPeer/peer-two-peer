# Peer two Peer — The design

The rules the interface is built from, and why each one is there. Section 11
of `ARCHITECTURE.md` is the binding statement; this document is the reasoning
behind it and the record of what was actually built.

Three files carry all of it:

```
app/index.html            the shell — semantics, states, and the hook contract
app/style.css             the whole system, commented by section
app/sw.js                 offline, installability, and the promise about pictures
app/manifest.webmanifest  the installable identity
```

There is no fourth. No build step, no preprocessor, no framework, no font
file, no icon set, no CDN. Every glyph in the app is a real character or an
SVG authored inline in the markup. This is not minimalism as a style; it is
the only way an app can be served from an IPFS gateway, a static host and a
member's laptop and be the same app in all three.

---

## 1. The format: one column, phone width, everywhere

The app is a single column with a maximum width of 480 pixels. On a phone it
fills the screen. On a desktop it sits in the middle of the window at exactly
the same width, with a hairline down each side and paper around it.

The desktop does not reflow. There is no two-column variant, no sidebar, no
wide-screen grid. A breakpoint in this app is allowed to change one thing —
the colour of the vertical hairlines that mark where the column ends — and
nothing else. The hairline is declared at every width and simply made visible
above 560px, so the column's inner geometry is byte-identical on a phone and
on a monitor.

Why: a reflowed desktop layout is a second design. A second design is a second
set of bugs, a second set of states to keep in step, and a second place for a
price to be laid out differently from the place the user learned it. Pictures
and prices are the content here, and neither of them gets better with more
horizontal space. One shape means one thing to verify.

The cost is real and worth naming: on a 27-inch monitor most of the screen is
blank paper. We accept that.

---

## 2. Two colours

Ink `#000` and paper `#FFF`. That is the whole palette.

Grey appears in exactly three roles, and each one is a role where grey means
*absent* rather than *different*:

| token | value (light) | role |
|---|---|---|
| `--hair` | `#d8d8d8` | hairlines, borders, frames — decoration |
| `--mute` | `#6b6b6b` | disabled controls and secondary text — and the *edges* of disabled controls, which used to be `--hair` |
| `--fill` | `#f0f0f0` | skeleton bodies: content that has not arrived |

No colour is used to carry meaning anywhere in the interface. There is no red
error state and no green success state — the offline banner is inverted ink,
the refusal toast is inverted ink, and both say in words what they are. A
status conveyed only by hue is a status that a colour-blind member, a
monochrome e-ink screen and a printed page all fail to receive.

Colour exists in this app in exactly one place: inside the pictures. That is
the point. The interface is the frame; the photograph is the content. A frame
that competes with what it holds is a badly made frame.

The two colours are CSS custom properties, which is what makes section 3 of
the stylesheet possible.

---

## 3. The meter

The running session spend, in euros, is pinned in the header and is never
scrolled away.

This network bills per impression. A scroll costs money. A design that puts
that total behind a tap, in a settings screen, or on a monthly statement is a
design that profits from the user not looking — and a network that bills per
impression and hides the meter is a trap, whatever its documentation says.

So:

- The figure is in the header, above everything, at every moment the app is
  open and in every view.
- **And inside every sheet, because the header is not enough.** A `<dialog>`
  opened with `showModal()` puts a backdrop over the sticky header and makes it
  inert. For as long as a sheet was open the running total was simply not on
  screen — and the composer, where a member commits to a publish fee and a
  lease, was the one surface that did not restate it. The wallet restated it;
  the composer and the register sheet did not. That was the single place in the
  app where "always visible" was false, and it was the place it mattered most.
  Every sheet head now carries the meter, and a sheet head is outside the
  element that scrolls, so scrolling a long sheet cannot scroll the total away
  either. (It is *not* sticky, and a comment in the stylesheet used to say it
  was. See section 10.)
- The mirrors are found by class, not by id: `#meter-value`, `#meter-live`,
  `#composer-session`, `#wallet-session`, `#register-session` and
  `#spend-total` all carry `.session-total`, and the hook contract requires
  them to be written in one pass with one string. A per-id update is how one
  surface goes quietly stale, and a stale meter is the same trap as no meter.
- It is in euros, formatted by `core/pricing.mjs formatEur()`, which never
  rounds a non-zero price down to zero. A price that reads `0.00 €` when a
  payment occurred would be a lie told by a rounding rule.
- It is a button. Pressing it opens the wallet, where the same number is
  itemised line by line — what was billed, for what, and when.
- When it changes it blinks once, inverted, and settles. That is the app's
  only unsolicited animation, and it exists so that being billed is never
  silent. That is the seen half; the heard half is the next section, and it
  was the half that did not work.

### How many of those six speak

One, at any moment. That is a decision, and here is the whole of it.

Being billed must not be silent, and it must not be said twice. Six nodes carry
the figure; if each announced, one impression would be read out several times
and a member would learn to ignore the one number the network exists to keep
honest. So the rule is: **exactly one copy of the session total is a live
region in the accessibility tree at any moment, and it is always the one on the
surface the member is actually looking at.**

What produces that:

- `#meter-value`, the printed figure in the header, is a plain `<span>`. It was
  an `<output>` — implicit `role="status"`, a live region — sitting inside
  `<button id="meter">`. ARIA gives a button *presentational children*: every
  role inside it is stripped, including that one. The header meter therefore
  looked live in the source and announced nothing at all, while the sheet
  mirrors, which are `<output>` in ordinary contexts, announced normally. The
  same number was silent in the header and spoken in a sheet.
- `#meter-live` is the header's spoken copy: an `<output>`, visually hidden,
  a sibling of the button rather than a child of it. It carries
  `.session-total`, so the one write that updates every printed mirror updates
  the spoken one in the same pass and the two cannot disagree.
- The three sheet mirrors stay `<output>`. They are not a second announcement:
  `showModal()` makes everything outside the dialog inert and hides it from
  assistive technology, which takes `#meter-live` out of the tree for exactly
  as long as a sheet is open, and only one dialog is ever open. The header
  speaks on a page, the open sheet speaks in a sheet, and nothing speaks twice.
- `#spend-total` in the wallet stays a plain `<span>`. It is the same figure
  again, a few lines under `#wallet-session` in the same sheet; making it live
  would say the number twice in one breath.

The trade is one extra node in the header carrying a figure that is already
printed two pixels away. That is the price of a control that has to be a button
*and* has to announce, and it is cheaper than the alternatives: taking the
number out of the button loses the tap target, and leaving it as an `<output>`
inside the button leaves a live region that is live only in the source.

Back to visibility, and the rest of the surface it covers. Per-card prices obey
the same rule as the meter: the price of one impression is printed on the card,
beside the author's name, before the impression happens — not in a tooltip and
not behind a tap.

And because a billable view requires 60 % of the viewport for a continuous
dwell, the frame carries a two-pixel bar that fills across that dwell. It is
the user's only warning that an impression is being counted, and it is drawn
at the exact moment the counting is happening.

---

## 4. Type and geometry

`system-ui` for prose and controls; the platform's own monospace stack for
addresses, content identifiers and hashes. Nothing is downloaded.

The monospace is not decoration. An address and a `cid` are strings that get
compared by eye, character against character; a proportional font makes that
comparison harder, and this app asks people to do it.

Every number that represents money or a count is set with
`font-variant-numeric: tabular-nums`. A meter that ticks upward must not
shuffle the characters next to it.

Corners are square, `--radius: 0`. The type scale, the spacing scale, the
hairline width, the tap target and the single motion duration are all tokens
in one block at the top of the stylesheet, so that a change is a change
everywhere or it is not made.

Icons are inline SVG, authored here, stroked with `currentColor` — a back
chevron, a heart, a speech rectangle, a plus in a square, a card. Five shapes.
Anything that needed a sixth was written as a word instead.

---

## 5. Smooth, and how it is measured

"Smooth" in this app is four specific claims, not an impression:

**No layout shift, by construction.** Every picture reserves its aspect ratio
before a single byte of it is fetched. The `w` and `h` travel in the `post`
act itself, so the app sets `--ar: w / h` on the frame and only then assigns
`src`. Nothing moves when the bytes arrive; nothing moves when they fail to
arrive. This is why the hook contract states the order of those two
operations as a requirement rather than a suggestion.

There are exactly three frames and the contract now names all three, because
naming two of them is how the third shifts: `.card__frame` in a feed card,
`#post-frame` in the detail view — the largest picture in the app, and so the
largest shift if its ratio is reserved late — and `#composer-frame`, which
takes its ratio from the chosen file's natural size. A `.frame` with no `--ar`
falls back to `4 / 5`, which reserves a box of the wrong shape rather than no
box at all: the page does not jump, but the crop is wrong, so "before `src`"
stays a requirement.

**Off-screen cards cost nothing.** Feed cards carry `content-visibility: auto`
with `contain-intrinsic-size: auto 560px`. The browser skips layout, style and
paint for every card outside the viewport, and uses the intrinsic size as its
guess for the height it is skipping, so the scrollbar does not jump when a
card is rendered for the first time.

**Decoding is off the main thread.** Every `img` carries `decoding="async"`.
Feed images additionally carry `loading="lazy"`; the post-detail image carries
`fetchpriority="high"` instead, because it is the reason the view was opened.

**The platform owns the scroll.** No wheel handler, no touch handler, no
scroll-position rewriting, no snap points, no momentum simulation, no
"scroll-jacking" of any kind. `overscroll-behavior: contain` is applied to
sheet bodies only, so that scrolling a sheet does not scroll the feed behind
it — and never to the page, so pull-to-refresh keeps working.

Safe-area insets are honoured on all four sides: the document declares
`viewport-fit=cover`, the header pads by `env(safe-area-inset-top)`, and the
bottom bar and every sheet body pad by `env(safe-area-inset-bottom)`.

---

## 6. Motion

There is one duration token, `--motion: 140ms`, and every transition and
every animation in the stylesheet reads it. Nothing has a hard-coded time.

`prefers-reduced-motion: reduce` therefore needs a single rule:

```css
@media (prefers-reduced-motion: reduce) { :root { --motion: 0s; } }
```

Every transition and every keyframe animation in the app collapses to zero at
once — no per-component override, no `!important`, and no way for a component
added later to quietly opt itself back in. That is the reason the token exists
at all.

The stylesheet ships zero `!important` declarations. The word appears three
times in it, all three in comments explaining why there are none.

---

## 7. Dark

`prefers-color-scheme: dark` swaps `--ink` and `--paper`. The same two
colours, exchanged. The grey tokens move with the background so that a
hairline stays a hairline and disabled text keeps its contrast ratio.

No component in the stylesheet knows the theme exists. Everything paints
`var(--ink)` on `var(--paper)` and is correct in both directions by
construction. `[data-theme="dark"]` and `[data-theme="light"]` on `<html>`
override the device preference in either direction, so an in-app switch can be
added later without touching a single component.

`color-scheme: light dark` is declared, so the platform's own form controls,
scrollbars and text-selection colours invert with the app instead of fighting
it.

---

## 8. Accessibility commitments

Measured facts about the shipped files, not intentions. Every ratio below is
computed from the tokens in `style.css` under the WCAG 2.x relative-luminance
formula; every structural claim is a statement about markup you can grep for.

### Contrast, in both directions

| pair | light (paper `#fff`) | dark (paper `#000`) | role | needs |
|---|---|---|---|---|
| ink on paper | **21.00:1** | **21.00:1** | all body text, all controls | 4.5:1 |
| `--mute` on paper | **5.33:1** (`#6b6b6b`) | **7.56:1** (`#9b9b9b`) | secondary + disabled text, disabled control edges | 4.5:1 |
| toast code line | **13.08:1** | **12.63:1** | `.toast__code` at `opacity:.8` on the inverted toast | 4.5:1 |
| `--hair` on paper | 1.43:1 (`#d8d8d8`) | 1.66:1 (`#333`) | decoration only | — |
| `--fill` on paper | 1.14:1 (`#f0f0f0`) | 1.21:1 (`#1a1a1a`) | skeleton bodies, `aria-hidden` | — |

The dimmest *text* in the app is `--mute`, and it clears 4.5:1 in both themes.
An earlier version of this document claimed 8.4:1 for `#9b9b9b` on black; the
real figure is **7.56:1**. It still passes, and the number is corrected here
rather than quietly kept, because a design document that rounds its own
measurements in its favour is not a record of anything.

The two low-ratio tokens are load-bearing in the opposite direction — they are
the tokens that are *allowed* to be faint, and the rule that lets them be faint
is that nothing drawn in them is the only carrier of anything:

- `--hair` draws rules, card separators, frame edges and the sheet grip. Every
  one of those boundaries is also expressed by spacing or by a word, so a
  reader who cannot resolve a 1.43:1 line loses no information.
- `--fill` draws skeletons, which sit inside `aria-hidden="true"` and are gone
  before there is anything to read.

**One control disappeared on hover.** `#app-banner-retry` is a `.btn--quiet`
inside `.banner`, and `.banner` is an ink surface with paper text. The quiet
hover rule set `background: transparent` together with `color: var(--ink)`,
which put ink text on the ink banner at **1:1** — pointing at the retry button,
the only control on the one strip that tells you the network is gone, erased
its label. `.btn--quiet` now takes `color: inherit`, so it is paper on the
banner and ink on the page — **21:1** either way — and draws its hover edge in
`currentColor`.

**One place `--hair` was doing work it is not allowed to do:** the border of a
disabled input, a disabled button and a `[data-busy]` button. That is the edge
of a control, and at 1.43:1 a disabled field on a white screen was a label
floating above nothing. Those three rules now use `--mute` — 5.33:1 and
7.56:1. WCAG 1.4.11 exempts inactive components from its 3:1 non-text floor;
we hold the floor anyway, because "you may not press this" only helps once you
can see the thing you may not press.

**And that third rule was reachable only by an attribute nobody had agreed on.**
This document and the hook contract said `[data-busy]`; the stylesheet said
`.btn[data-busy="1"]`. An app.mjs written against the documents — writing
`data-busy="true"`, or `""` — would have got a button that looked ordinary and
pressable while an act that spends money was in flight, with no error anywhere
to say the treatment had not applied. One name now: the selector matches the
**presence** of `data-busy`, the hook contract says so in the same words, and it
adds the two consequences of a presence selector — set the empty string, remove
the attribute to clear it (`data-busy="false"` still matches), and set
`disabled` alongside it so a second press cannot resend the act.

### Target size

Every interactive element holds at least 44 × 44 CSS px, the WCAG 2.2 **AAA**
figure for 2.5.5 (the AA floor in 2.5.8 is 24 px). The floor is the `--tap`
token, and it is applied at the control, never at the row around it — a 44 px
row containing a 21 px link measures the row, not the thing you have to hit.

Holding it: `.btn` and every variant, `.action` (44 × 44, so the whole action
bar qualifies), `.app-bar button`, `.brand`, `.meter`, `.chip`, `.sheet__close`,
`.toast__close`, `.segmented label`, and every `input` / `textarea` / `select`.

Three were below the floor and were fixed:

- `.card__author` / `#post-author` — standalone links sitting at the 21 px line
  box of `--f-3` text. WCAG 2.5.8's exemption is for links inside a sentence
  and does not cover these. Now `inline-flex` with `min-height: var(--tap)`,
  because a `min-height` does nothing to an inline box. Raising it had one
  consequence worth naming, because it cost a criterion to buy a criterion: in
  the detail view that link is the only thing inside `#post-heading`, so the
  heading's box became exactly the link's box, and the heading clips. See
  *Focus*, below — the ring it clipped is fixed there rather than by giving
  back the target.
- `summary` — the wallet's "this session" disclosure, about 16 px tall, and the
  only route to the itemised spend. Given `min-height` plus vertical padding
  rather than a flex display, because changing a `summary`'s display box
  removes its disclosure marker.
- `input[type="file"]` and the skip link in its focused state.

### Focus

The ring is **two rings**, and that is the fix for the dark inversion rather
than a flourish. A single ink ring disappears the moment it is drawn on ink,
and this app has ink surfaces deliberately: the offline banner, every toast,
`.btn--primary`, and the selected half of the segmented control. Under the
inversion `--ink` is white and those surfaces are white, so a single-ring
design does not stop failing in dark mode — it only changes which theme it
fails in.

So `:focus-visible` paints a 2 px paper ring immediately around the element
(`box-shadow: 0 0 0 2px var(--paper)`) and a 2 px ink ring immediately outside
it (`outline` at `outline-offset: 2px`). Whatever the element sits on is one of
those two colours, so one ring is always at **21:1** against the background and
the ring is always at **21:1** against itself. Both halves invert together, so
one rule covers both themes.

Two surfaces needed the same idea turned inward or removed:

- `.segmented input:focus-visible + span` draws the pair inset, because the
  transparent real radio cannot show a ring and the two halves share a border.
  The previous single inset ink ring was invisible on the selected half — the
  half a keyboard lands on first.
- `.toast:focus-visible` used to repaint the outline paper so it would show
  against the toast's ink body. But the ring is drawn *outside* the toast, over
  the paper page, where a paper ring is nothing at all. The override is gone;
  the two-ring rule covers the toast and its close button without a special
  case.

**And one place the ring was drawn correctly and then clipped off.** A ring that
paints outside an element is invisible if an ancestor clips. `#post-heading`
carries `.truncate` — `overflow: hidden`, which clips to the padding box — so a
long handle is cut instead of pushing `#post-state` off the row. Once
`.card__author` took the 44 px floor, the heading's box was *exactly* the link's
box: flush on the left where the text starts, and 44 px tall because the link
is. The ring reaches 4 px outside that box, so all of it fell outside the clip.
The one element a keyboard user has to find on that screen was the one element
with no visible focus.

The fix is `.view-head__title`: `padding: var(--ring-reach)` pushes the clip out
by exactly the distance the ring reaches, and `margin: calc(var(--ring-reach) *
-1)` gives the space straight back, so the heading's content box, its text and
its ellipsis do not move and the row keeps its height. Both figures come from
one token — `--ring-reach: calc(var(--ring) + var(--ring-gap))`, which the
`:focus-visible` rule itself is now built from — so the clip and the ring cannot
drift apart. Measured in a browser: 4 px of room on the left, the top and the
bottom, with the row height, the text position and the truncation unchanged, at
320 px and at 1280 px.

The alternatives were all worse, and each gives up something the fix keeps:
dropping `.truncate` lets a long handle overflow the row; shrinking the link
gives back the tap target that was just paid for; drawing this ring inward, as
the segmented control does, would put it on top of the first characters of the
name. The one case still not perfectly served is a handle long enough to
truncate — the link's box genuinely continues past the clip, so the ring is cut
on that side too, exactly where the text is. Three sides of a ring on a
truncated name is what truncation costs; nothing keeps a whole box visible when
the box does not fit.

`:focus-visible` drives all of it, so a mouse press leaves no ring and a
keyboard always gets one. The skip link is the first focusable element in the
document and becomes visible when it is reached.

### Semantics

- The feed is `role="feed"` over `<article>` elements — in ARIA that role *is*
  a list, specifically "a scrollable list of articles", and it is the right one
  here because it also carries `aria-busy` while paging and `aria-setsize` /
  `aria-posinset` on cards, which a plain list has nowhere to put.
- Comments are a real list: `#comment-list` is an `<ol role="list">` and
  `#tpl-comment` clones an `<li>` wrapping the comment `<article>`. It was a
  `<div>` of `<article>`s, which announced no count and no position.
  `role="list"` is stated explicitly because the marker is removed, and several
  browsers drop list semantics from a list with no markers.
- Sheets are native `<dialog>` opened with `showModal()`: the focus trap, the
  Escape key, the inertness of the page behind and the top layer come from the
  platform rather than from JavaScript that has to be right in every browser.
- Counts sit inside the button label ("like 12"), so the state is announced
  without a second labelled node. Decorative SVGs are `aria-hidden="true"` and
  `focusable="false"`.

**The meter is named once.** `#meter-help` used to be a child of the `#meter`
button *and* its `aria-describedby` target. A button's accessible name is
computed from its contents, so the whole sentence became the name and was then
read again as the description — the one control §11 says must never be hidden,
announced twice. The span now lives outside the button; `aria-describedby`
still reaches it by id. The name is `"session <amount>"`, the description is
the sentence, and neither repeats the other.

Two things therefore live outside `#meter` for two different reasons, and both
belong in one place so that neither is put back: `#meter-help`, because a
button's name comes from its contents, and `#meter-live`, because a button's
children are presentational and a live region inside one is not live. Section 3
carries the second argument in full.

**Prices that change are heard, once each.** The session total is covered in
section 3: `#meter-live` on a page, the open sheet's `<output>` in a sheet, one
live copy at a time. `#buy-quote` and `#buy-minout` are `<output>` — the two
figures a trader acts on — while rate, impact and fee are derivations of them
and stay quiet, so one edit is one announcement rather than five.
`#composer-total`, `#post-extend-cost` and `#wallet-eur` carry
`aria-live="polite"` for the same reason: the total announces, the component
lines that add up to it do not.

### Refusals interrupt

Two rules, and the second is the one that was got wrong.

**Nesting.** `#toasts` carries **no** live-region attributes, and the hook
contract forbids adding any. Every toast is `role="alert"`, which is an
assertive live region. The container used to be `role="status"
aria-live="polite"`, and an assertive region nested inside a polite one is
announced *politely* — the outer region owns it. A refusal, the one message a
user cannot afford to miss, was queued behind whatever else was speaking and
could be lost entirely if the user navigated first. Each toast now owns its own
announcement.

**Order.** A live region announces a mutation it *observes while it is in the
accessibility tree*. Text that is already in place when the region arrives in
the tree is commonly never spoken, and `[hidden]` — like any `display: none`
ancestor, which includes a closed `<dialog>` — keeps the region out of that tree
entirely.

The four inline refusals were built the wrong way round against that fact.
`#composer-error`, `#buy-error`, `#burn-error` and `#register-error` shipped as
`role="alert"` regions **with `[hidden]`**, and the contract told app.mjs to
fill them and *only then* remove `[hidden]`. So the sentence was written into a
region that was not in the tree, and the region then entered the tree with the
sentence already in it: on screen, in the right place, and silent. The floating
toasts were never affected, and the reason is the whole fix — a toast is cloned,
filled, and *then inserted*, so the insertion is the mutation that speaks.

The four are now empty `.error-slot` containers with no role, no `aria-live` and
no `[hidden]`, and app.mjs puts a filled `#tpl-toast` clone into them. Same
node, same three fields, same announcement path as the floating case; the only
difference is where it lands. An empty slot is a grid with no rows, so it is
zero pixels tall and needs no hiding — which matters, because a slot that could
be hidden could be filled while hidden, and that is the defect coming back.

`#app-banner` is the same fact seen from the other side. It is `role="status"`
and it cannot be an insertion, because it is a fixed part of the header with a
retry button in it. So it takes the other order: **remove `[hidden]` first, then
write `#app-banner-text`** — region into the tree, message after. And it now
ships with that sentence *empty*, deliberately: a ready-made "You are offline"
sitting in the markup makes "just unhide it" look correct and be silent, while
an empty one makes forgetting the write visible. Offline is the state in which
a member most needs telling, and it is announced now.

The three fields never change: every refusal printed carries the stable `code`,
the mechanism and the next step that `core/errors.mjs` publishes, and app.mjs
may not compose a sentence of its own. A user is told exactly what a bot would
parse.

### No `<time>` until there is a time

A `<time>` is conformant only when its `datetime` attribute holds a valid
datetime string, or, with the attribute absent, when its own text content is
one. There is no third case: no empty `<time>`, no `<time>` that says
"loading". The element has no way to mean *not yet*.

That is a problem for this shell, because the shell exists before its values do
— `#post-expiry` sits in a hidden view and the two others sit in templates. The
fix went wrong twice before it went right, and both wrong versions are worth
keeping on the record because they are the same mistake at different depths:

1. `<time>—</time>` and `datetime=""`. Invalid markup, and a dash handed to
   assistive technology where a date belongs. Found and "fixed".
2. `datetime="PT0S"`. This is *worse*, and it passed review. `PT0S` is a
   well-formed zero-length **duration** standing in for a lease **end instant**
   and for a comment's timestamp — the wrong kind of value, not merely an empty
   one. It validates, so nothing flags it; a consumer can render "0 seconds"
   for a post with a year of lease left. Replacing an invalid value with a
   false one removes the warning and keeps the harm.

So the three nodes are not `<time>` elements any more, and may not become one.
`#post-expiry`, `.card__expiry` and `.comment__at` are spans that carry **no
claim at all** until there is one: text `—`, `data-state="loading"`, and no
value attribute. When the value exists, app.mjs writes all three channels in one
operation — `data-ends` (or `data-at` on a comment) as an ISO 8601 instant in
UTC, the human text, and `data-state` (`live` / `settled` / `posted`). The
loading state is now on all three; it used to be on two of them.

What that costs: the `<time>` element itself. What it does not cost: anything a
reader receives, since assistive technology announces a `<time>`'s text and not
its attribute, and anything a machine receives, since this network's
machine-readable surface is the act log, `/api` and the epoch chain — the places
a claim is signed — and never scraped markup. A data attribute no parser can
mistake for a datetime claim is the honest carrier for a value the document is
merely displaying.

**Motion.** See section 6: reduced motion removes every transition and every
animation in the app.

---

## 9. Offline, and the promise the cache makes

The service worker precaches the shell, so the app starts with the network
off. Static assets are stale-while-revalidate. Calls to `/api` are
network-first, because a stale balance is a lie and a stale price is a
mispriced impression; a cached copy is served only when the network fails, and
it is stamped `x-ptp-stale` so the app can say what the user is looking at.

Then there is the part that matters.

**A picture is never kept past its post's expiry.** A post is a lease. When
the lease ends the post settles, the creator is paid, and the payload is
redacted from every node. A cache that quietly kept a copy would make that
deletion a fiction, and the deletion is a promise this network makes to the
people whose pictures it carries.

So the media rule has no exception:

- Pictures are requested as `/media/<cid>?exp=<epochMillis>`, where `exp` is
  the post's expiry taken from the act.
- **No `exp` on the URL → never cached.** If we cannot read when to forget the
  bytes, we do not keep the bytes.
- Otherwise the expiry is stamped into the cached response's own headers, and
  the entry is dropped the first time it is read after that instant, by a
  sweep on every activation, or immediately on a `FORGET` message when the
  post settles — whichever comes first.

Reads are cache-first, because a `cid` is the sha256 of the bytes: a hit is by
definition the right content and there is nothing to revalidate. Only the
right to hold it expires.

The service worker consults a clock. `core/replay.mjs` may not, and does not —
but this file is not the rulebook. Nothing here moves a balance or decides
what is true. The worst a wrong clock can do here is forget a picture early,
which is always safe, or serve one a few seconds late, which the next read
corrects.

**Cache naming.** `ptp-shell-v<N>` and `ptp-static-v<N>` carry a version;
bumping `VERSION` builds the new caches beside the old ones and deletes the
old ones only on activation, so a client runs entirely on one version or
entirely on the next — a half-updated shell is not reachable. `ptp-media` is
deliberately *not* versioned: the pictures are other members' bytes, fetched
over their connections, and discarding them because a stylesheet changed would
spend their bandwidth for nothing. Media correctness is governed by expiry,
which is per entry and independent of any release.

---

## 10. The hook contract

The bottom of `app/index.html` carries a comment block listing every id, every
class inside a template, every `data-act` value and every template shape that
`app.mjs` may bind to. It is a contract in both directions: the shell promises
those names are stable, and the app agrees to bind to nothing else. Anything
not on the list is presentation and may move.

Six rules in it are load-bearing rather than cosmetic:

1. Set `--ar` on the frame **before** assigning `src`. That is what makes the
   feed shift-free.
2. Media URLs must carry `?exp=`. Without it the service worker refuses to
   cache the picture at all.
3. Sheets are opened with `showModal()`, never by toggling `hidden`. Only
   `showModal()` arms the platform's focus trap and top layer.
4. Money is rendered by `formatEur()` and counts are rendered from BigInt.
   The shell provides `class="money"` and `class="num"` nodes; it never
   formats a currency itself, and neither may app.mjs.
5. **Live regions have an order of operations, and it is written out.** Fill a
   refusal and *then* insert it; reveal `#app-banner` and *then* write its
   sentence; write a surface's arrival values while it is still hidden so they
   are read as content rather than announced as news. Every one of those is the
   same fact — a region announces what it observes while it is in the tree —
   and the contract states each case rather than leaving the author to derive
   it, because the previous version left it to be derived and got it backwards.
6. `data-busy` is matched by presence, not by value, and it travels with
   `disabled`. A busy button that still looks pressable is a double-spend
   waiting for an impatient thumb.

The stylesheet contains one structural defence for that contract: component
display rules are kept to a single class of specificity, so `[hidden]` always
wins. A descendant selector on a layout container (`.app-header .column`) was
found pinning the offline banner permanently open during verification, and was
replaced with a dedicated class for exactly this reason.

A second instance of the same defect was found and closed: the redacted-frame
rule set `display: grid` on `.frame[data-redacted="1"]`, which is two units of
specificity and would out-rank `[hidden]` on any frame the app tried to hide.
The centring moved to the pseudo-element, which is absolutely positioned inside
the frame that was already `position: relative`. The rule that matters is not
"do not use attribute selectors" — it is that a component's `display` is
declared at one class of specificity and nowhere else.

### A comment that credited the wrong mechanism

`.sheet__head` carried `position: sticky; top: 0` and a comment saying that was
what kept the meter on screen while a sheet scrolled. It was not. `position:
sticky` does something only inside a scrolling ancestor, and the head has none:
the scroller is `.sheet__body`, which is the head's **sibling**, and `.sheet`
itself is a column flex container with a max-height that never scrolls.

The outcome was real and the explanation was false, which is the worse of the
two failures — a true comment on a dead declaration would only have wasted two
lines, while a false one teaches the next reader a mechanism that will not work
when they copy it. What actually holds the head still is the flex column:
`.sheet__body` is a scroll container, a scroll container's automatic minimum
size is zero, so the body is the only item that can absorb the overflow and the
head keeps its own height. The declaration is deleted, `flex: none` states the
head's half of that out loud, and the comment now credits the column. Verified
in a browser rather than argued: with `position` computing to `static`, the
head's top does not move when the body is scrolled to its end.

---

## 11. What this design refuses to ship

- No web font, no icon font, no sprite sheet, no CDN, no analytics, no
  third-party request of any kind. The document references exactly one
  external hostname — `http://www.w3.org/2000/svg` — and that is an XML
  namespace, not a fetch.
- No inline script but the single `<script type="module" src="app.mjs">`.
- No binary asset. The favicon, the manifest icons and the shortcut icons are
  all inline SVG carried as data URIs.
- No `!important`.
- No colour outside the pictures.
- No layout that only exists above a breakpoint.

---

## 12. Known limits

Stated plainly, because a design document that lists only its wins is
marketing.

- **SVG-only icons.** Some install flows still prefer a raster icon of a known
  pixel size. We ship no binary files, so members on those browsers may get a
  generic install icon. The trade was made deliberately: a repository that can
  be verified byte for byte is worth more than a nicer install prompt.
- **One splash colour.** A manifest carries a single `background_color` and
  `theme_color`. Ours are white, so a member in dark mode gets a white splash
  screen for the fraction of a second before the app paints. The manifest
  format has no mechanism for two.
- **Grey is a third value.** Hairlines, disabled text and skeletons are grey.
  Two colours plus grey is honestly three, and the discipline is that grey
  never *means* anything: it marks absence, never a category or a state that
  matters.
- **`content-visibility` and find-in-page.** Browsers can search inside
  skipped content, but the jump to a match in a card that has never been laid
  out can be abrupt. That is a platform behaviour we accept rather than fight.
- **No automated test covers this part.** The claims in section 8 were checked
  three ways, and it is worth being precise about which is which, because they
  are not equally strong.

  *Computed.* Every contrast ratio in section 8 comes from running the WCAG
  relative-luminance formula over the literal token values in `style.css`. That
  is arithmetic and it is exact.

  *Grepped.* "No colour outside the pictures" is a property of the files and is
  checked as one: every hex literal in `style.css` is `#000`, `#fff` or a grey
  with `R = G = B`, every `rgb()` is `rgb(0 0 0 / α)`, and every colour-bearing
  declaration resolves through a token. The same grep over `index.html` and the
  manifest finds only `#000000`/`#ffffff` in the `theme-color` meta tags and in
  the inline-SVG data URIs. The one remaining match in the stylesheet is the
  word `white` inside `white-space`.

  *Measured.* Some of it has now been rendered and measured rather than
  reasoned about, in one engine, at 320 × 720 and 1280 × 800, in both themes.
  What was measured: the column is 480 px and centred with the hairline showing
  above 560 px; nothing scrolls sideways at 320 px; `#post-heading` leaves 4 px
  of room on the left, the top and the bottom of `#post-author` — exactly
  `--ring-reach` — while still truncating and without moving the row, the text
  or `#post-state`; `#post-author` takes keyboard focus and matches
  `:focus-visible`; an empty `.error-slot` is 0 px tall and a filled one holds
  a toast inside the sheet's width; `.sheet__head` computes to `position:
  static` and does not move when `.sheet__body` is scrolled to its end; the
  document contains no `<time>` element and no `datetime` attribute; and the
  six `.session-total` nodes are one span in the button, one `<output>` outside
  it, three `<output>` inside dialogs and one span.

  *Read.* Everything else — hidden-state specificity, the disabled edges, the
  target sizes away from the two that were measured — is still verified by
  reading the markup and the cascade against the criteria. The 44 px figures
  are what the tokens and the box model say the boxes are.

  **What none of the four covers: whether a screen reader actually speaks.**
  Every live-region claim in section 8 — that the header meter announces, that
  the open sheet's mirror takes over, that a filled-then-inserted alert fires
  once, that a revealed-then-written banner is heard — is reasoned from the ARIA
  and HTML specifications and from well-documented behaviour, and confirmed only
  as far as the accessibility *tree* can be inspected from the DOM. It has not
  been listened to with NVDA, JAWS, VoiceOver or TalkBack. That is the largest
  unverified surface in this document, it is exactly where the last two rounds
  of defects lived, and it is the next thing worth doing.

  None of it is in `test/`.
