# Headless surfaces: CLI, MCP, SDK

Principle 9: anything the UI can do, headless can do. All commands call the same packages.

## 1. CLI (`packages/cli`, extends the existing `ids` command)

| Command | Purpose | Key flags | Exit code |
|---|---|---|---|
| `ifc-lite ids <model.ifc> <rules.ids>` | Validate (existing) | `--json --locale` | 0/1 |
| `ifc-lite ids audit <rules.ids>` | Conformance audit | `--json` | 1 on errors |
| `ifc-lite ids lint <rules.ids> [--model m.ifc…]` | Lint (static, or model-aware with models) | `--json --severity --rules` | 1 on errors (configurable) |
| `ifc-lite ids fmt <rules.ids>` | Canonical formatting | `--check --write` | 1 if `--check` fails |
| `ifc-lite ids diff <a> <b>` | Semantic diff | `--json --md` | 1 if different |
| `ifc-lite ids convert <in> <out>` | xlsx/csv/yaml/json/idsz ⇄ ids | `--mapping m.json --sheet` | 1 on row errors |
| `ifc-lite ids explain <rules.ids>` | Plain-language rendering | `--lang en\|de\|fr\|it --md` | 0 |
| `ifc-lite ids preview <rules.ids> <model…>` | Funnel counts per spec | `--json` | 0 |
| `ifc-lite ids coverage <rules.ids> <model…>` | Ungoverned classes | `--json` | 0 |
| `ifc-lite ids test <doc.idsz>` | Run IDS test suites | `--junit out.xml --generate` | 1 on failures |
| `ifc-lite ids infer <model> --select "<selector>"` | Infer specs from elements (IfcOpenShell selector syntax via `packages/query`) | `--threshold --out` | 0 |
| `ifc-lite ids draft --from <file\|text>` | AI draft | `--model --effort --budget --non-interactive --out` | 0; 2 if unresolved > 0 with `--strict` |
| `ifc-lite ids edit <rules.ids> "<instruction>"` | AI edit | same | 0 |
| `ifc-lite ids bsdd <dictionaryUri> --classes …` | Dictionary → IDS (planned) | `--inherit`; conditional `--required-only` target below | 0 |

The planned `--required-only` scope is unavailable with the current `BsddClassProperty` shape: it has no required/optional metadata. CLI, MCP and SDK authoring must share the [bSDD mapping prerequisite](05-bsdd.md): a qualified typed SDK/API extension with recorded payload fixtures before offering this filter. Missing metadata cannot supply a required/optional default. This table is a target design, not a claim that these authoring commands or the conditional flag are implemented.

The CLI help text is the source of the generated table in `docs/guide/cli.md` (AGENTS.md), so docs are updated in the same PR.

## 2. MCP (`packages/mcp`)
Existing: `ids_validate`, `ids_explain`, `model_audit`, `bsdd_*`, query tools.

New:
| Tool | Notes |
|---|---|
| `ids_audit` | XML in, diagnostics out |
| `ids_lint` | XML (+ loaded model) in, diagnostics with quick-fix ops |
| `ids_read` | IDS → compact StudioDocument JSON (with node IDs) for agents |
| `ids_apply_ops` | Stateless: doc JSON + ops in → new doc + gate errors + diagnostics. **External agents get our grounding gate**, which supersedes thin MCP servers that just wrap a writer |
| `ids_write` | Doc JSON → canonical XML (audited) |
| `ids_schema_search` / `ids_schema_entity` / `ids_schema_pset` | Grounding lookups (same as agent tools) |
| `ids_preview` | Funnel counts against the loaded model |
| `ids_infer` | From a selector |
| `ids_coverage`, `ids_diff`, `ids_test` | As the CLI |

MCP prompt templates: `draft_ids_from_text`, `review_ids`, `ids_to_bcf` (existing `generate_bcf_from_ids`).

## 3. SDK (`packages/sdk`, `bim.ids.authoring`)
```ts
// illustrative
const doc = bim.ids.authoring.open(xml);
const res = doc.apply([{ kind: 'facet.add', payload: { /* … */ } }]);
if (!res.ok) console.log(res.errors[0].candidates);
const diags = doc.lint();
const funnel = await doc.preview(specId);   // against bim's loaded models
const xmlOut = doc.write();
```
Flow nodes (`packages/flow-nodes`) can wrap these for no-code pipelines: "Load IDS → Lint → Validate model → BCF".

## 4. Docs to ship
- `docs/guide/ids-studio.md` (UI)
- `docs/guide/ids-authoring.md` (ops, gate, SDK)
- `docs/guide/ids-lint/<rule>.md` (one page per rule)
- `docs/guide/ids-agent.md` (modes, privacy, eval scores)
- `docs/guide/ids-test-suites.md`
- Update `docs/guide/ids.md`, `cli.md`, `mcp.md`, `viewer-assistant.md` (remove "The viewer has no IDS editor").
