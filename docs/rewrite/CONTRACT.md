# MIDI Studio — shared design system + UI primitive contract

Everything in this document exists on disk in `renderer/shared/`. **If a primitive
is not in this document it does not exist** — do not invent a parallel one in a
tab stylesheet. If something is genuinely missing, it gets added here first.

Owned files:

| File | What it is |
|---|---|
| `renderer/shared/tokens.css` | palette, type scale, motion table, control metrics, density switch, global reset |
| `renderer/shared/ui.css` | the primitive component library |
| `renderer/shared/tokens.js` | `Tokens` — cached token reads |
| `renderer/shared/draw.js` | `Draw` — the one draw scheduler + HiDPI canvas + layer cache |
| `renderer/shared/vlist.js` | `VList` — virtualised list |
| `renderer/shared/bus.js` | `Bus`, `Transport`, `Commands` |
| `renderer/shared/fmt.js` | `Fmt` — formatting helpers |
| `renderer/shared/icons.js` | `Icon` — the one icon set (§9.2) |
| `renderer/shared/resize.js` | `Resize` — split-pane dividers (§9.3) |
| `renderer/shared/timeline-zoom.js` | `TimelineZoom` — the shared time-axis window (§9.4) |
| `renderer/shared/menu.js` | `Menu` — the context-menu controller (§9.5) |

---

## 0. How to load it

The CSS order is fixed. The cascade depends on it: `ui.css` restates a few
tokens.css rules, and a tab stylesheet must be able to beat both.

```html
<link rel="stylesheet" href="../shared/tokens.css" />
<link rel="stylesheet" href="../shared/ui.css" />
<link rel="stylesheet" href="forge.css" />
```

The scripts split into **required in every panel** and **per-tab optional**.
Take only what you use: a module you do not load is a module that cannot be a
per-frame cost.

```html
<!-- required, in this order -->
<script src="../shared/tokens.js"></script>
<script src="../shared/fmt.js"></script>
<script src="../shared/draw.js"></script>
<script src="../shared/bus.js"></script>
<script src="../shared/icons.js"></script>

<!-- optional, load the ones this tab actually uses -->
<script src="../shared/vlist.js"></script>          <!-- any long list -->
<script src="../shared/menu.js"></script>           <!-- any context menu -->
<script src="../shared/resize.js"></script>         <!-- any .split / grip -->
<script src="../shared/timeline-zoom.js"></script>  <!-- any time axis -->
<script src="../shared/hotkey.js"></script>         <!-- any hotkey capture box -->

<script src="forge.js"></script>
```

There are exactly **two** real ordering constraints:

* `draw.js` **before** `bus.js` — `bus.js` calls `Draw.setPlaybackActive` *if*
  `Draw` is present, and that is how the 30fps playback floor gets wired without
  any panel remembering to;
* `tokens.js` **before** `vlist.js` — `vlist.js` reads `--h-row` through
  `Tokens` *if* present, and otherwise silently defaults to 28px.

Everything else is independent. `icons.js`, `resize.js` and `menu.js` each
upgrade their own markup on `DOMContentLoaded`, so they may sit anywhere after
the elements they will touch are parsed (bottom of `<body>` is simplest).

`renderer/index.html` (the shell) loads the required five plus `vlist.js` for the
log drawer, and neither `resize.js` nor `timeline-zoom.js` nor `menu.js`: the
shell has no split, no time axis and no context menu. That is the pattern to
copy, not an omission.

Classic scripts, window globals — matching `renderer/index.html` and
`renderer/player/index.html`, which is what the CSP (`script-src 'self'`, no
inline handlers, no CDN) and the absence of a build step allow. Each module also
sets `module.exports` when one exists, so the same file loads under Node for
tests and as an ES-module side-effect import:

```js
import './shared/draw.js';        // sets globalThis.Draw
const { Draw } = globalThis;
```

---

## 1. tokens.css

### 1.1 What was added to the existing file

**Motion table** (the four durations and three curves, exactly as specified):

```css
--motion-instant: 80ms;   --motion-fast: 120ms;
--motion-normal: 170ms;   --motion-slow: 240ms;
--ease-standard: cubic-bezier(.2,.7,.2,1);   /* in-place state change */
--ease-enter:    cubic-bezier(.16,1,.3,1);   /* something arriving */
--ease-exit:     cubic-bezier(.4,0,1,1);     /* something leaving */
--dur: var(--motion-fast);  --dur-2: var(--motion-normal);  --ease: var(--ease-standard);
```

`--dur`, `--dur-2` and `--ease` are kept as aliases: every rule written before
this table still resolves.

**Control metrics.** Nothing hard-codes a control height any more. All of these
tighten under compact density:

`--h-ctl-sm` 26 · `--h-ctl` 32 · `--h-input` 34 · `--h-ctl-lg` 38 ·
`--h-ctl-xl` 44 · `--h-row` 28 · `--h-row-lg` 40 · `--h-toolbar` 40 ·
`--h-tabstrip` 34 · `--pad-ctl` 16 · `--pad-panel` = `--s4`

**Z ladder.** `--z-sticky` 5 · `--z-grip` 8 · `--z-pop` 40 · `--z-scrim` 60 ·
`--z-modal` 61 · `--z-toast` 80 · `--z-drop` 90. Nothing invents a z-index.

**Density switch.** `data-density="compact"` on `<html>`, mirrored into every
frame the same way `data-drawms` is. It moves the spacing scale, the control
ladder and `--t3`/`--t4` only. `--t1`/`--t2` hold at **12px/13px** in both
densities and `--text-3` (#868a92, the AA floor) never moves — the 8.5–11.5px
band this replaced was unreadable at 100% on a 1080p panel.

**Indeterminate progress is now a transform.** `@keyframes indet` animates
`translateX(-100% → 312%)`, not `margin-left`. `margin-left` is a layout
property, so the old version relayouted the bar and its ancestors on every frame
of an animation that can run for a whole download, and CSS animations are not
covered by the `data-drawms` budget.

**Determinate progress is now a transform too.** `.bar-fill` is full width and
scales: set `--p` to 0..1. Code that still writes `style.width` keeps working
through a `[style*="width"]` compat rule.

```html
<div class="bar" role="progressbar" aria-valuenow="42" aria-valuemin="0" aria-valuemax="100">
  <div class="bar-fill" style="--p:.42"></div>
</div>
```

**Unchanged invariants, verified still present:** `[hidden]{display:none!important}`
and `appearance:none` for `button[role=radio|checkbox|switch|tab]`.

### 1.2 Primitives already in tokens.css (still current, use them)

| Class | Note |
|---|---|
| `.btn` | default graphite button, height from `--bh` (= `--h-ctl`) |
| `.btn-primary` | the one lime GO control per view |
| `.btn-ghost` | transparent until hover |
| `.btn.big` | the 44px uppercase primary |
| `.link` | inline text action |
| `.input`, `input[type=text|number]` | recessed mono well, `--h-input` |
| `.card` | flat panel with padding (prefer `.panel`) |
| `.bar` / `.bar-fill` / `.bar-fill.indet` | progress track / fill (`--p`) / sweep |
| `.dot` `.dot.ok|.warn|.err` | 8px status dot |
| `.check` | native-checkbox row |
| `.seg` + `button[role=radio]` | the tall vertical radio block |
| `.lbl` | numbered `01 INPUT` section rail (auto-counter) |
| `.mono` `.muted` `.small` `.selectable` `.unselectable` | type utilities |
| `.ic` `[data-icon]` | icon slots — `Icon`, §9.2. The name list is closed: an unknown name renders **nothing** |
| `.grip-h` `.grip-v` | split-pane dividers — `Resize`, §9.3 |
| `body.is-resizing` | global pointer/selection suppression during a drag |

---

## 2. ui.css — the primitive library

Every interactive primitive has `:hover`, `:active`, `:focus-visible` and
`:disabled`. Transitions are 80–240ms from the motion table and only touch
`transform`, `opacity`, `color`, `background-color`, `border-color`.

Two pseudo-element caveats: `.btn.is-busy` and `.checkbox` use `::after`
themselves, so **do not put `data-tip` on those two** — use `.tip-panel` or a
wrapper instead.

### 2.1 Layout utilities

| Class | Use |
|---|---|
| `.u-row` / `.u-row.is-wrap` | horizontal flex, `--s2` gap, `min-width:0` |
| `.u-col` / `.u-col.is-tight` | vertical flex |
| `.u-spacer` | flexible gap that pushes the rest right |
| `.u-sep` / `.u-sep.is-h` | 1px rule between toolbar items / stacked blocks |
| `.u-truncate` `.u-nowrap` `.u-right` `.u-fill` | the four one-liners everything needs |
| `.u-hidden-visually` | screen-reader-only text |

### 2.2 Buttons

| Class | Use |
|---|---|
| `.btn-sm` / `.btn-lg` | size ladder off `--h-ctl-sm` / `--h-ctl-lg` |
| `.btn-danger` | destructive and hard to undo only |
| `.btn-icon` (+`.is-sm`, `.is-bare`) | square icon-only; **must** carry `aria-label` |
| `.btn[aria-pressed=true]`, `.btn.is-active` | toggle-on state (lime tint + accent border) |
| `.btn.is-busy` | label hidden, spinner in place, pointer-events off |
| `.btn-group` | joined bar of buttons sharing borders |

```html
<div class="btn-group">
  <button class="btn btn-sm" aria-pressed="true">Notes</button>
  <button class="btn btn-sm">Velocity</button>
</div>
<button class="btn btn-icon is-sm is-bare" aria-label="Remove from queue"><i data-icon="x"></i></button>
<button class="btn btn-primary">Forge MIDI</button>
```

### 2.3 Fields, inputs, selects, search

| Class | Use |
|---|---|
| `.field` (+`.is-row`) | label + control + hint/error stack |
| `.field-label` (`.req` inside) / `.field-hint` / `.field-error` | the three text parts |
| `.input.is-sm` / `.is-body` / `.is-invalid` | size, body font instead of mono, error border |
| `.textarea` | multi-line well |
| `.input-wrap` + `.input-affix` (+`.is-pre`) | a unit, glyph or button glued inside the well |
| `.search` + `.search-clear`, host gets `.has-value` | search field with leading glyph + clear |
| `.selectwrap` > `.select` (+`.is-well`, `.is-sm`) | native select, our caret (the wrapper owns the arrow) |
| `.range` | slider; set `--p` (0..1) on it for the filled track |

```html
<label class="field">
  <span class="field-label">Minimum note length <span class="req">*</span></span>
  <span class="input-wrap">
    <input class="input" type="number" value="45" />
    <span class="input-affix">ms</span>
  </span>
  <span class="field-hint">Empty means the engine default.</span>
</label>

<span class="selectwrap"><select class="select"><option>Balanced</option></select></span>
```

### 2.4 Number stepper

`.stepper` (+`.is-sm`) > `.stepper-btn` · `input[type=number]` · `.stepper-btn`,
optional `.stepper-unit`. The middle is a real number input, so typing, arrow
keys and OS spin gestures keep working.

```html
<span class="stepper">
  <button class="stepper-btn" aria-label="Decrease">−</button>
  <input type="number" value="120" aria-label="Tempo" />
  <button class="stepper-btn" aria-label="Increase">+</button>
</span>
```

### 2.5 Switch / checkbox / radio tiles / segmented / tabs

| Class | Markup contract |
|---|---|
| `.switch` | `button[role=switch][aria-checked]`; knob moves with `translateX` |
| `.switch-row` + `.switch-label` + `.switch-hint` (+`.is-off`) | the settings row a switch lives in |
| `.checkbox` | `button[role=checkbox][aria-checked=true|false|mixed]`; drawn box + tick |
| `.tiles` (+`.is-grid`) > `.tile` | `div[role=radiogroup]` > `button[role=radio][aria-checked]` |
| `.tile-title` `.tile-sub` `.tile-badge` | the three slots in a tile |
| `.segmented` (+`.is-sm`, `.is-wide`) | `div[role=radiogroup|tablist]` > `button[role=radio|tab]` |
| `.tabstrip` > `button[role=tab]` (+`.count`) | underline-accent tab strip; `.tabpanel` is the body |

The tile ring, the checkbox tick, the segment dot and the tab underline are all
real marks: **state is never colour alone**. Roving `tabindex` + arrow-key
navigation with wrap is the implementer's job; the CSS is ready for it.

```html
<div class="tiles" role="radiogroup" aria-label="Pipeline">
  <button class="tile" role="radio" aria-checked="true">
    <span class="tile-title">Balanced</span>
    <span class="tile-sub">Separate stems, then transcribe piano.</span>
    <span class="tile-badge">~4 min</span>
  </button>
  <button class="tile" role="radio" aria-checked="false">
    <span class="tile-title">Fast</span>
    <span class="tile-sub">Skip separation. Rougher on dense mixes.</span>
    <span class="tile-badge">~40 s</span>
  </button>
</div>

<div class="tabstrip" role="tablist">
  <button role="tab" aria-selected="true">Progress</button>
  <button role="tab" aria-selected="false">Queue <span class="count">3</span></button>
</div>
```

### 2.6 Panels, panel headers, inspector sections, toolbars

| Class | Use |
|---|---|
| `.panel` (+`.is-flat`, `.is-well`) | the standard bordered surface |
| `.panel-head` + `.panel-title` + `.panel-sub` + `.panel-tools` | header row, tools right |
| `.panel-body` (+`.is-flush`) | scrolling content, `--pad-panel` |
| `.panel-foot` | pinned footer |
| `.insp` > `.insp-sec` > `.insp-sec-head` + `.insp-sec-body` | the right rail; head is `button[aria-expanded]`, body uses `[hidden]` |
| `.insp-row` (+`.is-stacked`) + `.insp-label` + `.insp-value` | 88px label / control grid |
| `.toolbar` (+`.is-bottom`, `.is-sub`) | `--h-toolbar` bar |
| `.toolbar-group` `.toolbar-sep` `.toolbar-spacer` `.toolbar-label` | its parts |

```html
<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Waveform</h2>
    <div class="panel-tools"><button class="btn btn-icon is-sm is-bare" aria-label="Reset zoom">…</button></div>
  </header>
  <div class="panel-body is-flush"><div class="canvas-host"><canvas></canvas></div></div>
</section>

<div class="insp-sec">
  <button class="insp-sec-head" aria-expanded="true" aria-controls="adv">Advanced</button>
  <div class="insp-sec-body" id="adv">
    <div class="insp-row"><span class="insp-label">Threads</span><span class="insp-value">12</span></div>
  </div>
</div>
```

### 2.7 List rows and the virtualised host

| Class | Use |
|---|---|
| `.list` (+`.is-scroll`) | plain (non-virtual) row container |
| `.lrow` | one row: `min-height:--h-row`, hover tint |
| `.lrow.is-selected` / `[aria-selected=true]` | tinted background **and** a 2px lime left indicator |
| `.lrow.is-playing` | same treatment, for the row currently sounding |
| `.lrow.is-cursor` | keyboard cursor without selection |
| `.lrow.is-lg` / `.is-disabled` | two-line row / dimmed |
| `.lrow-index` `.lrow-icon` `.lrow-main` (`.lrow-name`, `.lrow-sub`) `.lrow-meta` `.lrow-actions` | slots; actions fade in on hover/focus-within/selected |
| `.vlist` `.vlist-sizer` `.vlist-row` | the host that `vlist.js` drives — do not hand-write these |
| `.lgrid` > `.lgrid-head` > `.lgrid-th` + `.lrow.is-grid` > `.lcell` | a **sortable column table made of virtualised rows** — see below |

**`.lrow.is-lg` and `rowHeight` are one decision, not two.** `VList` positions
every row from `rowHeight` alone, so `.is-lg` (`--h-row-lg`, 40px / 34px compact)
**requires** `rowHeight: Tokens.num('h-row-lg')`. A mismatch does not clip
anything — it silently mis-positions every row by a growing offset. Density moves
both tokens, so re-read and call `list.rowHeight(h)` on `midi-studio:density`.

**The column table.** `.table` (§2.8) is for a short, hand-built table; rule 5
forbids hand-built rows for a long list, so a few thousand files go through
`VList`, which renders `div` rows. The columns therefore live in **one** grid
template, `--cols`, declared on the `.lgrid` host and inherited by the sticky head
and every row:

```html
<div class="lgrid" style="--cols: minmax(180px,3fr) 76px 72px 88px 120px 1fr">
  <div class="lgrid-head" role="presentation">
    <div class="lgrid-th" aria-sort="ascending">
      <button class="th-sort" aria-label="Sort by name, ascending">Name</button></div>
    <div class="lgrid-th is-num"><button class="th-sort" aria-label="Sort by length">Length</button></div>
    <div class="lgrid-th is-num"><button class="th-sort" aria-label="Sort by notes">Notes</button></div>
    <div class="lgrid-th"><button class="th-sort" aria-label="Sort by source">Source</button></div>
    <div class="lgrid-th"><button class="th-sort" aria-label="Sort by date added">Date added</button></div>
    <div class="lgrid-th"><button class="th-sort" aria-label="Sort by tags">Tags</button></div>
  </div>
  <div class="vlist"></div>          <!-- VList fills this -->
</div>
```

```js
createRow() {
  const n = document.createElement('div');
  n.className = 'lrow is-grid';
  n.innerHTML = '<span class="lcell"></span><span class="lcell is-num"></span>' +
                '<span class="lcell is-num"></span><span class="lcell is-dim"></span>' +
                '<span class="lcell is-dim"></span><span class="lcell is-dim"></span>';
  return n;
}
```

Rules for it:

* Set `--cols` **once**, on the `.lgrid`. Never per row — that is a style write
  per row per render.
* `[aria-sort]` on the `.lgrid-th` drives the caret (the ARIA is still the look).
  The head is `role="presentation"` because `VList` rows are listbox `option`s and
  a `columnheader` outside a real grid is ignored by assistive tech; the spoken
  state lives in each `button`'s `aria-label`, which you rewrite when the order
  changes. Give each row an `aria-label` too, or the option's name is a run-on of
  its cells.
* **Sort once per order change, not per render.** `renderRow` must never sort,
  compare or format anything it could have been handed. Sort the array, then
  `setItems(sorted)`.
* `.lcell.is-num` right-aligns and switches to tabular mono; `.is-dim` is
  `--text-3`; `.is-stack` is the two-line cell (pair it with `.lrow.is-lg` **and**
  the matching `rowHeight`).

```html
<div class="vlist" data-role="library"></div>   <!-- vlist.js fills it -->

<!-- what createRow() should build -->
<div class="lrow">
  <span class="lrow-icon"><i data-icon="note"></i></span>
  <span class="lrow-main">
    <span class="lrow-name">Clair de Lune.mid</span>
    <span class="lrow-sub">piano · 4:32</span>
  </span>
  <span class="lrow-meta">2 days ago</span>
  <span class="lrow-actions">
    <button class="btn btn-icon is-sm is-bare" data-action="play" aria-label="Play">▶</button>
  </span>
</div>
```

### 2.8 Data table

**Short tables only.** A list that can reach a few hundred rows belongs in the
`.lgrid` column-row variant in §2.7, not here: `.table` needs hand-built `<tr>`s,
which rule 5 forbids for a long list. `.table` and `.lgrid` are alternatives —
never nest one in the other.

`.table-scroll` > `.table` (+`.is-dense`). Header cells are
`th[aria-sort="none|ascending|descending"]` containing `button.th-sort`; the
caret is drawn from the `aria-sort` value, so the ARIA **is** the state. `.is-num`
on a `th`/`td` right-aligns and switches to mono. Selected rows get
`aria-selected="true"` plus a lime inset bar on the first cell. The head is
sticky.

```html
<div class="table-scroll">
  <table class="table">
    <thead><tr>
      <th aria-sort="ascending"><button class="th-sort">Name</button></th>
      <th class="is-num"><button class="th-sort">Length</button></th>
    </tr></thead>
    <tbody><tr aria-selected="true"><td>Clair de Lune.mid</td><td class="is-num">4:32</td></tr></tbody>
  </table>
</div>
```

### 2.9 Tags, chips, path chips, kbd, hotkey slot

| Class | Use |
|---|---|
| `.tag` (+`.is-accent|.is-warn|.is-err|.is-bare`) | small uppercase mono label |
| `.chip` (+`.is-accent`) + `.chip-text` + `.chip-x` | removable chip |
| `.pathchip` (+`.is-missing`) + `.pathchip-dir` + `.pathchip-name` + `.pathchip-reveal` | file path: directory dimmed and clipped from the left, basename kept whole, full path in `title`, reveal-in-folder button |
| `.kbd`, `.kbd-seq` | key cap / key sequence |
| `.hk` (+`.is-empty`, `.is-capturing`) + `.hk-slot` + `.hk-clear` | hotkey capture widget. Empty means **unbound**, and focusing it must suspend global hotkeys |

```html
<span class="pathchip" title="C:\Users\me\Music\Clair de Lune.mid">
  <span class="pathchip-dir">C:\Users\me\Music\</span>
  <span class="pathchip-name">Clair de Lune.mid</span>
  <button class="pathchip-reveal" aria-label="Show in folder">↗</button>
</span>
<span class="kbd-seq"><kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">K</kbd></span>
```

### 2.10 Status pills and dots

`.pill` (+`.is-ok|.is-warn|.is-err|.is-blocked`), normally containing a `.dot`
and **a word**. Live treatments: `.dot.is-paused` blinks (opacity),
`.dot.is-blocked` pulses (scale), `.dot.is-live` is lime. Both animations are
transform/opacity only and stop the moment the state leaves — nothing animates
while the app is idle.

```html
<span class="pill is-ok"><span class="dot ok"></span>Engine ready</span>
<span class="pill is-blocked"><span class="dot is-blocked"></span>Blocked</span>
```

### 2.11 Progress and meters

| Class | Use |
|---|---|
| `.bar` (+`.is-sm`, `.is-lg`, `.is-warn`, `.is-err`) | track |
| `.bar-fill` | fill; set `--p` 0..1. `.indet` for the sweep |
| `.bar-row` + `.bar-pct` | bar with a right-aligned integer percent |
| `.meter` (+`.is-v`) + `.meter-fill` + `.meter-peak` + `.meter-scale` | level meter; `--p` 0..1 fill, `--peak` 0..1 hold marker |

Write the percent label **only on an integer change**. Both fills are `scaleX`
/`scaleY`, so a 20Hz progress stream costs nothing.

### 2.12 Tooltips

`data-tip="text"` on any element (`.tip-below`, `.tip-left` to reposition) shows
on hover **and** `:focus-visible`. For anything needing measurement or a rich
body, use `.tip-panel` + `.is-open` and position it from JS.

### 2.13 Context menus

**Do not place one yourself — `Menu.open()` (§9.5) owns this.** It does the
viewport flipping, the outside-click and Escape dismissal, the arrow-key roving,
the focus return and `aria-activedescendant`. These classes are its output; they
are documented because a tab may want to restyle a slot, not because a tab should
drive them.

`.menu` (+`.is-open`) `role="menu"`, `position:fixed`, placed from JS.
Children: `.menu-label`, `.menu-item` (+`.is-danger`, `.is-cursor`,
`[aria-checked=true]`, `:disabled`) containing `.menu-text` and `.menu-key`,
`.menu-sep`, and `.menu-scroll` for a long list.

```html
<div class="menu is-open" role="menu">
  <button class="menu-item" role="menuitem"><span class="menu-text">Play</span><span class="menu-key">Enter</span></button>
  <div class="menu-sep"></div>
  <button class="menu-item is-danger" role="menuitem"><span class="menu-text">Delete file</span></button>
</div>
```

### 2.14 Modals and sheets

`.dlg-scrim` (+`.is-open`, `.is-sheet`) > `.dlg` (+`.is-wide`, `.is-narrow`,
`.is-sheet`) > `.dlg-head` (`.dlg-title`, `.dlg-sub`, `.dlg-x`) · `.dlg-body`
(+`.is-flush`) · `.dlg-foot`.

Named `.dlg-*` deliberately: the shell's legacy `.modal-*` / `.modal-scrim` rules
still exist and this must not collide with them. The scrim is `display:flex`,
which is exactly why `[hidden]{display:none!important}` must stay in the token
layer — toggle with `el.hidden`, never `style.display`. Implementer still owns
`aria-modal`, focus trap, Escape precedence, body scroll lock, and (while
iframes remain) hiding the sibling panel, because an iframe composites above a
fixed overlay.

### 2.15 Toasts

`.toasts` (fixed, bottom-right, above the transport) > `.toast`
(+`.is-ok|.is-warn|.is-err`) with `.toast-body` (`.toast-title`, `.toast-msg`),
`.toast-count` for a dedupe counter, `.toast-x` to dismiss. Add `.is-in` before
insertion and remove it on the next frame to animate in; add `.is-out` and
remove after `--motion-fast` to animate out.

### 2.16 Drop overlay

Window-level: keep a dragenter/dragleave **depth counter**, set
`data-drop="on"` on `<html>` or the host, and `.drop-veil` > `.drop-card`
(`.drop-icon`, `.drop-title`, `.drop-sub`, `.drop-types`) fades in. A panel that
accepts a drop locally uses `.dropzone` + `.is-over` (border + tint) rather than
a full-screen veil.

### 2.17 Empty / loading / error state, skeletons

| Class | Use |
|---|---|
| `.state` (+`.is-error`, `.is-loading`, `.is-compact`) | the one empty/loading/error block for all five tabs |
| `.state-icon` `.state-title` `.state-msg` `.state-actions` | its slots |
| `.inline-error` | a failure attached to one panel or control |
| `.inline-note` | a neutral note in the same shape |
| `.skel` > `.skel-row` > `.skel-bar` (+`.is-sm`, `.is-fill`, `--w`) | loading rows; the sweep is a `translateX` on a pseudo-element and only ever on screen while something is genuinely loading |

### 2.18 Split panes, scroll containers, canvas hosts

| Class | Use |
|---|---|
| `.split` (+`.is-v`) > `.pane` (+`.is-fixed`, `.is-flex`) | the layout host around a `resize.js` grip. **`.is-fixed` is only `flex:0 0 auto` — the pane itself must consume the custom property the grip drives** (`style="width:var(--side)"`, or `height` on a `.split.is-v`). See §9.3 |
| `.grip-h.is-dragging` / `.grip-v.is-dragging` | lime line while dragging |
| `.grip-h.has-handle` / `.grip-v.has-handle` | dotted grab affordance on hover |
| `.scroll` `.scroll-y` `.scroll-x` (+`.is-thin`) `.no-scrollbar` | scroll containers with `overscroll-behavior:contain` |
| `.canvas-host` > `canvas` | viewport-sized canvas, absolutely filled |
| `.canvas-scroll` > `.canvas-extent` | **the scroll wrapper supplies the extent.** A five-minute song at default zoom is ~24,000px, past Chromium's 16,384px canvas limit, and the tail simply never drew. Nothing sets a canvas width/height in CSS — `Draw.fitCanvas` owns the backing store |

---

## 3. tokens.js — `window.Tokens`

Kills `getComputedStyle` from every paint loop (top_perf_items 1, 9, 15). Read
once, cached, re-read only when the theme actually changes.

| Signature | Returns |
|---|---|
| `Tokens.get(name, fallback?)` | token string; `name` with or without leading `--`. Unknown names are read live once, then cached |
| `Tokens.num(name, fallback?)` | `parseFloat` of the token (`'28px'` → `28`) |
| `Tokens.ms(name, fallback?)` | duration token in ms (`'120ms'` → `120`, `'0.2s'` → `200`) |
| `Tokens.rgba(name, alpha)` | `'rgba(184,230,46,0.5)'`, cached per name+alpha |
| `Tokens.mix(nameA, nameB, t)` | linear blend, `'rgb(r,g,b)'` |
| `Tokens.parseColor(value)` | `[r,g,b,a]` from `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` |
| `Tokens.all()` | plain snapshot object of every known token |
| `Tokens.refresh()` | drop the cache, bump the version, notify; returns the version |
| `Tokens.onChange(fn)` | `fn(version)` on theme change; returns an unsubscribe |
| `Tokens.version()` | integer, bumped on every refresh |
| `Tokens.themeKey()` | `'lime:normal:v3'` — fold into a `LayerCache` version so a theme change repaints cached layers |
| `Tokens.NAMES` | the batch-read token list |

Invalidation events (any of them, on `window` or `document`):
`midi-studio:theme`, `midi-studio:accent`, `midi-studio:density`. The re-read is
**lazy**: 35 `setProperty` writes during a colour drag cost one read on the next
`get()`, not 35.

```js
const accent = Tokens.get('accent');            // in setStyle(), not in the loop
const dim    = Tokens.rgba('text-3', .35);
Tokens.onChange(() => { rebuildGradients(); layer.invalidate(); });
```

---

## 4. draw.js — `window.Draw`

### 4.1 The budget: three inputs, never compounded

```
1. user budget       <html data-drawms="16">        ms per frame
   game raise        <html data-game="1">           x3 — a RAISE only, never a lower
                     <html data-game-raised="1">    data-drawms ALREADY includes the x3
2. unfocused penalty (automatic)                    max(ms, 250) — a clamp, never a product
3. playback floor    Draw.setPlaybackActive(true)   min(ms, min(base, 33)) — beats both
   parked            data-onscreen="0" | document.hidden | element not intersecting  → Infinity
```

Verified by test: `base 16 + game + unfocused = 250` (not 384, not latched), and
with playback live it becomes `16`. `base 100 + playback = 33`.

`data-game-raised="1"` exists because today's shell stamps a pre-tripled
`data-drawms`; with that attribute present `Draw` does not triple it again.
**Preferred for the new shell:** stamp the user's base in `data-drawms` and
`data-game="1"` separately, and let `Draw` apply the raise.

### 4.2 Scheduler API

| Signature | Notes |
|---|---|
| `Draw.register({key, draw, el?, idleMs?, live?})` → handle | `draw(ts, consumer)`. `el` is observed with one shared `IntersectionObserver`: an off-screen consumer never draws. `idleMs` defaults 250 |
| `handle.invalidate()` | ask for a frame. The **only** way to draw |
| `handle.setLive(bool)` | true while animating (playback, a drag): drops the idle clamp |
| `handle.setIdle(ms)` / `handle.setElement(el)` / `handle.isDirty()` / `handle.isVisible()` / `handle.dispose()` | |
| `Draw.invalidate(key?)` / `Draw.invalidateAll()` | by key, or everything |
| `Draw.frame()` | draw everything dirty **synchronously now** (resize, divider commit) |
| `Draw.budgetMs()` | current effective interval; `Infinity` when parked |
| `Draw.onBudgetChange(fn)` → unsubscribe | `fn(ms)` |
| `Draw.setPlaybackActive(bool)` | input 3. **`bus.js` already calls this from transport status in every document — a panel must not call it too.** Two writers means the floor turns on and off against each other; if you think you need it, you want `handle.setLive(true)` on your own consumer |
| `Draw.setGameActive(bool)` | input 1b. Raise only, never latches, survives an attribute re-read. **Shell/Perch only**: inside the shell a game is announced with `data-game="1"`, and a panel that also sets this fights the stamp |
| `Draw.setBaseMs(ms|null)` / `Draw.setOnscreen(bool|null)` | for a page with no shell above it (Perch). Both are local overrides that survive an attribute re-read; `null` hands control back to `data-drawms` / `data-onscreen` |
| `Draw.isOnscreen()` / `isPlaybackActive()` / `isGameActive()` / `refresh()` / `stats()` / `now()` | `stats()` returns `{consumers, dirty, budgetMs, baseMs, focused, onscreen, playback, gameActive, frames, lastFrameMs}` |
| `Draw.GAME_RAISE` 3 · `UNFOCUSED_MS` 250 · `PLAYBACK_FLOOR_MS` 33 · `IDLE_MS` 250 | exported so nothing re-guesses them |

`Draw.register` with a key that is already registered **replaces** the previous
consumer (it disposes it first), so re-initialising a panel view is safe and does
not need a manual teardown.

Two of these are yours only if no shell is above you. Inside a frame, the shell
owns inputs 1, 1b and the visibility flag, and `bus.js` owns input 3; the only
Draw calls a panel makes are `register`, `invalidate`, `setLive`, `dispose` and
the canvas helpers.

The scheduler runs **at most one rAF**, calls only dirty consumers, and arms
**nothing at all** when nothing is dirty or the panel is off-screen. It resumes
on `midi-studio:onscreen`, `visibilitychange`, `focus`/`blur`, and a
`MutationObserver` on `data-drawms` / `data-onscreen` / `data-game`. Coming back
on screen repaints everything once, so a stale canvas cannot survive a tab
switch. A throwing consumer is logged, not fatal to the others.

```js
const h = Draw.register({ key: 'player:viz', el: host, draw: () => {
  const { ctx, w, h: hh, resized } = Draw.fitCanvas(canvas, host.clientWidth, host.clientHeight);
  if (resized) layer.invalidate();
  layer.paint(w, hh, notesVersion + '|' + zoomKey + '|' + Tokens.themeKey(), paintStatic);
  layer.blit(ctx, 0, 0);
  drawPlayhead(ctx);
}});
h.setLive(true);
h.invalidate();
```

### 4.3 Canvas helpers

| Signature | Returns |
|---|---|
| `Draw.fitCanvas(canvas, cssW, cssH, opts?)` | `{ctx, dpr, w, h, pxW, pxH, resized}`. `dpr = min(devicePixelRatio, 2)`, re-read per call. **Reallocates the backing store only when the pixel size actually changed** (assigning `width`/`height` reallocates and clears even for an identical value, and doing it per frame stalls playback). Sets `style.width/height` unless `opts.style === false`; `opts.contextAttributes` passes through; always restates `setTransform(dpr,0,0,dpr,0,0)`, so you draw in CSS pixels |
| `Draw.measure(el)` | `{w,h,left,top}` from one `getBoundingClientRect` — cache it for a whole gesture |
| `Draw.dpr()` | `min(devicePixelRatio, 2)` |

### 4.4 `Draw.LayerCache`

Offscreen static layer (background, grid, peaks, note bars, onset ticks) +
per-frame blit.

| Signature | Notes |
|---|---|
| `new Draw.LayerCache({alpha?, offscreen?})` | uses `OffscreenCanvas` when available |
| `.paint(cssW, cssH, version, paintFn)` → `{canvas, repainted}` | repaints only when `w x h @ dpr # version` changed. `paintFn(ctx, {w,h,dpr,version})` gets a cleared surface already in CSS pixels |
| `.blit(ctx, x?, y?, w?, h?)` | draw onto a destination context that is already in CSS-pixel space |
| `.isValid(cssW, cssH, version)` / `.invalidate()` / `.dispose()` | `dispose()` zeroes the backing store, which is what frees the pixels |
| `.repaints` | counter, for a perf check |

`version` is a caller-supplied string: fold in the data version, the zoom
window, and `Tokens.themeKey()`.

---

## 5. vlist.js — `window.VList`

`VList(host, opts)` (or `VList.create`). Renders only the visible window plus
overscan, reuses row nodes, and installs **one** click, **one** contextmenu,
**one** dblclick and **one** keydown listener on the host, keyed by
`data-index`. Verified: 5000 rows allocate 23 nodes total and never allocate
again however far you scroll.

**Options**

| Option | Default | Note |
|---|---|---|
| `rowHeight` | `--h-row` (28) | must be uniform, and must match the row class: `.lrow.is-lg` is `--h-row-lg`, so pass `Tokens.num('h-row-lg')`. A mismatch mis-positions every row (see §2.7) |
| `overscan` | 6 | rows above and below |
| `createRow()` | a bare `div` | build the node **once**; called only when the pool grows |
| `renderRow(node, item, index, state)` | — | fill it. `state` is `{key, selected, cursor}`. Called only when the row shows a different index or the data version moved |
| `key(item, index)` | `item.path ?? item.id ?? index` | selection is by key, so a re-sort keeps the selection |
| `items` | `[]` | |
| `selectable` | `true` | `'multi'` for multi-select, `false` for none |
| `ariaLabel` | — | set on the host |
| `onClick(item, index, ev)` | | after selection has been applied |
| `onActivate(item, index, ev)` | | dblclick and Enter |
| `onContextMenu(item, index, ev)` | | right-click; a row outside the selection is selected first |
| `onAction(action, item, index, ev)` | | a click on any `[data-action]` inside the row, selection untouched |
| `onSelectionChange(keys, items)` | | |
| `onCursor(item, index)` / `onRender(first, last)` | | |

**Methods**

`setItems(items, {keepSelection=true, scrollTop})` · `updateItem(index, item?)` ·
`refresh()` · `invalidate()` · `paintNow()` · `rowHeight(h?)` ·
`length` (getter) · `items()` · `itemAt(i)` · `nodeAt(i)` (null when off-screen) ·
`range()` → `[first,last)` · `selection()` → keys · `selectedItems()` ·
`selectKeys(keys, silent?)` · `selectIndex(i, mode, silent?)` where mode is
`'set'|'toggle'|'range'|'add'` · `selectAll(silent?)` · `clearSelection(silent?)` ·
`indexOfKey(key)` · `cursor()` · `setCursor(i, {scroll})` ·
`scrollToIndex(i, 'nearest'|'center'|'start')` · `scrollToKey(key, align)` ·
`focus()` · `destroy()` · `host`

**Keyboard** (listbox pattern): Up/Down, PageUp/PageDown, Home/End,
Shift+move extends a range, Ctrl/Cmd+move moves the cursor without touching the
selection, Space toggles, Enter activates, Escape clears, Ctrl/Cmd+A selects all.

Rows carry `role="option"`, `aria-selected`, `aria-posinset`, `aria-setsize`; the
host is `role="listbox"` + `aria-multiselectable`.

**Density.** `--h-row` and `--h-row-lg` both change on `data-density`, and a list
built before the change keeps the old number. Re-read and re-apply:

```js
window.addEventListener('midi-studio:density', () => {
  list.rowHeight(Tokens.num(big ? 'h-row-lg' : 'h-row'));
});
```

**`onContextMenu(item, index, ev)`** is where a row menu goes; open it with
`Menu.open(...)` (§9.5). Call `ev.preventDefault()` yourself — `VList` does not,
because a panel may want the platform menu on some rows.

```js
const list = VList(document.getElementById('library'), {
  rowHeight: 28, selectable: 'multi', ariaLabel: 'Library',
  createRow() { const n = document.createElement('div'); n.className = 'lrow';
    n.innerHTML = '<span class="lrow-main"><span class="lrow-name"></span>' +
                  '<span class="lrow-sub"></span></span><span class="lrow-meta"></span>';
    return n; },
  renderRow(n, it) {
    n.children[0].children[0].textContent = it.name;
    n.children[0].children[1].textContent = it.folder;
    n.children[1].textContent = Fmt.when(it.mtime);
  },
  key: it => it.path,
  onActivate: it => Bus.send(Bus.TYPES.NAV_OPEN_PLAYER, { midiPath: it.path, play: true })
});
list.setItems(files);
```

---

## 6. bus.js — `window.Bus`

One envelope, verified twice on every receive:

```js
{ ns: 'midi-studio', v: 1, kind: 'event'|'request'|'response',
  type: '<Bus.TYPES value>', payload: {...}, id?: number, error?: string }
```

1. **origin** must equal `location.origin`. A `file:` page has an opaque origin,
   so `'null'` and `''` are accepted **only** when we are ourselves `file:`.
2. **source** must be a window we know: our `parent`/`top`, or an iframe
   explicitly trusted with `Bus.trustFrame()`.

Anything else is dropped silently, as is any `type` not in `Bus.TYPES`. Payloads
are data: a handler reads named fields and never spreads an envelope into an
argument list. (The old router did neither check and used the whole payload
object as its arguments object.)

| Signature | Notes |
|---|---|
| `Bus.send(type, payload, {to, local})` → number of windows posted | `to`: `'parent'`/`'shell'`, `'frames'`, `'all'`, an `<iframe>`, or a `Window`. Default `'frames'` in the top window, `'parent'` inside a panel. `local:true` also runs this document's own handlers |
| `Bus.on(type, handler)` → unsubscribe | `handler(payload, meta)`, `meta = {type, source, origin, local, reply(payload)}` |
| `Bus.once(type, handler)` → unsubscribe | |
| `Bus.request(type, payload, {to, timeout=5000})` → Promise | resolves with the responder's return value, rejects on timeout |
| `Bus.respond(type, handler)` → unregister | the one handler that answers requests of that type; may return a Promise |
| `Bus.trust(win)` / `Bus.untrust(win)` / `Bus.trustFrame(iframe)` → untrust fn | `trustFrame` re-trusts after every navigation of that frame |
| `Bus.frames()` | the trusted window list |
| `Bus.installRelay()` | **shell only.** Forwards the `Bus.RELAY` types to every frame except the sender. `Transport.host()` calls it for you |
| `Bus.isTop()` / `Bus.TYPES` / `Bus.ALIASES` / `Bus.RELAY` / `Bus.NS` / `Bus.targetOrigin` | |

Relayed types (audience = everybody but the sender): `transport:state`,
`transport:owner`, `library:changed`, `ui:theme`, `ui:density`, `ui:perf`,
`game:active`.

Legacy aliases still accepted on receive and rewritten:
`studio:open-player` → `nav:open-player`, `studio:open-audition` →
`nav:open-selfmidi`, `studio:open-review` → `nav:open-editor`.

### 6.1 The complete message-type list

**Navigation / hand-off**

| Constant | Type | Payload |
|---|---|---|
| `NAV_ACTIVATE` | `nav:activate` | `{tab:'forge'\|'review'\|'player'\|'audition'\|'library', focus?:boolean}` |
| `NAV_ACTIVATED` | `nav:activated` | `{tab, previous}` |
| `NAV_OPEN_FORGE` | `nav:open-forge` | `{inputPath?:string, url?:string}` |
| `NAV_OPEN_EDITOR` | `nav:open-editor` | `{projectPath?:string, midiPath?:string}` |
| `NAV_OPEN_PLAYER` | `nav:open-player` | `{midiPath?:string, play?:boolean}` |
| `NAV_OPEN_SELFMIDI` | `nav:open-selfmidi` | `{midiPath?:string, play?:boolean}` |
| `NAV_OPEN_LIBRARY` | `nav:open-library` | `{selectPath?:string, query?:string}` |

**Frame lifecycle**

| Constant | Type | Payload |
|---|---|---|
| `FRAME_READY` | `frame:ready` | `{frame:string, title?:string}` |
| `FRAME_ONSCREEN` | `frame:onscreen` | `{frame:string, on:boolean}` |
| `FRAME_BUSY` | `frame:busy` | `{frame:string, busy:boolean, label?:string, percent?:number}` — `percent` 0..100 puts a progress row on the activity strip; without one the label is only logged (§11.3) |

**Files / library**

| Constant | Type | Payload |
|---|---|---|
| `FILE_OPEN` | `file:open` | `{path:string, kind:'audio'\|'mid'\|'project'\|'json', from?:string}` |
| `FILE_DROPPED` | `file:dropped` | `{paths:string[], kind:string, frame?:string}` |
| `FILE_REVEAL` | `file:reveal` | `{path:string}` |
| `LIBRARY_CHANGED` | `library:changed` | `{reason?:string}` |
| `LIBRARY_SELECT` | `library:select` | `{path:string}` |

**Transport**

| Constant | Type | Payload |
|---|---|---|
| `TRANSPORT_CLAIM` | `transport:claim` | `{owner:'player'\|'selfmidi'\|'editor', caps:{seek?,rate?,loop?,queue?}}` |
| `TRANSPORT_RELEASE` | `transport:release` | `{owner}` |
| `TRANSPORT_OWNER` | `transport:owner` | `{owner:string\|null, previous:string\|null}` |
| `TRANSPORT_PARK` | `transport:park` | `{owner}` — sent to the OUTGOING owner |
| `TRANSPORT_COMMAND` | `transport:command` | `{action:'play'\|'pause'\|'stop'\|'toggle'\|'seek'\|'rate'\|'loop'\|'next'\|'prev', value?:number\|{a,b}\|null}` |
| `TRANSPORT_STATE` | `transport:state` | `{owner, status, position, duration, rate, loop:{a,b}\|null, label, dirty, caps}` |
| `TRANSPORT_QUERY` | `transport:query` | `{}` → responds with the state snapshot |

**Commands**

| Constant | Type | Payload |
|---|---|---|
| `COMMAND_PUBLISH` | `command:publish` | `{scope:string, commands:[{id,label,keywords,scope,group,keys,danger,enabled}]}` |
| `COMMAND_WITHDRAW` | `command:withdraw` | `{scope:string, ids?:string[]}` |
| `COMMAND_RUN` | `command:run` | `{id:string, arg?:any}` |
| `COMMAND_RESULT` | `command:result` | `{id:string, ok:boolean, error?:string}` |

**Shell chrome / app-wide**

| Constant | Type | Payload |
|---|---|---|
| `UI_TOAST` | `ui:toast` | `{severity:'info'\|'ok'\|'warn'\|'err', title:string, message?:string, key?:string, timeout?:number}` |
| `UI_STATUS` | `ui:status` | `{frame:string, text:string, severity?:'info'\|'ok'\|'warn'\|'err'}` — the **same four words as `UI_TOAST`**, and `'err'` is spelt `'err'`. Anything else is shown as info |
| `UI_PALETTE` | `ui:palette` | `{open:boolean, query?:string}` |
| `UI_SETTINGS` | `ui:settings` | `{open:boolean, pane?:string}` |
| `UI_SHORTCUT` | `ui:shortcut` | `{id:string}` |
| `UI_THEME` | `ui:theme` | `{theme:string, accent?:string}` |
| `UI_DENSITY` | `ui:density` | `{density:'normal'\|'compact'}` |
| `UI_PERF` | `ui:perf` | `{drawMs:number, percent:number, gameActive:boolean, whenGaming:string}` |

**Main-process events, mirrored into every frame by the shell**

| Constant | Type | Payload |
|---|---|---|
| `ENGINE_EVENT` | `engine:event` | `{event:string, ...}` — the sidecar payload verbatim |
| `ENGINE_ERROR` | `engine:error` | `{message:string}` |
| `FORGE_STATUS` | `forge:status` | `{stage?, percent?, ...}` |
| `GAME_ACTIVE` | `game:active` | `{name:string}` (empty string = no game) |
| `UPDATE_STATUS` | `update:status` | `{state:string, percent?, version?, staged?}` |
| `OVERLAY_STATE` | `overlay:state` | `{open:boolean, bounds?:{x,y,w,h}}` |

**Diagnostics**

| Constant | Type | Payload |
|---|---|---|
| `PING` | `bus:ping` | `{}` → `{t:number}` (a responder is registered by default) |
| `PONG` | `bus:pong` | `{t:number}` |

**One severity vocabulary, two spellings — know which is which.**

| Where | Values |
|---|---|
| `UI_TOAST.severity`, `UI_STATUS.severity` | `info` · `ok` · `warn` · **`err`** |
| the shell's log drawer, internally, and `FORGE_STATUS`'s `forge.log` `level` | `info` · `ok` · `warn` · **`error`** |

The bus surface is the short one. A panel that sends `severity:'error'` is not
rejected — it is silently shown as **info**, which is the bug this table exists to
prevent. The log's `error` level is what auto-opens the drawer and increments the
error badge; only `forge:status` speaks it directly.

---

## 7. The transport-owner protocol — `window.Transport`

Exactly **one** of `'player' | 'selfmidi' | 'editor'` owns the bottom transport
at a time; the other two park. Two owners means two clocks and two Space
handlers fighting over one keypress.

**Those three are the whole list.** `Transport.claim` throws for anything else,
including `'library'` and `'forge'`. Both of those tabs still have audio and a
time axis, and both are **local** playback, not the global transport:

* Forge's waveform scrub previews the input file. Local, not the bottom bar.
* A Library row preview auditions a file under the pointer. Local, not the bottom
  bar, and it must **stop the moment the real owner starts** — subscribe with
  `Transport.onChange` and stop your local audio when `snapshot.status` becomes
  `playing` or `counting`.

A local preview owns no `caps`, publishes no `<owner>.*` commands, and never
reports `transport:state`. If you find yourself wanting a fourth owner name, what
you want is a local preview.

```
STATUS = idle | playing | paused | blocked | counting
         blocked  = cannot play (no engine, no file, env not ready)
         counting = count-in / lead-in before notes start
```

### 7.1 Protocol

1. The shell calls `Transport.host()` **once**. That installs the registry and
   `Bus.installRelay()`.
2. A panel calls `Transport.claim(owner, impl, caps)`. The host records it,
   sends `transport:park` to the **outgoing** owner, then broadcasts
   `transport:owner` to every frame.
3. The parked panel's `impl.park()` runs. It must stop its clock, release Space,
   and stop reporting state. Both the outgoing frame (via `transport:park`) and
   every frame (via `transport:owner`) get told, so a panel cannot miss it.
4. Only the current owner may report state. A `transport:state` whose `owner`
   is not the current owner is dropped — a winding-down panel cannot keep
   writing position into a transport that now belongs to somebody else.
5. Anyone may drive the transport (`Transport.play()`, the bottom bar, a hotkey,
   the palette). The call runs `impl` directly when this document is the owner,
   otherwise the host routes `transport:command` to the owning frame.
6. `bus.js` calls `Draw.setPlaybackActive(status === 'playing' || 'counting')`
   whenever the state changes, in every document — that is how the 30fps
   playback floor gets applied without any panel remembering to.

### 7.2 API

| Signature | Notes |
|---|---|
| `Transport.host()` | shell only, once |
| `Transport.claim(owner, impl, caps?)` → handle | `owner` must be in `Transport.OWNERS`, else it throws |
| `handle.update(patch)` | merge + notify + broadcast. Patch keys: `status, position, duration, rate, loop, label, dirty, caps`. **The merge is per top-level key, and `caps` is REPLACED wholesale, never merged** — `update({caps:{volume:.8}})` erases `seek`, `rate`, `queue`, `repeat` and everything else, and the bar disables those controls. Keep your caps object as one piece of panel state and always send the whole thing |
| `handle.status(status, extra?)` | shorthand for `update({status, ...extra})` |
| `handle.release()` / `handle.isOwner()` / `handle.owner` | |
| `Transport.release(owner?)` | |
| `Transport.owner()` / `isOwner(o)` / `status()` / `duration()` | |
| `Transport.state()` | `{owner, status, position, duration, rate, loop, label, dirty, caps}` |
| `Transport.position()` | asks the local `impl.position()` when we are the owner, otherwise the last reported value |
| `Transport.onChange(fn)` → unsubscribe | `fn(snapshot)` on every state or owner change |
| `Transport.command(action, value)` and `play() pause() stop() toggle() seek(s) rate(r) setLoop({a,b}\|null) next() prev()` | |
| `Transport.sync()` → Promise | a freshly loaded panel asks the host for the current state |
| `Transport.STATUS` / `OWNERS` / `ACTIONS` | |

`impl` shape (every method optional except the ones your `caps` advertise):

```js
Transport.claim('player', {
  play(){}, pause(){}, stop(){}, toggle(){},
  seek(seconds){}, rate(multiplier){}, setLoop(loopOrNull){},
  next(){}, prev(){},
  position(){ return elapsedSeconds; },
  park(){ stopClock(); releaseSpace(); }      // required in practice
}, { seek: true, rate: true, loop: true, queue: true });
```

---

## 8. The command registry — `window.Commands`

One list behind Ctrl+K, the key router and the context menus.

| Signature | Notes |
|---|---|
| `Commands.register({id, label, keywords?, scope?, group?, keys?, danger?, enabled?, run})` → unregister | `enabled` may be a boolean or a function; `keywords` a string or an array |
| `Commands.registerAll([desc])` → unregister-all | |
| `Commands.unregister(id)` | |
| `Commands.get(id)` | local first, then remote; `null` if unknown |
| `Commands.list({scope?, enabledOnly?})` | `scope` keeps `'global'` + that scope. Sorted by group then label |
| `Commands.search(q, {scope?, limit=50})` | multi-term **AND** over label + keywords + group + id, label-prefix hits ranked highest. Pure — the caller owns the debounce |
| `Commands.run(id, arg?)` → Promise `{ok, value?, error?, dispatched?}` | a local command runs here; a remote one is dispatched to the frame that published it |
| `Commands.isEnabled(desc)` | evaluates a function `enabled` safely |
| `Commands.onChange(fn)` → unsubscribe | the palette re-renders from this |
| `Commands.setScope(scope)` / `Commands.scope()` | a panel sets its own frame key once at boot; new commands default to it |
| `Commands.publish()` | force the mirror to the host now (normally debounced 60ms after any register) |
| `Commands.host()` | shell only: collect what panels publish |

Cross-frame: functions cannot cross `postMessage`, so a published descriptor
carries `enabled` as a **boolean snapshot** and no `run`. Running a remote
command sends `command:run` to its frame (fire and forget — the palette closes
either way, and the frame reports a failure through `ui:toast`).

```js
Commands.setScope('review');
Commands.register({
  id: 'editor.save', label: 'Save project', keywords: ['write', 'disk'],
  keys: 'Ctrl+S', group: 'Editor',
  enabled: () => doc.loaded && doc.dirty,
  run: () => saveProject()
});
```

---

## 9. The small modules

### 9.1 fmt.js — `window.Fmt`

Pure functions, no DOM, no state. 43 cases under test.

| Signature | Example |
|---|---|
| `Fmt.clock(seconds, {ms, hours, sign, blank})` | `214.6 → '3:34'`, `{ms:true} → '3:34.600'`, `4271 → '1:11:11'`. Seconds truncate (3:33.9 is not 3:34); ms comes from integer milliseconds. Non-finite → `'--:--'`, and `null` is **not** zero |
| `Fmt.clockPad(seconds, {ms, hours})` | `65.25 → '01:05.250'` — fixed width, for a transport readout that must not jitter |
| `Fmt.parseClock(text)` | `'3:34.6' → 214.6`, `'1:11:11' → 4271`, `'214' → 214`, junk → `null` |
| `Fmt.ms(value, {digits, unit, blank})` | `12 → '+12ms'`, `-12.4 → '-12ms'` |
| `Fmt.duration(seconds, {blank})` | `90 → '1m 30s'`, `3700 → '1h 1m'` |
| `Fmt.when(value, {now, blank})` | relative label: `'just now'`, `'4 min ago'`, `'an hour ago'`, `'Yesterday'`, `'Tue 14:20'`, `'3 Mar'`, `'3 Mar 2024'`. Accepts a Date, ms, or seconds |
| `Fmt.stamp(value)` | `'2026-09-07 14:02:11'`, for the tooltip on a relative label |
| `Fmt.bytes(value, {digits, blank})` | `1536 → '1.5 KB'`, `5e9 → '4.7 GB'` |
| `Fmt.gb(value, {digits})` | always GB, for a storage panel where rows must line up |
| `Fmt.rate(bytesPerSec)` | `'1.4 MB/s'` |
| `Fmt.percent(value, {fraction, absolute, blank})` | `0.5 → '50%'`, `43.7 → '44%'`, clamped 0..100, always an integer |
| `Fmt.count(n, one, many?)` | `1 → '1 file'`, `3 → '3 files'` |
| `Fmt.basename(p)` `dirname(p)` `stem(p)` `ext(p)` | both separators, because paths come from Windows, from drops and from the engine |
| `Fmt.shortPath(p, max=48)` | middle-ellipsis keeping the basename |
| `Fmt.note(midi)` | `60 → 'C4'` — the visualiser and the inspector must agree on middle C |
| `Fmt.bpm(value)` | one decimal, `'--'` when unknown |
| `Fmt.pad2(n)` `Fmt.pad3(n)` | |

### 9.2 icons.js — `window.Icon`

One icon set: a 16-unit grid, stroke `1.6`, square caps and miter joins, stroked
marks so they sit at the weight of the text beside them and **filled** transport
marks so a triangle and a square read at the same optical size.

| Signature | Notes |
|---|---|
| `Icon.svg(name, size?)` | returns `<svg class="ic" viewBox="0 0 16 16" ...>` markup, `size` in px (default 16). Unknown name -> `''` |
| `Icon.apply(root?)` | replaces every `<i data-icon="name">` under `root` (default `document`). **Idempotent**: an element that already holds an `<svg>` is skipped |
| `Icon.has(name)` / `Icon.names()` | |

`data-icon-size` on the element is the size. `Icon.apply()` runs itself once on
`DOMContentLoaded`; **re-run it after any DOM insertion that contains
`[data-icon]`** — building a row, opening a menu, rendering a settings pane. The
shell does this in two places for exactly that reason.

**The name list is closed. An unknown name renders nothing, silently** — no
console error, no placeholder box. These are all of them:

```
close  plus  minus  check  up  down  caretDown  caretUp  caretRight
refresh  undo  dots  alert  search  folder  send  drop  keyboard
play  pause  stop  next  prev  record          (filled: the transport set)
gear                                            (generated, not a path)
```

There is no `note`, `star`, `tag`, `trash`, `edit`, `save` or `x`. If a view needs
one it gets **added to `icons.js` on the same grid** and listed here — never
inlined as a one-off `<svg>` in a tab, and never a font glyph or an emoji (those
fall back to a full-colour cartoon on Windows). A one-off decorative mark that is
genuinely not an icon (the repeat-one tick on the transport) may be a path inside
its own `<svg>`.

### 9.3 resize.js — `window.Resize`

A divider drives **one CSS custom property on the `[data-split]` ancestor**, so
the pane keeps owning its own size and nothing in the module has to know what the
other tracks are.

| Signature | Notes |
|---|---|
| `Resize.apply(root?)` | attach every `[data-resize]` under `root` (default `document`). Idempotent — a handle already attached is skipped |
| `Resize.attach(handle)` | one handle |

It runs `apply()` itself on `DOMContentLoaded`, so static markup needs no call;
markup you insert later does.

**Markup contract**

```html
<div class="split" style="--side: 312px" data-split="library">
  <div class="pane is-fixed" style="width: var(--side)"> ... </div>
  <i class="grip-h" data-resize="side" data-min="220" data-max="560"></i>
  <div class="pane is-flex"> ... </div>
</div>
```

| Attribute | Meaning |
|---|---|
| `data-split` on the ancestor | the **owner key**, the namespace for this tab's divider names |
| `data-resize` on the grip | the custom property to drive, **written without the leading dashes** (`data-resize="side"` drives `--side`) |
| `data-min` / `data-max` | bounds in px (defaults 80 / 900) |
| `data-axis` | `"x"` (default) or `"y"` — use `.split.is-v` + `.grip-v` for `y` |
| `data-invert` | present = dragging right/down makes the tracked pane **smaller** (the grip sits *after* the pane it sizes) |

**The property is set on the `[data-split]` ancestor, and the pane must consume
it.** `.pane.is-fixed` is only `flex: 0 0 auto`; nothing gives it a width. Write
`style="width: var(--side)"` on the pane (or `height` on a `.split.is-v`), or the
grip will drag and nothing will move. Give the property a sensible **default in
the same `style` attribute on the `.split`** so the first paint is not zero.

The grip is given `role="separator"`, `tabindex="0"`, `aria-orientation` and a
default `aria-label` (override it). Arrow keys move it 8px, Shift+arrow 40px,
double-click clears the override and forgets the stored size.

**Persistence and the invariant.** The key is `"<data-split>:<data-resize>"`
inside `localStorage['midi-studio:splits']`, and every write is a
**read-merge-write of that one key** — every tab is a separate frame with its own
copy of this module sharing one `localStorage`, and a whole-object write erased
what the other panes had saved (invariant 28). Every commit also dispatches a
**synthetic `window` `resize` event**, because several canvases only re-measure on
that. Both are already handled here: a tab that rolls its own divider re-breaks
both.

Divider keys are one shared, per-tab-namespaced registry. Claimed so far:

| Key | Owner |
|---|---|
| `library:side` | the Library's left column |
| `player:side` | the Player's left setup column |
| `player:rail` | the Player's right song-information rail (`data-invert`) |
| `player:map` | the Player's song map height (`data-axis="y"`) |
| `forge:rail` | the Forge tab's left input/pipeline column |
| `forge:insp` | the Forge tab's right results column (`data-invert`) |

Pick `"<frame key>:<name>"` and add the row.

### 9.4 timeline-zoom.js — `window.TimelineZoom`

`window.TimelineZoom` **is the factory itself**, not a namespace:

```js
const zoom = TimelineZoom(canvasHost, () => doc.duration, () => handle.invalidate());
```

`createTimelineZoom(element, getDuration, onChange)` keeps one visible window
`{start, span}` **in seconds** and owns the x<->time mapping through it. Shared by
the Forge waveform, the Editor waveform, the Player song map, the Self MIDI roll
and the Library preview, so the wheel behaves identically in all five.

| Signature | Notes |
|---|---|
| `zoom.start()` / `zoom.span()` | the current window, clamped to the duration. **`span` 0 internally means "the whole song"**, but `span()` never returns 0 — it returns the duration (or 1 when the duration is 0), so it is always safe as a divisor |
| `zoom.zoomed()` | false while the whole song is shown |
| `zoom.xFor(time, width)` / `zoom.timeAt(x, width)` | `width` is **CSS** pixels, the space `Draw.fitCanvas` leaves you in |
| `zoom.reset()` | back to the whole song, then `onChange()` |
| `zoom.follow(time)` | keeps a moving playhead inside the window; a no-op while not zoomed. Call it from your draw, not from a timer |

Wheel zooms around the pointer, Shift+wheel pans, and the listener is
`{passive:false}` and calls `preventDefault()`, so the panel will not scroll under
it. `onChange` fires on every change — **coalesce in your handler**;
`handle.invalidate()` is already rAF-coalesced, so calling that is enough.

**`dblclick` on the element is reserved** — it is the reset gesture. A consumer
cannot use `dblclick` on the same element for anything else; put a double-click
action on a child that stops propagation, or use a different gesture.

### 9.5 menu.js — `window.Menu`

The context-menu controller behind the classes in §2.13. One host element per
document, reused; only one menu is ever open.

| Signature | Notes |
|---|---|
| `Menu.open(items, opts)` -> `{close}` or `null` | closes any open menu first. `null` when `items` is empty |
| `Menu.close()` / `Menu.isOpen()` | |

**Item shapes** (a falsy entry is dropped, so `cond && {...}` is fine):

| Shape | Renders |
|---|---|
| `{label, key?, icon?, danger?, disabled?, checked?, run?}` | a `.menu-item`. `key` is the shortcut hint, `icon` an `Icon` name, `checked` a boolean (-> `menuitemcheckbox` plus the lime dot). `run(def)` is called **after** the menu has closed |
| `{sep: true}` | `.menu-sep` |
| `{group: 'Text'}` | `.menu-label` heading |

**Options**: `{x, y}` (viewport coordinates — pass `ev.clientX/clientY`), or
`{anchor: element}` to hang it under an element; `ariaLabel`; `returnFocusTo`
(defaults to `document.activeElement`); `onClose`.

It handles: flipping left/up at the viewport edge and clamping to an 8px margin,
self-scrolling when taller than the viewport, dismissal on outside pointerdown /
Escape / Tab / window blur / resize / any scroll or wheel outside itself / the
panel being parked (`data-onscreen="0"`), Up/Down/Home/End roving with
`.is-cursor` and `aria-activedescendant`, hover moving the cursor, Enter and Space
to activate, and focus return on close. **Escape is captured and stopped**, so it
closes the menu without also closing the dialog, palette or sheet behind it.

```js
list = VList(host, {
  onContextMenu(item, index, ev) {
    ev.preventDefault();
    Menu.open([
      { group: item.name },
      { label: 'Play', key: 'Enter', icon: 'play',
        run: () => Bus.send(T.NAV_OPEN_PLAYER, { midiPath: item.path, play: true }) },
      { label: 'Send to the Editor', icon: 'send',
        run: () => Bus.send(T.NAV_OPEN_EDITOR, { midiPath: item.path }) },
      { sep: true },
      { label: 'Favourite', checked: favs.has(item.path), run: () => toggleFav(item.path) },
      { label: 'Reveal in Explorer', icon: 'folder',
        run: () => Bus.send(T.FILE_REVEAL, { path: item.path }) },
    ], { x: ev.clientX, y: ev.clientY, ariaLabel: item.name, returnFocusTo: list.host });
  }
});
```

### 9.6 Coalescing and debouncing — the pattern, not a module

§11.9 requires **paint on `input` (rAF-coalesced), persist on `change`** for every
continuous control, and every panel needs the same two helpers. They are eight
lines each; copy them rather than each tab inventing a variation:

```js
// One rAF per burst, last value wins. For painting.
function coalesce(fn) {
  let armed = false, args = null;
  return (...a) => {
    args = a;
    if (armed) return;
    armed = true;
    requestAnimationFrame(() => { armed = false; fn(...args); });
  };
}

// Trailing edge, last value wins. For writes (IPC, localStorage, a bus send).
function debounce(fn, ms) {
  let t = 0, last = null;
  const w = (...a) => {
    last = a;
    clearTimeout(t);
    t = setTimeout(() => { t = 0; const p = last; last = null; fn(...p); }, ms);
  };
  w.flush   = () => { if (!t) return; clearTimeout(t); t = 0; const p = last; last = null; if (p) fn(...p); };
  w.cancel  = () => { clearTimeout(t); t = 0; last = null; };
  w.pending = () => !!t;
  return w;
}
```

**`flush()` INVOKES the pending call. `cancel()` drops it.** Getting that backwards
is not a style question: on a range input `input` fires and then `change` fires in
the same gesture, well inside any sensible debounce window, so a `change` handler
that "flushes" by clearing the timer throws away the final value of every drag —
and **every keyboard arrow adjustment, which produces no other event at all**. Use:

* `flush()` on `change`, on close, on `beforeunload` — anywhere the pending value
  must go out now;
* `cancel()` only when you are about to do the same work yourself on the next line;
* `pending()` when a `change` handler needs to know whether an `input` preceded it
  (no `input` means no pending value, so send directly).

Never debounce a paint, and never rAF-coalesce a write.

### 9.7 hotkey.js — `window.Hotkey`

The capture box for a **global** hotkey: the ones the Python sidecar registers, so
the value is pynput syntax (`<ctrl>+<f6>`, `<space>`, `;`) and not a DOM key name.
The CSS (`.hk`, `.hk.is-capturing`, `.hk.is-empty`, `.hk-slot`, `.hk-clear`) is
§2.9 and already shipped; this is its driver. It is **not** for in-app shortcuts —
those are `Commands` (§8) and the shell's key router (§11.7).

| Signature | Notes |
|---|---|
| `Hotkey.toPynput(event)` | a `keydown` as pynput syntax, or `null` for a modifier pressed on its own (keep listening) |
| `Hotkey.label(combo)` | `'<ctrl>+<f6>'` → `'Ctrl+F6'`. `''` stays `''` |
| `Hotkey.create(opts)` | one capture box. Returns a widget |
| `Hotkey.NAMED` / `.CODE_CHAR` / `.LABELS` | the three tables, if a caller has to translate something the widget did not produce |

```js
const w = Hotkey.create({
  id: 'hotkey-play',                 // id for the <button class="hk-slot">
  label: 'Play / resume',            // used in both ARIA labels
  describedBy: 'hk-label-play',      // your row's own <span> id
  value: settings.playHotkey || '',  // '' is a real value: UNBOUND
  onCapture: () => suspendHotkeys(), // focused: the globals must go quiet
  onCommit:  () => applyHotkeys()    // settled (blur / unbind): persist + re-send
});
row.append(myLabelSpan, w.el);       // w.el is the .hk element
```

| Widget | Notes |
|---|---|
| `w.el`, `w.slot`, `w.clear` | the `.hk` wrapper and its two buttons |
| `w.value()` | the current combo, `''` when unbound |
| `w.label()` | the same thing, human-readable |
| `w.set(combo[, quiet])` | write it in. `quiet` skips `onChange`; neither form fires `onCommit` |
| `w.focus()` | start capturing |
| `w.dispose()` | drops its four listeners — call it from your teardown |

**Three things it exists to keep, and a tab that re-implements them loses:**

* **`e.code` decides the character, never `e.key`**, so Shift+`;` binds as `;` and
  not `:` — a pynput listener sees the physical key, and a box that stored `:`
  produced a binding that could never fire.
* **Empty means UNBOUND** (invariant 13), for `play`/`pause`/`stop` as much as for
  the rest, so those keys can be freed for the game. Nothing springs back to a
  default. Focus-then-leave without pressing anything is *not* an unbind — only
  Backspace/Delete or the `.hk-clear` button is.
* **A focused box must suspend the global hotkeys** (invariant 13), or the key
  being rebound fires its old action while it is being rebound. The widget cannot
  do that itself — only the owner can talk to the engine — so it calls
  `onCapture()`, and the owner sends the "all empty" `set_hotkeys`. `onCommit()`
  is where the real set goes back out.

Every key belongs to a focused box, including Space, Tab and Enter: the widget
`preventDefault()`s and `stopPropagation()`s the whole `keydown`, so a transport
Space handler on `window` never sees it. Escape leaves the box unchanged.

---

## 10. Rules a tab implementer must not break

1. **No framework.** Plain HTML/CSS/JS, classic scripts, window globals.
2. **No new draw loop.** `Draw.register` + `invalidate()`. A hand-rolled rAF is a
   defect: it will not park off-screen, will not honour `data-drawms`, and will
   not floor during playback.
3. **No `getComputedStyle` in a paint path.** `Tokens.get`, cached, invalidated
   on `midi-studio:theme`.
4. **Never assign `canvas.width`/`height` yourself.** `Draw.fitCanvas`. And the
   canvas stays viewport-sized with a scroll wrapper supplying the extent
   (`.canvas-scroll` > `.canvas-extent`), because Chromium caps a canvas at
   16,384px and a five-minute song at default zoom is ~24,000px.
5. **No hand-built long list.** `VList`, one delegated click, one delegated
   contextmenu. A list with columns is `VList` + the `.lgrid` column rows (§2.7),
   not `.table`.
6. **No raw `postMessage`.** `Bus.send` / `Bus.on`, with the envelope and both
   checks.
7. **One transport owner.** `Transport.claim` and honour `park()`.
8. **Register every action as a command**, or it will not be in Ctrl+K.
9. **Animate transform and opacity only.** No `width`/`height`/`top`/`left`/
   `box-shadow`/`filter`, no permanent `will-change`, no idle animation.
   `prefers-reduced-motion` is handled in the token layer — but **motion is never
   the only signal either.** If a state is carried by an animation (a sweep, a
   spin, a blink), give that state an explicit static form inside a
   `@media (prefers-reduced-motion: reduce)` block, because the blanket kill
   switch collapses an animation to one ~0ms iteration and leaves it at its END
   frame. `.bar-fill.indet` and `.btn.is-busy` are the two worked examples in the
   shared layer; copy the shape.
10. **Toggle visibility with `el.hidden`**, never `style.display`: component
    rules such as `.dlg-scrim{display:flex}` would otherwise beat the hidden
    attribute.
11. **State is never colour alone.** A mark, a word, or an ARIA attribute as
    well. `aria-selected` / `aria-checked` / `aria-expanded` / `aria-sort` drive
    the CSS in this library, so setting the ARIA **is** setting the look.
12. **12px is the type floor** (`--t1`), `--text-3` is the contrast floor, in
    both densities. The 9px keyboard label in the visualiser is the one
    sanctioned exception.

---

# 11. The Shell

`renderer/index.html` + `renderer/shell/shell.js` + `renderer/shell/shell.css`
own the application chrome: the custom titlebar, the activity strip and its log
drawer, the tab stage, the persistent bottom transport, the command palette, the
settings sheet, the boot splash, the window-level drop veil, toasts, the key
router and the cross-tab hand-off router.

The shell owns **no** playback clock, **no** canvas loop and **no** panel state.
Everything it shows comes from one of four places: the transport-owner state,
main-process IPC, its own persisted settings, or the activity model in §11.3.

## 11.1 Frame lifecycle — what every tab must do

The five frames are `forge`, `review` (Editor), `player`, `audition` (Self MIDI)
and `library`. Frames load **lazily**: a frame's `src` is set the first time its
tab is activated, so a panel must not assume it exists at app start, and the
shell must not assume a panel exists when a hand-off arrives.

```
1. document loads
2. shared scripts run          Bus/Transport/Commands/Draw/Tokens/VList/Fmt exist
3. panel boots                 wire its DOM, restore its own prefs
4. Commands.setScope('<frame key>')          <-- before registering commands
5. Commands.register(...)                    <-- everything the palette should see
6. Bus.send(Bus.TYPES.FRAME_READY, { frame: '<frame key>' })
7. hand-offs start arriving as nav:open-*    <-- queued until step 6, then flushed
```

Rules:

* **`frame:ready` is the handshake.** Until a panel sends it, the shell treats
  the panel as legacy and delivers hand-offs by calling a global function
  instead (§11.2). Send it exactly once per document load; a reload retracts it.
* The bus exists from the moment your first inline script runs. `Transport`,
  `Commands` and `Draw` likewise. There is no "wait for the shell" step: the
  shell trusts the frame before it navigates.
* **But the stamped attributes arrive later than your boot code.** The shell
  stamps `data-theme`, `data-density`, `data-drawms`, `data-game` and
  `data-onscreen` on your `<html>` on the frame's **`load` event** — i.e. after
  your scripts have run. Whatever your own HTML declared is what your boot code
  sees, and a background tab's document sees the defaults until the shell gets
  round to it. So: **never read those attributes as authoritative at boot.**
  Render from your own defaults, and react to `midi-studio:theme` /
  `midi-studio:density` / `midi-studio:onscreen` and to `ui:theme` / `ui:density`
  / `ui:perf` on the bus. `Tokens` and `Draw` already do this correctly — the rule
  is about your own code.
* **Your document must live at `renderer/<frame key>/index.html`.** The shell's
  `#tab-fallback` empty state matches `main`'s failing URL against the frame's
  `data-src` with `./` stripped, so a panel that ships as, say,
  `library/library.html` gets Chromium's white error page instead of the
  fallback — the one thing §11.1 promises will never happen. The five paths are
  `forge/`, `review/`, `player/`, `audition/`, `library/`, each `index.html`.
* The shell owns the theme, the accent, the density and the draw budget. A panel
  must **not** apply its own theme. It receives:
  * `data-theme`, the seven `--accent*` custom properties, `data-density`,
    `data-drawms`, `data-game` and `data-onscreen` stamped on its `<html>`;
  * a `midi-studio:theme`, `midi-studio:density` or `midi-studio:onscreen`
    event on its `window` when one of those changes;
  * `ui:theme`, `ui:density` and `ui:perf` on the bus.

  `Tokens` and `Draw` already listen for the events. A panel that caches colours
  itself should use `Tokens.onChange`.
* **`data-onscreen="0"` means park.** The shell stamps it when your tab is not
  the active one **and** when the command palette, the settings sheet or the drop
  veil is up (an iframe composites above a fixed overlay, so a covered panel is
  also `visibility:hidden`). `Draw` handles this for you; a hand-rolled rAF does
  not. Coming back on screen fires `midi-studio:onscreen` and `Draw` repaints
  every consumer once, so a stale canvas cannot survive a tab switch.
* **Frame budget push-down.** `data-drawms` carries the user's **base** budget,
  untripled. `data-game="1"` says a game is up. `Draw` applies the x3 raise, the
  250ms unfocused clamp and the 33ms playback floor. Never multiply them
  yourself.
* A panel whose document fails to load is covered by the shell's own empty state
  (`#tab-fallback`) with a Try again button. `main` reports the failure on
  `panel-failed`; the shell never lets Chromium's white error page show.

## 11.2 The hand-off router

A file can be sent from any tab to any other. The sender does **not** touch the
target frame; it sends one bus message and the router does the rest: create the
frame if it does not exist, switch to that tab, wait for `frame:ready`, then
deliver. A hand-off to a frame that has not loaded is **queued**, not dropped.

| Send this | To open | Payload |
|---|---|---|
| `nav:open-forge` | Forge | `{inputPath?, inputPaths?, url?}` |
| `nav:open-editor` | Editor | `{projectPath?, midiPath?}` — `projectPath` wins |
| `nav:open-player` | Player | `{midiPath?, play?, mappingPath?, queue?}` |
| `nav:open-selfmidi` | Self MIDI | `{midiPath?, projectPath?, play?}` |
| `nav:open-library` | Library | `{selectPath?, query?}` |
| `nav:activate` | any tab, nothing to open | `{tab, focus?}` |

```js
// from a Forge result row, an Editor toolbar, a Library row, anywhere:
Bus.send(Bus.TYPES.NAV_OPEN_PLAYER, { midiPath: file.path });
```

What the **receiving** tab must do: register a handler for its own `nav:open-*`
type and treat every delivery as "open this now". The payload may arrive before,
during or after your first paint, and more than one may arrive at once (they are
flushed in order).

```js
Bus.on(Bus.TYPES.NAV_OPEN_PLAYER, (p) => { if (p.midiPath) loadFile(p.midiPath, !!p.play); });
```

**`play` is tri-state and the shell fills it in.** If the sender omits `play`,
the router substitutes the user's Settings > Playback > "Sending a file to the
Player" choice (`load` by default). The invariant that loading is not playing
still holds: sending a file across is itself the explicit ask.

**The continuity cue.** On every hand-off the shell:

1. puts the filename in the activity strip immediately, as an `Opening <name> in
   <Tab>` row, before the target has finished loading;
2. flashes the target's nav item to the accent state for 340ms;
3. switches tabs with the standard 150ms transition;
4. broadcasts `file:open` with `{path, kind, from}` to every frame, so the
   **source** panel can flash the row the file came from. `from` is the frame key
   of the sender (or `'shell'`, `'palette'`, `'os'`). A panel should ignore
   `file:open` when `from` is not itself.

**Legacy delivery.** While a tab has not yet been rewritten (no `frame:ready`),
the router calls a global on its `contentWindow` instead:

| Frame | Global | Called as |
|---|---|---|
| `player` | `window.setMidiFile` | `setMidiFile(midiPath, play)` |
| `review` | `window.openReviewProject` | `openReviewProject(projectPath \|\| midiPath)` |
| `audition` | `window.loadAudition` | `loadAudition(midiPath, projectPath, {play})` |
| `forge` | `window.setForgeInput` | `setForgeInput(inputPath \|\| url)` |

A rewritten panel may keep or drop these freely — once it sends `frame:ready`
the bus path is used and the globals are never called.

**Dropped files and file associations** go through the same router.
`file:dropped` with `{paths}` from any panel, a drop on the shell's own chrome,
and a `.mid` handed over by Windows all end up in one place, routed by
extension: `.midstudio.json` to the Editor, `.mid`/`.midi` to the active tab if
it takes MIDI else the Player, a bare `.json` to the Player as a mapping, audio
or an extension-less path to Forge.

## 11.3 The activity strip

Rendered purely from this model; nothing writes to its DOM from outside.

```js
activity = {
  forge:    { jobId, name, stage, percent|null, startedAt, paused, kind } | null,
  forged:   { name, midiPath, projectPath, at } | null,   // a finished MIDI on offer
  playback: <transport snapshot> | null,
  editor:   { name, notes, dirty } | null,
  panels:   { '<frame key>': { frame, label, percent } },  // a panel's own long job
  pending:  { frame, name, at } | null,      // a hand-off in flight
  engine:   { known, ready, gpu, missing[], dir, custom, freeGb, needGb },
  update:   { state, percent, version, current, staged, canSelfUpdate, message, dismissed },
  reaped:   string                            // a launch-time housekeeping notice
}
```

Rows render in priority order — Forge job, a finished transcription on offer,
playback, unsaved Editor document, panel jobs, hand-off in flight — and the first
one gets the wide slot and the progress bar.
Clicking a row switches to the tab it belongs to. When nothing is happening one
quiet Idle row remains, so the strip never changes height.

Percent text is written **only on an integer change**, and both bars are `--p` +
`scaleX`. ETA is derived from monotonic percent and elapsed time, and is withheld
below 5% or under 8 seconds, because a made-up number is worse than none.

**How panels feed it**

| What | How |
|---|---|
| Forge job name | the pipeline's own `Input: <file>` log line, or `forge:status` with `{event:'forge.job', jobId, name, kind}` from the Forge tab |
| Forge stage / percent | `forge.progress`, already broadcast by main |
| Playback | the transport state — nothing extra to do |
| Editor unsaved | `Bus.send(FRAME_BUSY, {frame:'review', busy:true, label:'<name> · <n> notes'})`, and `busy:false` on save |
| **Any panel's own long determinate job** | `Bus.send(FRAME_BUSY, {frame:'<your key>', busy:true, label:'Rescanning 3,412 files', percent:42})`, then `busy:false` when it ends. A `frame:busy` **with a numeric `percent`** gets its own strip row with a progress bar, labelled with your tab name, clickable through to your tab. Send it at most ~10Hz: the strip is rAF-coalesced and only rewrites text on an integer change, so more packets buy nothing |
| A panel's *indeterminate* busy state | `frame:busy` **without** `percent` is logged, not shown. A row that can never finish is worse than a log line; show it in your own panel instead |
| A finished transcription (auto-queue off) | nothing to do — the shell writes `activity.forged` from `forge.done` and offers **Add to queue** / **Edit** / **Dismiss** on the strip. Superseded by the next `forge.job`. The toast is the transient echo, not the offer |
| Forge engine verdict | `forge:status` with `{event:'forge.env', forgeReady, gpu, missing}` after the Forge tab runs `forge.check()`. The shell caches it in `localStorage['midi-studio:forgeEnv']` and paints that cached verdict **synchronously** on the next cold start, because the probe imports torch and takes tens of seconds. If nobody has probed 12 seconds after boot, the shell probes once itself |
| Anything worth saying | `Bus.send(UI_TOAST, {severity,title,message,key})`, or `UI_STATUS` which goes to the log |

**The log drawer** is the single sink for the Forge log, the provisioning log,
player errors and shell events. Ring buffer capped at 600 lines, rendered by
`VList` at 18px rows, level-coloured, auto-expanding on the first error (which is
**not** persisted as a preference), with Clear, Copy and a level filter.
`Ctrl+Alt+L` toggles it.

**The update row** implements all eight states — checking, available,
downloading, verifying, ready, manual, updated, none, error — and is the only one
in the app. `update-status` stays main-frame-only and is never mirrored onto the
bus, so a panel cannot grow a second banner.

## 11.4 The transport-owner protocol as implemented

`Transport.host()` runs in the shell (which also installs `Bus.installRelay()`
and `Commands.host()`). Exactly one of `player | selfmidi | editor` owns the bar;
claim it, honour `park()`, and report state only while you are the owner — all as
specified in §7. What the **bottom bar** additionally reads:

`caps` is not only a capability set: **a key's presence enables the control and
its value is the owner's current setting.** This is how the bar carries the four
things the transport action list does not.

| `caps` key | Type | Enables |
|---|---|---|
| `seek` | boolean | the scrub bar |
| `rate` | boolean | the Tempo knob (its value comes from `state.rate`) |
| `queue` | boolean | Previous / Next |
| `loop` | boolean | reserved for the Editor's loop toggle |
| `shuffle` | boolean | the Shuffle button, and its current state |
| `repeat` | `'off'\|'all'\|'one'` | the Repeat button, and its current mode |
| `transpose` | number, semitones | the Transpose knob, and its current value |
| `volume` | number, 0..1 | the Volume knob, and its current value |
| `sub` | string | the second line under the filename ("Roblox · 36 keys") |
| `target` | string | the target chip in the strip's Now Playing row |
| `notes` | number | the note count in the strip |
| `blockedWhy` | string | the word in the status pill while `status === 'blocked'` |

Use `'transpose' in caps`, not truthiness: 0 is a real transpose.

Writes the transport action list does not carry go out as **commands**, to
whichever frame published them. Publish these with your owner name as the prefix
and the bar will drive them; leave one out and its control stays disabled with a
tooltip rather than lying:

| Command id | Argument |
|---|---|
| `<owner>.shuffle` | boolean, the desired state |
| `<owner>.repeat` | `'off'\|'all'\|'one'` |
| `<owner>.transpose` | integer semitones |
| `<owner>.volume` | number 0..1 |

`<owner>` is `player`, `selfmidi` or `editor`. Tempo goes through
`Transport.rate()`, which is in the protocol proper.

The bar shows what it just sent until the owner confirms it or 1.5s passes, so
the round trip through your frame never makes a knob snap backwards. A change of
owner drops every echo.

**The bar never owns a clock.** Every position it shows arrived in a
`transport:state` packet, so the owner sets the cadence:

* **~10Hz is the floor** while `status` is `playing` or `counting`. Slower and the
  readout visibly stutters, because there is nothing above to interpolate with.
* **Per engine packet is the ceiling** — the Player sidecar emits `progress` every
  50ms (20Hz), and forwarding each one is correct and cheap.
* **Never per frame.** The bar's render is already rAF-coalesced and its percent
  text only rewrites on an integer change, so a 60Hz stream costs one postMessage
  per frame and buys nothing. A panel with a finer internal clock extrapolates
  locally for its own canvas and still reports at 10-20Hz.
* Send one **immediately, out of cadence**, on every status change, seek, rate
  change, label change and `caps` change. Those are edges, not samples.
* When idle or paused, stop sending. The last packet stands.

Scrubbing is rAF-coalesced into `Transport.seek()` and the drag is released on
`change` / `pointerup` / `blur`; a gesture that never moved does not seek at all,
so grabbing the thumb and letting go cannot rewind the song.

## 11.5 Commands the shell expects a panel to publish

The shell registers everything it can genuinely do itself (listed below). These
are tab-owned, and the palette, the transport bar and the settings sheet look for
them by id. Publishing one makes it appear; not publishing it leaves the
corresponding affordance disabled or absent, never broken.

| Id | Scope | What the shell does with it |
|---|---|---|
| `forge.setup` | forge | the engine chip and Settings > Forge engine open first-time setup |
| `forge.recheck` | forge | re-probe after the Forge storage folder moves |
| `editor.save` | review | the strip's Save button on an unsaved document |
| `editor.savePlay` | review | the strip's Save & Play button |
| `player.focusTarget` | player | palette: focus the target window |
| `player.mapping` | player | palette: change mapping |
| `player.panic` | player | palette: panic |
| `<owner>.shuffle` `.repeat` `.transpose` `.volume` | the owner's scope | the bottom transport (§11.4) |

Commands the **shell** owns, always present:
`nav.forge` `nav.review` `nav.player` `nav.audition` `nav.library` ·
`transport.toggle` `.stop` `.next` `.prev` `.perch` ·
`app.openFile` `app.outputFolder` `app.revealLast` `app.editLast` ·
`app.settings` `app.updates` `app.log` `app.copyLog` `app.density`
`app.forgeStorage` `app.setupLog` `app.bootLog` `app.minimize` `app.maximize`.

The palette also lists **songs**: the library index, filtered by a multi-term AND
match, or the ten most recent when the query is empty. Activating one sends it to
the Player through the hand-off router.

## 11.6 Events the shell mirrors onto the bus

`main`'s `broadcast()` already reaches every frame over IPC. The shell mirrors
only the **low-rate** events onto the bus, for panels that prefer it:

`engine:event` (only `ready` and `error`) · `engine:error` · `game:active` ·
`overlay:state` · `library:changed` · `forge:status` (only `forge.done`,
`forge.paused`, `forge.job`, `forge.env`, `forge.provision.done`,
`forge.provision.error`).

The high-rate streams — engine progress packets, `forge.log`, `forge.progress` —
are deliberately **not** mirrored: doubling a 20Hz stream across five frames is
exactly the fan-out cost the perf review flagged as the hottest main-thread path.
Use `window.api.onEngineEvent` / `window.forge.onStatus` for those; every frame
has them. `update-status` is never mirrored at all.

**Pick one channel per event.** A panel that listens on both IPC and the bus will
handle everything twice.

## 11.7 Keys the shell owns

| Key | Action | Caught where |
|---|---|---|
| `Ctrl+1..5` | Forge / Editor / Player / Self MIDI / Library | shell **and** `main` (`before-input-event`) |
| `Ctrl+K` | command palette | shell **and** `main` |
| `Ctrl+,` | settings sheet | shell **and** `main` |
| `Ctrl+Alt+L` | activity log drawer | shell **and** `main` |
| `Ctrl+Alt+O` / `Ctrl+Alt+P` | Perch open/close, Perch click-through | `main`, as global shortcuts |
| `Space` | play / pause on the transport owner | shell, ignored inside a form control |
| `Home` | stop | shell, ignored inside a form control |
| `Escape` | palette, then settings, then the log drawer, then the update row | shell |
| Arrow Left/Right, Home, End | move between nav items when one has focus | shell |

Anything caught in `main` is forwarded to the shell frame as `shell-shortcut`
with `{tab}` or `{id}`, because the stage covers nearly the whole window and
swallows keydowns the moment focus is inside a panel. **The two maps must always
list the same keys in the same order.**

**A panel must not assume the shell sees `Space`, `Home` or `Escape`.** Those
three are caught only in the shell document. A keydown inside an iframe does not
reach the parent, so while focus is inside your panel — which is the normal case —
the shell never sees them:

| Key | What a panel owes |
|---|---|
| `Space` | while you are the transport owner, bind it yourself and call `Transport.toggle()`, and **release it in `park()`**. Ignore it inside a form control. Respect the "Space toggles transport" preference: it is **not** mirrored onto the bus, so read `studio.getUi().spaceTransport !== false` at boot and again on `nav:activated` for your own tab (that always precedes the user pressing a key in it) |
| `Home` | while you are the transport owner, bind it and call `Transport.stop()`. Ignore it inside a form control (a text field needs Home) |
| `Escape` | yours to handle inside your own document: close your own menu (`Menu` already captures and stops it), then your own popover, then clear your own selection. It will never reach the shell's palette/sheet chain from inside a panel, and it does not need to — those are not open while your panel has focus |

The four `Ctrl+` keys and the two `Ctrl+Alt+` keys DO reach you wherever focus is,
because `main` catches them in `before-input-event`. Everything not in this table
is yours.

## 11.8 Element ids the shell owns

* **Splash** `splash` `splash-mark` `splash-status`
* **Titlebar** `titlebar` `brand` `nav` `nav-ind` `nav-forge` `nav-review`
  `nav-player` `nav-audition` `nav-library` `search-trigger` `version-chip`
  `settings-btn` `win-min` `win-max` `win-close`
* **Activity strip** `astrip` `as-items` `as-engine` `as-game` `as-update`
  `as-upd-title` `as-upd-sub` `as-upd-bar` `as-upd-fill` `as-upd-apply`
  `as-upd-x` `as-log-toggle` `as-log-count`
* **Log drawer** `alog` `alog-filter` `alog-copy` `alog-clear` `alog-close`
  `alog-list` `alog-empty`
* **Stage** `stage` `frame-forge` `frame-review` `frame-player` `frame-audition`
  `frame-library` `tab-fallback` `tf-title` `tf-msg` `tf-retry` `tf-log`
* **Transport** `xport` `xp-art` `xp-name` `xp-sub` `xp-status` `xp-status-txt`
  `xp-shuffle` `xp-prev` `xp-play` `xp-next` `xp-repeat` `xp-stop` `xp-elapsed`
  `xp-scrub` `xp-total` `xp-knobs` `xp-knob-tempo` `xp-tempo` `xp-tempo-val`
  `xp-knob-transpose` `xp-transpose` `xp-transpose-val` `xp-knob-volume`
  `xp-volume` `xp-volume-val` `xp-perch`
* **Palette** `pal-scrim` `pal` `pal-input` `pal-list` `pal-empty` `pal-count`
  (rows are `pal-row-<n>`)
* **Settings** `set-scrim` `set-dlg` `set-title` `set-close` `set-nav`
  `set-panes`, and every control prefixed `s-`
* **Window level** `drop-veil` `toasts` `shell`

Body/root attributes the shell sets: `body[data-boot]`, `body[data-maximized]`,
`body.is-covered`, `html[data-theme]`, `html[data-density]`, `html[data-drawms]`,
`html[data-game]`, `html[data-drop]`.

## 11.9 Settings sheet — where each setting lives

Appearance (accent preset, custom colour, density, always-on-top) · Playback
(hand-off load-or-play, Space toggles transport, milliseconds in the readout,
auto-queue finished transcriptions) · Performance (percent, the derived-values
sentence, exact threads/batch with "back to automatic", the while-gaming policy)
· Forge engine (status, missing list, storage folder with relocate/reset/open,
free space, Open setup log, Open boot log, Clean reinstall) · Storage (output
folder, library folders, mappings folder, a read-only Forge-storage mirror) ·
Updates (check on launch, installed version, last check, Check now) · Overlay
(Perch open, size, fade, look-ahead, the 3x3 park pad, click-through, lock,
keyboard, buttons, open-on-play, hide-on-finish) · About.

The four Forge layouts and their picker are **gone**; a stored
`ui.forgeLayout === 'cards'` migrates once to compact density. Continuous inputs
paint on `input` (rAF-coalesced) and persist on `change`, and the renderer
coalesces `app:setUi` writes into one trailing IPC call with a guaranteed flush
on sheet close and on unload.

## 11.10 IPC added by the shell

Every existing channel is unchanged. Added:

| Channel | Direction | Shape |
|---|---|---|
| `win:state` | invoke | -> `{maximized, minimized, fullScreen, focused}` |
| `win:minimize` `win:maximize` `win:unmaximize` `win:toggleMaximize` `win:close` | send | — |
| `window-state` | main -> shell frame | `{maximized, minimized, fullScreen, focused}` |
| `app:bootState` | invoke | -> `{steps:[{step,label,t}], ready}` |
| `boot-milestone` | main -> shell frame | `{step, label}`; steps are `session`, `jobs`, `window`, `engine`, `painted` |
| `app:openBootLog` | invoke | -> `{ok, path}` or `{ok:false, error}` |
| `panel-failed` | main -> shell frame | `{url, code, desc}` — a tab document that would not load. **The shell matches `url` against the frame's `data-src` minus `./`, so a panel document MUST be `renderer/<frame key>/index.html`** or it gets Chromium's white error page instead of `#tab-fallback` |

New `window.studio` surface (additive): `window.{minimize, maximize, unmaximize,
toggleMaximize, close, state}`, `onWindowState`, `bootState`, `onBootMilestone`,
`onPanelFailed`, `openBootLog`, `snapOverlay`, `getOutputDir`, `openPath`,
`showItem`.

Other main-process changes: the window is `frame: false` with `backgroundColor`
set to the app's own `--bg`; `Ctrl+1..5` plus the three app keys are forwarded
from `before-input-event`; a **subframe** `did-fail-load` no longer triggers the
shell's reload recovery; settings writes are debounced (600ms) with a guaranteed
flush on window close and on `before-quit`; and the two escaped-backslash bugs
(the `C:\Windows` CUDA probe and the `HKCU\Software\StarsationX\MIDI Studio` reg
QUERY) are fixed, so installer-chosen Forge storage is adopted again.

## 11.11 The boot splash

In-document, not a second window, so the hand-over can cross-fade the real
chrome instead of swapping two surfaces. `backgroundColor` on the BrowserWindow
is already `--bg` and the window is `show: false` until `ready-to-show`, so the
first thing ever painted is the splash on the app's own ground.

The status line shows **real** state and never a percentage: `Loading interface`
(the shell's own script ran), `Starting MIDI engine` (main spawned the sidecar),
`Restoring session` (settings came back), `Scanning recent files` (the library
index resolved), `Ready`. Milestones that fired before the renderer subscribed
are collected through `app:bootState`.

It never delays startup. Hand-over happens as soon as the session has been
restored and the first panel has loaded — **the panel document, not the initial
`about:blank`**. Every frame starts with only `data-src` (frames load lazily), and
Chromium fires `load` for a src-less iframe's own empty document, so both the
`load` handler and the splash gate test that the frame has actually been navigated
before believing it. Without that test all five frames are "loaded" at boot and the
hand-over reveals an empty stage, which is the one thing this gate exists to stop.
A boot faster than 700ms settles the bar
animation immediately instead of waiting out its stagger. A 6s watchdog hands
over regardless, so a stuck sidecar or a panel that never fires `load` cannot
leave the splash on screen. Under `prefers-reduced-motion` it degrades to a
plain fade.


## 11.12 The Library's data surface

`nav:open-library` says *what to show*. This says *where the files come from*. It
is `window.library`, exposed by `preload.js` in **every** frame
(`nodeIntegrationInSubFrames: true`), and it already backs the shell's own song
index and the Storage settings pane.

| Call | Returns |
|---|---|
| `library.list()` | `{dirs: string[], extra: string[], files: [{path, name, dir, size, modified}], truncated: boolean}` |
| `library.addFolder()` | `{ok:true, dir}` or `{ok:false, canceled:true}` — opens the folder picker |
| `library.removeFolder(dir)` | `{ok:true}` |
| `library.reveal(path)` | shows the file in Explorer |
| `library.onChanged(fn)` | -> unsubscribe. Also arrives on the bus as `library:changed` |

Facts that are not visible from the shapes:

* **`dirs[0]` and `dirs[1]` are built in and must not offer a remove button.**
  `dirs[0]` is the program output folder, `dirs[1]` is `~/Documents/MIDI Studio`,
  and `library:removeFolder` only filters the *user* list — so a remove button on
  either does nothing at all. `extra` is exactly the user's own list. The shell
  encodes this as a bare `BUILTIN = 2`; do the same or read `extra` and match.
* `name` has the extension **stripped**; `path` is the full path. Rows are keyed by
  `path` (`VList`'s default key).
* `modified` is epoch **milliseconds** — `Fmt.when(modified)` and
  `Fmt.stamp(modified)`.
* The scan is `MAX_FILES = 4000`, depth 4, `.mid`/`.midi` only, skipping dotted
  folders plus `node_modules .git forge-env "MIDI Studio Forge" pip-cache
  __pycache__`. `truncated:true` means the cap was hit and the list is **not** the
  whole library; say so in the UI.
* The melody pipeline's `_balanced` / `_detailed` siblings are folded out when
  their primary exists — those are versions of one song, not three songs. An
  orphaned candidate is still listed.
* `settings.merge` **replaces** arrays (invariant 38), so `library.dirs` is always
  written whole. `addFolder`/`removeFolder` already do that; never write it
  yourself piecemeal.
* Every write path in `main` that produces a MIDI already broadcasts
  `library-changed`, so `onChanged` is the refresh trigger. Do not poll.

### The four columns `library:list` does not have

The Library's centre view is specified with columns **Name / Length / Notes /
Source / Date Added / Tags**. `library:list` gives you Name, Date Added
(`modified`) and `size`. `length`, `notes`, `source` and `tags` have **no data
behind them today**, and this is how they must be obtained:

| Column | Source |
|---|---|
| Length, Notes | parsed from the file's own header/track data. **Not per render, and not for the whole library up front.** |
| Source | derived, not parsed: the folder a file sits in relative to `dirs[0]` (a Forge output) vs `dirs[1]` vs a user folder, plus the `_melody` / `_balanced` / `_detailed` naming the pipeline writes |
| Tags | user data. Not on disk, not in the MIDI |

Rules for whoever builds it:

1. **Do not parse in the render path.** A few thousand `.mid` files cannot be
   parsed per render, per sort or per scroll. Parse **lazily, only for rows that
   have been on screen**, from `onRender(first, last)`, at most a handful per frame,
   and write the result into the item so `renderRow` only ever reads a field.
2. **Cache it keyed by `path` + `modified` + `size`.** A cache entry whose
   `modified`/`size` no longer match is stale and re-parsed; that triple is the
   only cheap change detector available.
3. **Persist the cache outside settings.** Settings is a small deep-merged JSON
   document read on every `settings.get`; a few thousand metadata rows do not belong
   in it. Either `localStorage` under a `midi-studio:libraryMeta` key with a size
   cap and LRU eviction, or a new main-process channel that owns a JSON file next
   to the app's other state. If a new channel is added it goes in the table in
   §11.10 **before** it is used, and it must be additive — no existing channel
   changes (see the top of §11.10).
4. Show an em dash, never a zero, for a column that has not been parsed yet. A
   wrong number is worse than a blank.
5. Sorting on an unparsed column sorts the rows it has and appends the rest in the
   previous order — it must not block, and it must not trigger a full-library parse.

### Favorites is ONE store, shared with Self MIDI

Orphan 16: the Self MIDI favourites toggle and the Library's Favorites filter are
the **same** set, and building two is the defect. The store:

* **Key**: `ui.libraryFavorites` in settings — an array of absolute paths.
* **Read**: `studio.getUi().libraryFavorites || []`.
* **Write**: `studio.setUi({ libraryFavorites: [...next] })`. Settings **replaces**
  arrays (invariant 38), so always send the whole array; a debounced trailing write
  is fine and is what §9.6 is for.
* **Notify**: `Bus.send(Bus.TYPES.LIBRARY_CHANGED, { reason: 'favorites' })`. Every
  frame already listens for `library:changed`, so no new bus type is needed —
  filter on `reason` if you only care about favourites.
* Path comparison is **case-insensitive** (Windows), and a favourite whose file has
  gone is kept, not silently dropped, so a removable drive coming back does not
  lose the list. Mark it `.is-missing` (§2.9) instead.

---

# 12. Shared primitives that do not exist yet

SYNTHESIS lists 29 shared primitives. Twenty-four are on disk and documented
above. These five are **not built**, and this section exists so the first tab that
needs one builds it *here* rather than inside itself — which is what §0's "do not
invent a parallel one" means in practice.

**#25, the hotkey capture widget, has been built**: the Player was its first
consumer, so it landed as `renderer/shared/hotkey.js` and is documented in §9.7.

The rule for all six: it lands in `renderer/shared/`, it gets a section in this
document in the same shape as §9, and it gets added to §0's optional list. A tab
that needs one and builds it privately has created the second copy.

| SYNTHESIS # | Primitive | Where it belongs | First consumer |
|---|---|---|---|
| 9 | **Range / loop selection widget** — proportional edge hit-testing, handle drag, drag-select with a 3px deadzone, unmoved click = seek, keyboard nudge, `mm:ss(.mmm)` parse/format | `renderer/shared/range.js` (`Range`), driving a canvas or an absolutely-positioned overlay; it pairs with `TimelineZoom` for the time mapping and must reuse `Fmt.clock`/`Fmt.parseClock` | whichever of Forge time range / Editor loop / Player playback range / Self MIDI Loop A-B is built first. Invariant 20's proportional edge rule (`width>14 && right-x < min(8, width*0.3)`) is part of it, not a caller's job |
| 27 | **Audio preview engine** — one `AudioContext` owner, soundfont prepare with per-pitch decode + progress + a 2-instrument LRU, oscillator fallback including drum synthesis, envelope, voice pool | `renderer/shared/audio.js` (`Audio`). Self MIDI is the page that deliberately relaxes `script-src` to inject soundfont banks (invariant 30), so the module must work with and without a bank | Editor preview and Self MIDI — they must not open two `AudioContext`s. Note invariant 26: the scheduler is lookahead (~1.5s ahead of the Web Audio clock), never per-frame note firing |
| 28 | **Peak extraction worker** — decode + min/max bucketing off the main thread, returning a fixed bucket array | `renderer/shared/peaks.js` + `renderer/shared/peaks.worker.js`. A worker is `'self'` so the CSP allows it; the bucket array is what `Draw.LayerCache` keys its static layer on | Forge waveform and Editor waveform |
| 29 | **Frame-safe drag helper** — pointer capture, a bounding rect cached for the whole gesture, rAF-coalesced updates, `body.is-resizing` | `renderer/shared/drag.js` (`Drag`). `resize.js` already implements this shape for dividers; the general version is the same code without the custom-property specifics. `body.is-resizing` and `body.is-resizing iframe{pointer-events:none}` are already in the token layer | every canvas gesture: note drag, note resize, scrub, range handles |
| 15 | **Global search index** — files (the library scan), commands, settings panes, recent items, behind one debounced multi-term AND matcher | `renderer/shared/search.js` (`Search`). The shell's palette currently has its own matcher over commands + `library.list()` files; extracting it is the first step, and the shell must then use the extracted one | the Library's search field, then the palette |

Two things that are **not** on this list and must not be built:

* A second draw loop, a second transport owner, a second toast channel, a second
  update banner, a second context-menu placer, a second divider persister. All six
  exist; §10 forbids the parallel version.
* A fourth transport owner for the Library or Forge. A local preview is not an
  owner — §7.
