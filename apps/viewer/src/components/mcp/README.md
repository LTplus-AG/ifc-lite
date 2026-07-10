# `/mcp` landing

This folder holds the `@ifc-lite/mcp` marketing surface: a single shipped
landing page (`McpLanding.tsx`) plus the in-browser playground and the data
and shells they share. `McpLanding` reads the catalog + clients + recipes +
install snippets from `./data.ts`, which is the single source of truth for
the page content.

```text
data.ts                 - shared content (catalog, clients, recipes, snippets)
types.ts                - typed shapes for the shared content
use-mcp-page.ts         - useFonts / useCopyToClipboard / useDocumentMeta helpers
McpLanding.tsx          - the shipped /mcp landing page ("Stage": cinematic dark)
HeroScene.tsx           - the animated Three.js IFC hero driven by McpLanding
McpPlayground.tsx       - the /mcp/playground route (in-browser IFC + BYOK chat)
playground-dispatcher.ts- browser tool dispatcher backing the playground
playground-files.ts     - playground sample/file plumbing
playground-uploads.ts   - playground upload handling
PlaygroundChat.tsx      - BYOK Anthropic chat UI for the playground
PlaygroundViewer.tsx    - inline Three.js viewer for the playground
```

The catalog is read from `apps/viewer/src/generated/mcp-catalog.json`,
currently hand-seeded with the real shape of the v0.1 surface. A future
build step (`node packages/mcp/dist/cli.js --dump-tools`) will overwrite
that file at release time without changing the page code.

---

## Routing

Routing is intentionally lo-fi (no router lib): `App.tsx` reads
`window.location.pathname` at boot and reacts to `popstate`.

```text
/mcp             -> McpLanding (marketing surface, no viewer/WASM boot)
/mcp/...         -> McpLanding
/mcp/playground  -> McpPlayground (parses an IFC in-browser, BYOK chat)
```

`/mcp` lives outside `BimProvider` so cold-loading the landing page is
cheap. `/mcp/playground` does parse IFCs in-browser, but uses its own
minimal pipeline rather than the full viewer stack.

---

## The landing page - "Stage"

> *Cinematic dark, demo-driven. Lineage: Linear marketing / Vercel AI / Apple keynote slides.*

| Aspect | Choice |
|---|---|
| Background | Deep ink `#0a0a0c` |
| Display | **Instrument Serif** with italic flex for the headlines |
| Body | **Bricolage Grotesque** (variable, weights 300-700) |
| Code | **JetBrains Mono** |
| Accent | Hi-vis chartreuse `#d6ff3f` (construction safety hint) |
| Layout | Full-bleed sections, generous whitespace, oversized cards, horizontal recipe carousel |
| Distinctive moves | Hero contains a **live Three.js IFC building** (`HeroScene.tsx`) that progressively colorises through the `HERO_STEPS` transcript (`viewer_color_by_storey` -> `viewer_isolate(IfcWall)` -> `viewer_colorize(...)`) so the visitor sees the agent driving the model - install grid as oversized cards - recipes as a horizontally scrollable transcript carousel with family-coloured headers - big italic numerals as section markers |

The page forces dark on its own subtree without flipping the global `.dark`
class, so the rest of the SPA is not affected when the user navigates away.
`McpLanding` is the single shipped variant; the earlier A/B/C design
comparison has been resolved in favour of this one.

---

## Implementation notes

* The landing shares one JSON snippet generator (`makeConfigSnippet` in
  `data.ts`) with the install dialogs so the snippets stay in lockstep -
  change it in one place when the bin gets renamed.
* `useFonts(...)` injects Google Fonts `<link>` stylesheets while mounted
  and refcounts them so mount/unmount does not double-load. Fonts are
  intentionally NOT added to `index.html` so the main viewer keeps its
  existing first-paint budget.
* `useDocumentMeta(title, themeColor)` keeps the browser tab and theme
  colour aligned while the landing is mounted, and restores them on unmount.
* Tool rows are deep-linkable: `/mcp#viewer_get_selection`. `scrollToAnchor`
  smooth-scrolls to the anchor and updates the URL hash.
* Recipes use `data.ts:RECIPES`; their `uses` chips call `scrollToAnchor`
  to jump straight into the catalog anchors - single source of truth.

## Known follow-ups

1. **Generated catalog**: replace `apps/viewer/src/generated/mcp-catalog.json`
   with output from `node packages/mcp/dist/cli.js --dump-tools` (CLI flag
   to be added). The current file is hand-seeded with the real v0.1
   surface so the page renders as production would.
2. **Playground**: the landing CTAs the `/mcp/playground` route, which is
   wired (see `McpPlayground.tsx`, the dispatcher, the inline Three.js
   viewer, and the BYOK Anthropic chat). The whole read+write tool surface -
   including BCF authoring, IDS validation, exports, and mutations - runs
   against an in-browser parsed IFC. No backend.
3. **Fonts**: Google Fonts is fine for now; production may want to self-host
   (woff2) for COOP/COEP compliance and stable first-paint.
