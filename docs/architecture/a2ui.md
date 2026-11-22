# A2UI in ifc-lite: generative IFC result surfaces

Status: in implementation on `research/google-a2ui`. Pinned to A2UI protocol **v1.0**
via `@a2ui/web_core@0.15.0`, `@a2ui/react@0.15.0`, `@a2ui/agent@0.1.0`.

## Why

Today the viewer chat answers with prose and `bim.*` code fences. Results come back as a
console `<pre>`. A2UI lets an answer carry a declarative UI tree (data, not code) that the
viewer renders from a catalog it controls. In ifc-lite that means: tables of real entities
that select in 3D, charts grouped by storey, colour legends, forms that re-run a query, and
buttons that isolate, colour or fly to a result set.

## Findings that shaped the design (adversarial review of the first sketch)

| Claim in first sketch | What is true | Consequence |
|---|---|---|
| "A2UI 1.0 stable with an official React renderer" | The protocol is 1.0. The packages are pre-1.0 (`0.15.0`), with breaking changes in each of the last five releases (Sep to Nov 2026). `@a2ui/react` documents itself as v0.9-native; v1.0 runs through the version-agnostic root plus `@a2ui/web_core/v1_0`. | Pin exact versions. Wrap all A2UI imports behind one module so an upgrade touches one place. |
| Upstream README examples work | `createProcessor({v1_0: ...})` from the `@a2ui/agent` README throws; the key is `'1.0'`. Reproduced. | Do not trust upstream docs; cover every entry point we use with a test. |
| Drops into the current model flow | The chat has no tool calling and the hosted proxy forwards text only (`lib/ids-agent/transport.ts:8-10`). | Use the text-embedded **Express** format (`<a2ui>…</a2ui>`), which needs no tools and works on the free tier. |
| Cheap to add | `@a2ui/agent` imports `fs`/`path` at module top (`skill/skill.js`, `processor/catalog-providers.js`): a browser bundle fails until both are aliased. Agent + renderer is ~185 KB gzip. Basic-catalog prompt snippet is ~22 k chars. | Lazy chunk only (eager ratchet stays flat), Vite alias to a stub, prune the catalog in the prompt. |
| "App builds the card from a typed query result" | Right instinct, but it left LLM-authored surfaces able to state facts (counts, rows) the model invented. | Facts are **bound**, never typed by the model: query-bound components and script-produced surfaces. |
| Nothing similar exists | The extensions **widget DSL** (`packages/extensions/src/widget/schema.ts`) is already a validated JSON component tree with a host renderer. | Reuse its shadcn node renderers for the catalog look; plan a widget DSL → A2UI bridge rather than a second UI language. |
| Basic catalog renders fine | The v0.9/v1.0 basic catalog renders as Lit custom elements with its own styling. | Implement ifc-lite's catalog as React components on our shadcn primitives and theme tokens. |

## Shape (modules, seams)

```
@ifc-lite/a2ui  (packages/a2ui, framework-agnostic, Node + browser)
  catalog/       IFC catalog v1.0 JSON document + component/function names (single source)
  agent.ts       createIfcAgent(): @a2ui/agent generator over the IFC catalog, prompt snippet,
                 StreamedAnswer factory, validatePayload
  refs.ts        EntityRef <-> "modelId:expressId" wire encoding
  query.ts       IfcQuerySpec: declarative, serialisable entity query (types, where, groupBy, limit)
  policy.ts      action/function policy: which run locally, which need confirmation, which go back to the agent
  builders.ts    deterministic surface builders (table, kpis, chart, legend) used by scripts and MCP
        |
        +-- apps/viewer/src/lib/a2ui/          (lazy) renderer runtime: MessageProcessor, function
        |                                       implementations bound to BimHost, action router
        +-- apps/viewer/src/components/a2ui/   (lazy) React catalog implementations
        +-- ChatPanel / ChatMessage            stream chunks -> StreamedAnswer -> surfaces in the turn
        +-- packages/sandbox  bim.ui.*         scripts present surfaces built from computed data
        +-- packages/mcp                       MCP App (ui:// resource) + tools returning
                                               application/a2ui+json; viewer_show_ui over the agent bridge
```

The one seam callers learn is `@ifc-lite/a2ui`: catalog id, `IfcQuerySpec`, entity ref
encoding and the builders. Everything A2UI-version-specific sits behind it and behind
`apps/viewer/src/lib/a2ui/`.

## The IFC catalog (`https://ifclite.dev/a2ui/catalogs/ifc/v1/catalog.json`)

Layout and text: `Column`, `Row`, `Card`, `Tabs`, `Divider`, `Text`, `Callout`, `Button`,
`ChoicePicker`, `TextField`, `Slider`, `CheckBox`.

IFC components (facts are bound, not literal):

- `EntityTable`: rows from an `IfcQuerySpec` evaluated in the viewer, or from a data-model path
  a script filled. Columns are attribute / pset.prop / quantity paths. Row click selects in 3D.
- `EntityList`: compact clickable list of entity refs.
- `EntityCard`: one entity's attributes, psets, quantities.
- `StatGroup`: KPI tiles; each value is a query count / sum or a data path.
- `GroupChart`: bar / pie / line over a query grouped by type, storey, material or a property.
- `ColorLegend`: colour-by-property legend that applies colours on mount and on toggle.
- `ActionBar`: viewer actions over a ref set (select, isolate, hide, show, colorize, fly to,
  section, export CSV) and follow-up prompts back to the agent.

Renderer functions (A2UI v1.0 functions, `allowedCallers` per `policy.ts`): `select`, `isolate`,
`hide`, `showAll`, `colorize`, `resetColors`, `flyTo`, `getSelection`, `countQuery`,
`exportCsv` (needs user activation), `ask` (posts a follow-up turn to the chat agent).

## Producers

1. **Chat (Express)**: the system prompt carries the pruned catalog snippet. The model writes
   prose plus `<a2ui>` blocks; `StreamedAnswer` validates and renders while streaming. Invalid
   blocks render an error part and feed the existing repair loop.
2. **Scripts**: `bim.ui.table/kpis/chart/legend/show` in the sandbox build surfaces from data
   the script computed. The host validates with `validatePayload` before rendering.
3. **External agents**: MCP tools return `application/a2ui+json` resources (MCP Apps hosts
   render them through the `ui://ifc-lite/a2ui` app), and `viewer_show_ui` pushes a surface into
   a live viewer tab over the agent bridge.

## Trust rules

- Surfaces are data. No HTML, no scripts, no URLs except allow-listed ones.
- Text renders through the existing escaped markdown path, never raw HTML.
- Viewer-only actions (select, isolate, colour, fly) run on click. Anything that writes a file
  or mutates the model needs a user gesture and a confirmation.
- Refs are model-aware (`modelId:expressId`); a ref to an unloaded model is inert and says so.
- Data-model contents go only to the agent that created the surface.

## Verification

- Unit: catalog document validates against the A2UI v1.0 catalog schema; every example in the
  prompt parses; builders produce payloads `validatePayload` accepts; policy table.
- Viewer: component tests for each catalog component; chat stream with a split `<a2ui>` block.
- E2E: load `AC20-FZK-Haus.ifc`, feed a recorded model reply, click a row, assert selection.
- Eval: recorded prompts across free and BYOK models, pass@1 on producing a valid surface.
- Bundle: `viewer-eager-js-bytes` unchanged; A2UI code only in on-demand chunks.
