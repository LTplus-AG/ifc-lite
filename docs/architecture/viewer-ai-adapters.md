# Viewer AI native evidence adapter register

Coverage belongs to [#6833](https://github.com/LTplus-AG/ifc-lite/issues/6833), within P01/P03 and the [full implementation ledger](viewer-ai-implementation.md). This register distinguishes enabled adapters from required gaps. Only explicitly attached evidence is sent; a registered panel does not automatically become an AI source. The baseline charter inventoried 31 panels; adding Assistant makes the current registry 32.

## Enabled adapter contracts

| Context | Native owner / source | Included row meaning | Coverage, freshness and boundaries |
|---|---|---|---|
| Clash | `clashSlice.clashResult` / `clashRawResult`; `@ifc-lite/clash` | A native finding with both model-qualified references, rule, native status/severity, measured or estimated distance kind and native selector discipline candidates for each side | Native summary/settings/truncation retained; report and model stamps govern freshness. Overlapping candidates stay ambiguous; unmatched types stay unknown. Human reviews are not projected or changed. Candidates do not establish responsibility; BCF assignees require verified mapping. |
| IDS / information rules | `idsValidationReport`; native validators | A specification/cardinality summary, entity result or set result | Native counts, errors, applicability and source kind retained. Manual checklist is a distinct required adapter. |
| Compare | `compareResult`; native comparison service | A native diff entry and canonical base/head references | Native counts/scope/exclusions and geometry limitations retained. No AI promotion of ambiguous matches. |
| Flow | `flowDoc`; native registry/editor | Graph structure, with node/edge counts | Parameters, execution inputs/outputs and run state excluded. Typed graph patches have separate native validation and review. |
| Load report | `buildLoadReports(models)` in `lib/loadReport.ts`; canonical loaded-model diagnostics | One original-load report per model | Original native counters, load time/path, approximations and supplied affected identities. Absent diagnostics remain unavailable, never clean. Does not establish validation or complete affected-element coverage. |

All adapters currently project at most 100 rows, with bounded strings/depth/work and a 48,000-character complete JSON envelope. Native population counts remain independent of the included sample. Partial rows and omitted metadata are explicitly marked. Runtime model/revision pins stay local; saved conversations strip handles, credentials and current-freshness claims. Reports embed the exact included snapshot and state its historical/sample limits.

## Required remaining contexts

This is a gap list, not authorization to defer a context. Each family needs subtool-specific API/fixture measurements before its adapter is enabled.

| Native panels / family | Required source distinctions and native actions |
|---|---|
| Hierarchy / Properties | Effective attributes, inherited/type properties, quantities/materials/classifications/relationships, selected population and canonical overlay references; no buffer reparsing in retrieval loops. |
| Sources / Layers | Provider retrieval errors, revision associations, layer provenance and native overlay changes; endpoint grants and credentials never become report content or imported authorization. |
| Zones / Placement | Criteria, assigned population, workspace placements, source frames and units; native editors and restored scene state. |
| Changes / Change sets | Native mutation journal, expected prior values, undo ownership, export receipts and revision associations; separate from model comparison. |
| BCF | Local and server topics, viewpoints, review decisions, project vocabulary, publication receipts and uncertain outcomes; current scene references versus historical evidence. |
| Validation | Manual checklist answers/unsupported items and retained report history; conversational IDS/rule authoring and separate semantic profile validation. |
| Clash | Duplicate/coincident sets and native group/review evidence adapters, labeled classification policies and full-run classification beyond the discussion sample. Native manual membership now uses whole-partition CAS storage with backup/recovery; AI approve/apply/undo remains open. |
| Lens / Lists / Charts | Editable filter groups, actual query population, table mappings, native aggregation units and denominators, missing values and revision invalidation. |
| Measurements | Finished distance/polyline/angle/radius readings, stale placement markers, point/georeference readouts, native quantity and centreline inspection; unlike units/kinds cannot share an invented total. |
| Cost | Native quantities, rate schedule, currency/unit conversion, scope, missing rates and selection/federation distinctions. |
| Gantt | Native schedules, task/sequence validation, timing/playback/4D associations and unavailable dates; model-linked versus manually supplied facts. |
| Script / Extensions | Existing script chat and sandbox diagnostics, capability manifests, Plan Card and Ideas provenance; migration must preserve old transcripts and grants. |
| Flow | Actual run diagnostics/artifacts, tracking ownership, AI nodes and durable reviewed pause/resume; graph structure alone does not prove execution success. |
| Document / Presentation | Saved native blocks, source snapshots, edited report reconciliation, PDF warnings and captured views; original issued evidence stays immutable. |
| Appearance / Environment | Settings versus actual calculated/recorded outcomes; solar readouts/site/time and renderer/context availability; no invented daylight performance from display settings. |
| Point clouds | Captured classification/scan/deviation/registration/alignment outputs and algorithm availability; display palette/stride is not analytical evidence. |
| Drawing | Canonical section/drawing geometry and sheet/export diagnostics, units, cuts and annotation ownership. |
| Model | Full supported native builders, editing commands, relationships and geometry operations; parameter/permission/preview/undo/IFC roundtrip matrix. |
| Semantic | Read query results and partiality, supplied source records/spans, profile/schema/SHACL validation and native projections with revision identity. |
| Session / Assistant | Actual shared editing permissions and private/shared artifact boundaries; provider usage, task/proposal receipts and recovery state. |

## Completion evidence

The load adapter has native-counter and missing-diagnostic invariants, federated scope/replacement tests, a mounted real panel action and portable conversation/document validation. The real ArchiCAD browser journey checks captured failure counts against actual loaded-model diagnostics and records a screenshot when CI completes; wiring is not a completed run. Other adapters retain the evidence linked from the implementation ledger. Full adapter coverage and independent fixture acceptance are still outstanding.
