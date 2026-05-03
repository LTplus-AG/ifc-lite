# `/mcp` landing — three alternatives

This folder holds three production-quality landing-page candidates for the
`@ifc-lite/mcp` marketing surface, plus the data and shells they share. Each
variant is a single self-contained `.tsx` that reads the same catalog +
recipes + install configs from `./data.ts` so the **content** is identical
across all three; only the **design language** changes.

```
data.ts                 — shared content (catalog, clients, recipes, snippets)
types.ts                — typed shapes for the shared content
use-mcp-page.ts         — useFonts / useCopy / useDocumentMeta helpers
McpLandingA.tsx         — Variant A · "Atelier"        (editorial dev-tool)
McpLandingB.tsx         — Variant B · "Stage"          (cinematic dark)
McpLandingC.tsx         — Variant C · "Drafting Room"  (BIM craft)
McpLandingChooser.tsx   — flips between A/B/C via ?variant=
```

The catalog is read from
`apps/viewer/src/generated/mcp-catalog.json`, currently hand-seeded with the
real shape of the v0.1 surface. A future build step
(`node packages/mcp/dist/cli.js --dump-tools`) will overwrite that file at
release time without changing the page code.

---

## Compare them

```
/mcp              → Variant A (default)
/mcp?variant=a    → Variant A
/mcp?variant=b    → Variant B
/mcp?variant=c    → Variant C
```

A small floating chip in the bottom-right also lets you switch without
touching the URL. The chip is explicitly temporary and gets removed once a
winner is picked.

---

## Variant A — "Atelier"

> *Editorial dev-tool. Lineage: Stripe / Linear / JetBrains docs.*

| Aspect | Choice |
|---|---|
| Background | Warm paper `#fafaf6` (intentionally light-only) |
| Display | **Newsreader** — variable serif, optical sizes 6–72 |
| Body & code | **JetBrains Mono** for everything technical, Newsreader at small sizes for prose |
| Accent | Forest green `#1f4d35` for live elements, amber `#b8742a` for editorial markers |
| Layout | Narrow content column (`max-w-[68rem]`), 12-col internal grid, sticky-left tool nav |
| Distinctive moves | Numbered `§01–§03` sections · dropped capitals on the lede · margin "Marginal" notes (Issue · Filed under · Surface · Transports) · hairline filigree dividers · API-reference-style tool rows with `(required, fields)` parameter signatures |

**Strongest when:** the audience is engineers who scan tools/list pages
forensically and want signal density. The page reads like a printed
specimen — restrained, opinionated, deeply technical.

**Trade-offs:** the page is cool, not warm. Doesn't market the "agent
driving a building" feeling — the tool catalog is the centrepiece, not the
demo. Light-only feels deliberate but loses the developer dark-mode crowd.

---

## Variant B — "Stage"

> *Cinematic dark, demo-driven. Lineage: Linear marketing / Vercel AI / Apple keynote slides.*

| Aspect | Choice |
|---|---|
| Background | Deep ink `#0a0a0c` with a fractal-noise grain at 8% mix-overlay |
| Display | **Instrument Serif** with italic flex for the headlines |
| Body | **Bricolage Grotesque** (variable, weights 300–700) |
| Code | **JetBrains Mono** |
| Accent | Hi-vis chartreuse `#d6ff3f` (construction safety hint) + magenta `#ff5cdc` for interactions |
| Layout | Full-bleed sections, generous whitespace, oversized cards, horizontal recipe carousel |
| Distinctive moves | Hero contains a **live SVG IFC wireframe** that progressively colorises through 7 transcript steps (`viewer_color_by_storey` → `viewer_isolate(IfcWall)` → `viewer_colorize(...)`) so the visitor sees the agent driving the model · install grid as oversized cards with hover-glow · recipes as a horizontally scrollable transcript carousel with family-coloured headers · big italic numerals as section markers |

**Strongest when:** the goal is to make people *feel* the product before
they read about it. This is the "land on Twitter and screenshot" version —
the wireframe-in-motion is the kind of thing other dev-tool sites don't have.

**Trade-offs:** highest implementation surface (animation state, carousel,
gradients). The hero animation has to land flawlessly or it looks cheap.
Dark-only by design, which slightly clashes with the rest of the SPA's
light/dark toggle.

---

## Variant C — "Drafting Room"

> *BIM craft. Lineage: architectural section drawings, title blocks, Le Corbusier sketches.*

| Aspect | Choice |
|---|---|
| Background | Drafting-paper cream `#f4f1e8` over a hairline 8mm + 80mm grid |
| Display | **EB Garamond** (with italics for the "now drives an LLM" moments) |
| Body | **EB Garamond** (prose) + **JetBrains Mono** (every datum) |
| Annotations | **Caveat** — a hand-drafted face used for callouts, leader text, and pencil notes |
| Accent | Drafting-pencil red `#a8332d` for annotations, drafting blue `#4a6fa5` for live links |
| Layout | Title-block header (Sheet / Scale / Date / Drawn / Status / Version) · dimension-line section dividers with end-ticks and labelled spans |
| Distinctive moves | Hero figure is an **isometric IFC entity stack** (project → site → building → storey → wall) with leader-line callouts identifying live tool effects (`IfcWall #262 · painted via MCP`) · install rows formatted like a door-schedule (`I-01`, `I-02`, …) with Mark / Host / Spec / Type / Sht. columns · tool catalog renders as a **building schedule** with mark numbers (`01.07`), R/W/X scope chips, and a sticky storey-style legend · recipes as detail callouts with bubble + leader + "Sht. R-04" reference · north arrow + scale bar at the foot of the hero · sheet-footer pretends the page is a single drawing printed at 1:1 |

**Strongest when:** the audience is architects, structural engineers,
contractors. Nobody else in dev-tool marketing has shipped a landing that
respects the AEC craft tradition — the page itself reads as a drawing,
which is a pun the target audience will get and the LLM crowd will at
least notice. Strong word-of-mouth potential inside buildingSMART /
ifc-rs / IfcOpenShell circles.

**Trade-offs:** highest "design point of view" but smallest
"approachable for any LLM dev" surface. Someone unfamiliar with IFC may
read the page as a quirky theme rather than a marketing site. Light-only,
so dark-mode users see a flash on entry.

---

## How to pick

The three differ on **three axes**, not just colour:

| | Variant A | Variant B | Variant C |
|---|---|---|---|
| Centrepiece | Tool catalogue | Hero animation | Domain craft |
| Type discipline | Editorial | Cinematic | Technical drawing |
| Audience peak | Senior dev / docs reader | Founder / "show me the future" | AEC native / BIM circles |
| Risk if wrong | Feels too dry | Feels overproduced | Reads as gimmick |
| Permanence | High — easy to age well | Medium — animations age fastest | High — drafting visuals are timeless |

If the goal is **maximum reach across LLM developers**, B reads loudest.
If the goal is **lasting authority** with both engineers and AEC pros,
A is the safest. If the goal is **distinctive positioning** — the only
MCP landing that visibly came out of an architecture toolkit — C is the
strongest single-shot.

---

## Implementation notes

* All three variants share the same JSON snippet generator
  (`makeConfigSnippet`) so the install dialogs stay in lockstep — change
  it in one place when the bin gets renamed.
* All three call `useFonts(...)` which injects Google Fonts `<link>`
  stylesheets while mounted, and refcounts them so flipping between
  variants doesn't double-load. Fonts are intentionally NOT added to
  `index.html` so the main viewer keeps its existing first-paint budget.
* `useDocumentMeta(title, themeColor)` keeps the browser tab and theme
  colour aligned to whichever variant is mounted.
* The chooser writes `?variant=…` to the URL via `pushState`, so back
  button works and direct deep-links to a variant are possible.
* Tool rows are deep-linkable: `/mcp#viewer_get_selection`. All three
  variants honour this anchor.
* Recipes use `data.ts:RECIPES` and emit `data-uses` chips that
  link directly into the catalog anchors — single source of truth.

## Known follow-ups (not blocking the choice)

1. **Generated catalog**: replace `apps/viewer/src/generated/mcp-catalog.json`
   with output from `node packages/mcp/dist/cli.js --dump-tools` (CLI flag
   to be added). The current file is hand-seeded with the real v0.1
   surface so the page renders as production would.
2. **Playground link**: all three CTA the `/mcp/playground` route, which is
   a separate task. Until that ships, the link 404s — fine for design
   review.
3. **Fonts**: Google Fonts is fine for design comparison; production may
   want to self-host (woff2) for COOP/COEP compliance and stable
   first-paint.
4. **Remove the chooser chip** and replace this folder's exports with a
   single `McpLanding` once the winner is picked.
