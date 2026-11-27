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
2. **Scripts**: `bim.ui.table/stats/chart/legend/actions/callout/entity/list/show` build surfaces
   from script results. The sandbox validates the section specs and builds the A2UI messages on
   the host.
3. **External agents**: MCP tools return `application/a2ui+json` resources (MCP Apps hosts
   render them through the `ui://ifc-lite/a2ui-surface` app), and `viewer_show_ui` pushes a surface into
   a live viewer tab over the agent bridge.

## MCP result surfaces

The model-serving MCP server computes `present_query` against its loaded IFC model.
The query uses `IfcQuerySpec` and requires `columns`. It accepts optional `modelId`, `groupBy` and `title`.
The count covers all matches. The table, grouped chart and action targets cover
the rows included by `query.limit`. `present_ids_results` takes the
`ids_validate` arguments and `present_clash_results` takes the `clash_check`
arguments. Both accept an optional `title` and run the underlying check before
building a surface.

Each tool returns a text summary and an embedded `application/a2ui+json` resource.
The entry tools advertise `_meta.ui.resourceUri` pointing to
`ui://ifc-lite/a2ui-surface` with visibility `["model", "app"]`. The resource is
self-contained HTML with MIME type `text/html;profile=mcp-app`. The iframe uses the
web core message processor and the IFC catalog to bind data to DOM components.
Query-only components say that the result is computed in the viewer. The iframe
can read only the result it receives, and uses the host's JSON-RPC relay to call
the app-only `a2ui_viewer_action` tool. Select, isolate, colorize, fly to and reset
operate on the session's connected WebGL viewer. The session checks model-qualified
refs before sending a command.

To try it in Claude Desktop, configure the [stdio server](../guide/mcp.md#wiring-it-into-a-client)
using the built MCP command and an absolute IFC path. Restart Claude Desktop and
ask it to call `present_query` for `IfcWall` with columns `Name` and `type`,
grouped by `storey`. An MCP Apps-enabled host can display the result; the same
tool call includes a text summary for any host. To test the row actions, open the
browser URL returned by `viewer_open` for that model and click a row in the app.
See the [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
and the [A2UI MCP Apps guide](https://a2ui.org/guides/a2ui-in-mcp-apps/).

In bridge mode, call `bridge_status` to pair a main viewer tab, then call
`viewer_show_ui` with either a v1.0 `messages` array or a builder `spec`
(`surfaceId`, `sections`, and optional `title` and `card`). The bridge validates
the payload and waits for the paired tab to acknowledge storing it. The tab
exposes the stored surfaces through `agentSurfaces` for the viewer panel. Tabs advertise support in
`hello.a2uiSurface`; the bridge lists `viewer_show_ui` only for a tab supporting
that frame.

Clicks travel back. The bridge advertises `ui-events` in `welcome.features`; the
tab then sends a follow-up click on an agent surface as a `ui-event` frame
(`surfaceId`, `name`, `prompt`, `context`), bounded to a 4,000-character prompt,
8 KiB of context and 10 events per second. The agent reads them with
`viewer_ui_events` (optionally waiting for the next one). With `--channel` the
bridge also declares the Claude Code `claude/channel` capability and pushes each
event as a `notifications/claude/channel` message, so a click arrives in a
running Claude Code session as a turn of its own. Events stay queued either way,
so a client that ignores channels loses nothing. The repository root is a
Claude Code plugin marketplace whose `ifc-lite` plugin (`.claude/`) bundles the
`use-ifclite` skill and this bridge.

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
- E2E: load `building-architecture.ifc`, play a recorded model reply, click a row, assert selection.
- Eval: recorded prompts across free and BYOK models, pass@1 on producing a valid surface.
- Bundle: `viewer-eager-js-bytes` unchanged; A2UI code only in on-demand chunks.

## Generation eval (2026-11-22)

`packages/a2ui/eval/run-eval.mjs` sends nine viewer-style questions about AC20-FZK-Haus to a model
with the IFC catalog prompt (~26.5 k chars, Express format) and scores each reply with the real parser.
First run, temperature 0.3, through OpenRouter:

| Model | Replies | Compiled | Expected components | Literal facts typed |
|---|---|---|---|---|
| z-ai/glm-5.3-flash (free tier) | 9 | 9 | 8 | 0 |
| qwen/qwen3.7-flash (free tier) | 9 | 8 | 6 | 0 |
| qwen/qwen3-coder-next (free tier) | 6 (3 rate-limited) | 6 | 5 | 0 |
| anthropic/claude-sonnet-5.5 | 9 | 9 | 8 | 0 |
| anthropic/claude-haiku-5.5 | 9 | 9 | 8 | 0 |
| openai/gpt-6-luna | 9 | 9 | 8 | 0 |
| google/gemini-3.8-flash | 9 | 9 | 8 | 0 |

The one compile failure (qwen3.7-flash) was an Express syntax error the stream reports as an error
part. The "clarify" case expected a ChoicePicker; every model instead ran a broad check, which is a
reasonable answer, so that expectation was dropped. Replies asked for sorted tables, so
`EntityTable` gained `sort`. Nine prompts is a smoke test, not a benchmark.

## Viewer renderer (`apps/viewer`)

Everything below loads on demand. The eager bundle carries only the validation of the `a2ui` field of
a stored chat message, the `?a2uiDemo` check and the locale key table; the chat-side pieces
(`lib/llm/a2ui-blocks.ts`, `lib/llm/a2ui-prompt.ts`) ride in the lazy chat chunk.

| Module | Role |
|---|---|
| `lib/a2ui/host.ts` | `A2uiViewerHost`: what a surface may read or do, implemented once over the SDK `BimContext` |
| `lib/a2ui/query-eval.ts` | `IfcQuerySpec` → entity rows across every loaded model; field paths (built-ins, attributes, `Pset.Prop`, `Qto.Quantity`) |
| `lib/a2ui/functions.ts` | IFC function implementations behind one gate that enforces `IFC_FUNCTION_POLICY` |
| `lib/a2ui/catalog.ts` | renderer catalog: `createIfcCatalog` with the React components and host-bound functions |
| `lib/a2ui/session.ts`, `chat-sessions.ts` | one `MessageProcessor` per chat message, fed while streaming, persisted, replayed |
| `components/a2ui/` | the 20 components on shadcn primitives; `SegmentsView` orders prose, surfaces and errors |
| `components/viewer/chat/A2uiChatContent.tsx` | the chat's lazy entry, mounted only for replies with an `<a2ui>` block or a stored record |

Decisions worth knowing before changing it:

- **Prose is split by the viewer, not the parser.** The Express parser drops a ```` ``` ```` fence next
  to a tag (it reads it as a wrapper), which also dropped the closing fence of a code block right
  before a surface. `splitA2uiReply` splits prose and blocks (a fence counts as a wrapper only when it
  opens one) and the parser is fed the blocks alone; what it emits is credited to the block being fed.
- **Persistence stores messages, not text.** A finalised message records its segments
  (`ChatMessage.a2ui`); a reload applies the recorded messages to a fresh processor without the parser.
  The streaming message's session is adopted by the final message when the text matches, so the
  surfaces are not rebuilt and their data model (bound input values) carries over. The chat remounts the
  message element at finalisation, so React-local view state (a re-sorted column, the table page) resets.
- **Aggregates count every match.** A query's `limit` (default 500) bounds the rows a table or list
  shows; stats, charts and legends use every match unless the query set its own limit.
- **Refs to unloaded models are inert, with a note.** Nothing falls back to the same express id in another model.
- **One block per reply.** Two blocks in one reply both create surface `main` and the second is rejected,
  so the chat rules tell the model to start a second block with `surface("<new id>")`. A rejected block
  shows a notice with an "Ask to fix" button that sends a repair turn.
- **Follow-ups are text.** The chat forwards text only, so an `Event`'s context travels as one
  `(context: {...})` line after the prompt.
- **System prompt.** `withA2uiPrompt` appends the catalog section (about 27 k characters, rendered by the
  agent parser, cached after the first turn) before the personal overlay, so the shared prefix stays cacheable.
- **Locales.** The English catalogue (`i18n/catalogues/a2ui.en.ts`) is lazy and ships with French, German
  and Italian translations; `i18n/a2ui-catalogue-shape.ts` is the small eager key/placeholder table that lets
  a locale validate before the chunk loads.

Other code shows a surface through `lib/a2ui/surface-host.ts`:

<!-- docs-check: skip -->
```tsx
<A2uiMessagesView messages={payload} onFollowUp={(text, context) => …} />
```

It validates with `validateIfcMessages` and renders inside the app's `BimProvider`.

### Demo without an API key

Open `/?model=/samples/building-architecture.ifc&a2uiDemo=1`. Once the model has loaded, the chat
opens and plays a recorded reply (`lib/a2ui/demo-reply.ts`) through the same store fields a model
stream writes, so the surfaces build while the text streams. No request leaves the browser. The
reply targets the committed sample (4 walls, 3 slabs, 2 spaces, 1 roof); `session.test.ts` parses
it with the real parser and `tests/e2e/a2ui-chat-surface.e2e.spec.ts` clicks its table.
