# Document model and the operation vocabulary

This is the heart of the design. Every surface (UI, grid paste, AI, imports, CLI, MCP) changes an IDS **only** by dispatching operations defined here (ADR-002).

## 1. Starting point: `@ifc-lite/ids` types (today)

- `IDSDocument { info, specifications[] }`
- `IDSSpecification`:
  - fields: `id`, `name`, `description?`, `instructions?`, `ifcVersions[]`, `ifcVersionRaw?`, `identifier?`
  - `applicability`: `{ facets[], cardinality? }`
  - `requirements[]`
  - `minOccurs?`, `maxOccurs?`
- `IDSRequirement`: `id`, `facet`, `optionality: required|optional|prohibited`, `cardinalityRaw?`, `description?`, `instructions?`
- `IDSFacet` = entity | attribute | property | classification | material | partOf (partOf has `relation`, `rawRelation?`, `entity?`).
- `IDSConstraint` = simpleValue | pattern | enumeration | bounds. Bounds covers min/max (in/exclusive), length, minLength, maxLength, totalDigits and fractionDigits. Pattern and enumeration carry `base?` and **`and?: IDSConstraint[]`** (conjunctive siblings of the same `xs:restriction`).

Observations:
- Specs and requirements already have `id`, but **applicability facets don't**.
- The parser's IDs are positional, not stable. We need stable UUIDs for ops, diff, comments and provenance.
- The type system already covers length/digits and conjunctions. **The writer refuses them** (P-01 fixes that).
- The audit lints only the primary family of a conjunctive restriction (stated in the code comment). P-01 extends this.

## 2. `StudioDocument`

```ts
// @ifc-lite/ids-authoring — illustrative, not final API
interface StudioDocument {
  readonly docId: Uuid;                 // stable across revisions
  readonly schemaVersion: 1;            // sidecar format version
  ids: IDSDocument;                     // the canonical content (no Studio-only fields)
  nodes: NodeIndex;                     // Uuid → NodePath, and NodePath → Uuid (bidirectional)
  meta: StudioMeta;                     // sidecar
}

type NodeKind = 'document' | 'spec' | 'applicabilityFacet' | 'requirement' | 'constraint';
// NodePath examples: ['spec', specUuid], ['spec', specUuid, 'app', facetUuid],
// ['spec', specUuid, 'req', reqUuid], ['spec', specUuid, 'req', reqUuid, 'field', 'value']

interface StudioMeta {
  provenance: Record<Uuid, Provenance[]>;      // who/what created & changed each node
  sources: Record<Uuid, SourceSpan[]>;         // traceability to documents
  comments: Record<Uuid, CommentThread[]>;
  suppressions: Record<Uuid, Suppression[]>;   // lint suppressions with reason
  tests: Record<Uuid /*spec*/, TestSuite>;
  mappings: SpreadsheetMapping[];              // saved Excel mappings
  revision: RevisionInfo;                      // parent hash, label, sign-offs
  unresolved: UnresolvedRequirement[];         // from AI/doc ingestion
  custom: { psets: CustomPsetDecl[] };         // explicitly declared custom psets/properties
}

type Provenance =
  | { by: 'user'; userId?: string; at: string; opId: Uuid }
  | { by: 'ai'; runId: Uuid; model: string; at: string; opId: Uuid }
  | { by: 'import'; format: 'ids' | 'xlsx' | 'csv' | 'yaml' | 'bsdd' | 'template' | 'infer'; ref?: string; at: string; opId: Uuid };

interface SourceSpan { docRef: string; kind: 'pdf' | 'docx' | 'xlsx' | 'text'; page?: number; para?: number; sheet?: string; cell?: string; quote: string }
```

**Invariants** (asserted by property tests):
1. `writeIdsXml(doc.ids)` never throws for any doc reachable through ops. The gate guarantees this, and the writer becomes total in P-01.
2. `parse(write(doc.ids))` is structurally equal to `doc.ids`, modulo IDs, which the sidecar maps back.
3. Every node in `doc.ids` has exactly one Uuid in `nodes`.
4. Sidecar keys refer only to live nodes, or to tombstones within the undo horizon.

**Re-identification on import:** when an external IDS is imported over an existing doc (e.g. a client sends v2), nodes are matched by `identifier` → `name` + facet signature → similarity. Matched nodes keep their Uuids, so comments and provenance survive (shared with diff, §6).

## 3. Operation vocabulary (v1)

All ops are plain JSON (serialisable for AI tool calls, logs, collaboration, MCP).

```ts
interface Op<K extends string, P> { kind: K; opId: Uuid; payload: P; }
```

### 3.1 Document
| Op | Payload | Notes |
|---|---|---|
| `doc.setInfo` | `{ field: 'title'\|'copyright'\|'version'\|'description'\|'author'\|'date'\|'purpose'\|'milestone', value: string\|null }` | `author` validated as email (XSD) |

### 3.2 Specification
| Op | Payload |
|---|---|
| `spec.add` | `{ specId, index?, name, ifcVersions, description?, instructions?, identifier?, cardinality?: 'required'\|'optional'\|'prohibited' }` |
| `spec.remove` | `{ specId }` |
| `spec.duplicate` | `{ specId, newSpecId, nameSuffix? }` |
| `spec.move` | `{ specId, toIndex }` |
| `spec.set` | `{ specId, field: 'name'\|'description'\|'instructions'\|'identifier', value }` |
| `spec.setCardinality` | `{ specId, cardinality }` → maps to minOccurs/maxOccurs |
| `spec.setIfcVersions` | `{ specId, versions }` |
| `spec.split` | `{ specId, byFacetIds: Uuid[], newSpecId }` (move requirements to a new spec with the same applicability) |
| `spec.merge` | `{ intoSpecId, fromSpecId }` (only if applicability, the `ifcVersions` set, and `minOccurs`/`maxOccurs` are identical, including omitted bounds; the gate refuses an incompatible merge and preserves both distinct specs) |

### 3.3 Facets
| Op | Payload |
|---|---|
| `facet.add` | `{ specId, section: 'applicability'\|'requirements', facetId, index?, facet: FacetDraft, optionality?, description?, instructions? }` |
| `facet.remove` | `{ facetId }` |
| `facet.move` | `{ facetId, toSpecId?, toSection?, toIndex }` (moving between sections is allowed; the gate checks semantics, e.g. no cardinality in applicability) |
| `facet.replace` | `{ facetId, facet: FacetDraft }` |
| `facet.setField` | `{ facetId, field: FacetFieldName, value: ConstraintDraft \| null }`. FacetFieldName ∈ entity.name, entity.predefinedType, attribute.name, attribute.value, property.propertySet, property.baseName, property.dataType, property.value, classification.system, classification.value, material.value, partOf.entity.name, partOf.entity.predefinedType, plus `uri` where IDS allows it |
| `facet.setRelation` | `{ facetId, relation: PartOfRelation }` |
| `requirement.setOptionality` | `{ facetId, optionality }` |
| `requirement.set` | `{ facetId, field: 'description'\|'instructions', value }` |

### 3.4 Values (constraints)
`ConstraintDraft` is the AI- and UI-friendly authoring form, normalised by the reducer into `IDSConstraint`:

```ts
type ConstraintDraft =
  | { kind: 'any' }                                       // field present, no value check (where IDS allows)
  | { kind: 'equals'; value: string | number | boolean }
  | { kind: 'oneOf'; values: (string | number | boolean)[] }
  | { kind: 'pattern'; pattern: string; base?: XsdBase }
  | { kind: 'range'; min?: number; minInclusive?: boolean; max?: number; maxInclusive?: boolean; unit?: string } // unit converted to SI
  | { kind: 'length'; exact?: number; min?: number; max?: number }
  | { kind: 'digits'; total?: number; fraction?: number }
  | { kind: 'all'; of: ConstraintDraft[] };              // conjunctive restriction
```

| Op | Payload |
|---|---|
| `value.set` | `{ facetId, field, value: ConstraintDraft }` (alias of `facet.setField` for value fields) |
| `value.addEnumValue` / `value.removeEnumValue` | `{ facetId, field, value }` |
| `value.convertKind` | `{ facetId, field, to: ConstraintDraft['kind'] }` (lossless conversions only, e.g. equals→oneOf) |

### 3.5 Bulk and semantic ops (compound; expand to primitive ops, so they are invertible)
| Op | Expands to |
|---|---|
| `bulk.renameProperty` | `{ fromPset, fromName, toPset, toName, scope: specIds? }` → many `facet.setField` |
| `bulk.retargetEntity` | `{ from: 'IfcWallStandardCase', to: 'IfcWall', scope }` |
| `bulk.expandAbstract` | `{ facetId }` → replace an abstract entity facet with N specs or an enumeration of concrete subtypes (user chooses the strategy) |
| `bulk.applyTemplate` | `{ templateId, params }` → spec.add + facet.add… |
| `bulk.fromBsddClass` | `{ classUri, include: { classification, entity, properties: uri[] } }` |
| `bulk.fromInference` | `{ inferenceId, accepted: candidateIds[] }` |
| `bulk.fromMapping` | `{ mappingId, rows: RowRef[] }` (spreadsheet import) |
| `bulk.setVersion` | `{ to: IFCVersion }` → retargets all specs with gate-checked renames (IFC2X3→IFC4 mapping table) |

### 3.6 Meta ops (sidecar only, never touch XML)
`meta.comment.add|resolve`, `meta.suppress.add|remove`, `meta.source.link`, `meta.unresolved.add|resolve`, `meta.test.add|remove|setExpectation`, `meta.custom.declarePset`.

## 4. Reducer, inverses, history
- `apply(doc, ops[]) → { doc', inverses[], touched: Set<Uuid> }`. Pure, synchronous, structural sharing (Immer-style, or hand-rolled for size).
- Every primitive op has an exact inverse computed at apply time (it captures the replaced value). Compound ops store their expansion.
- **History** = a list of `{ ops, inverses, provenance, at }` entries. Undo applies inverses. History is persisted in IndexedDB per document (FR-A03).
- **Transactions:** an AI proposal or a paste is one history entry, so a single undo reverts it entirely.
- **Collaboration (P-10):** the op log maps onto a Yjs document (Y.Map per node, Y.Array for order). Remote ops are re-validated by the gate locally; conflicts surface as diagnostics, not silent overwrites.

## 5. Grounding gate (ADR-003)
`check(ops, doc, ctx) → GateResult[]`, run before apply. `ctx = { schema: per-version tables (@ifc-lite/data), bsdd: cache, custom: declared customs }`.

| Check | Rule | Error code | Candidates |
|---|---|---|---|
| Entity exists in every `ifcVersion` of the spec | `findEntity(name, v)` | `GATE-ENT-001` | Fuzzy (Damerau + token) over entity names, boosted by hierarchy proximity |
| Entity naming | Accept any case on input; store EXPRESS PascalCase in the UI and UPPERCASE in XML as the writer expects | — | — |
| PredefinedType ∈ entity's enum (or USERDEFINED/NOTDEFINED) | per version | `GATE-PDT-001` | Enum members |
| Attribute exists on entity (including inherited) | `getAttributes` | `GATE-ATT-001` | Attributes of the entity |
| Pset with a reserved prefix exists in the version | `findPropertySet` | `GATE-PSET-001` | Psets applicable to the applicability entities first |
| Property exists in that standard pset | table | `GATE-PROP-001` | Properties of the pset; same-named properties in other psets |
| Enumeration values ⊆ property enumeration (standard psets) | table | `GATE-ENUM-001` | Enum members (case-folded match suggested) |
| dataType ∈ IFC data types for the version; consistent with the standard property's type | `findDataType` | `GATE-DT-001` | Correct dataType |
| Custom pset: name not reserved, declared or auto-declared with `custom` flag | `RESERVED_PSET_PREFIXES` | `GATE-CUST-001` | Suggest a `Project_` style prefix |
| Constraint well-formed: bounds min ≤ max, pattern compiles (XSD → JS translator) and passes the ReDoS guard, lengths ≥ 0, numeric values parse for numeric base | `xsd-regex`, `regex-guard` | `GATE-VAL-00x` | — |
| Structural: no cardinality on applicability; partOf has entity; facet field allowed for facet type | XSD rules | `GATE-STR-00x` | — |
| bSDD URI resolvable (if online; else deferred to lint) | bSDD cache | `GATE-BSDD-001` (warning-level, non-blocking when offline) | Search by label |

Gate output is **data** (`{ ok: false, code, path, message, candidates[] }`), returned verbatim to the agent and shown in the UI. **Patterns and names on non-standard identifiers are not blocked:** a pattern on pset name (e.g. `Pset_.*Common`) is legal IDS. The gate validates only *literal* standard names, and the lint layer handles the rest.

## 6. Diff and merge (shared with re-identification)
- **Matching** (in order): same Uuid → same `identifier` → same name + same applicability signature → similarity score over (name tokens, applicability facets, requirement facets) ≥ τ. Unmatched = added/removed.
- **Facet-level diff** within matched specs, with the same cascade on facet signature.
- **Output:** `DiffEntry[]` (added/removed/changed with field paths, old/new), each renderable as plain language ("Doors: FireRating changed from optional to required").
- **Three-way merge:** base/ours/theirs on the op level. Non-overlapping changes auto-merge. Overlapping field changes become conflicts that are resolved by choosing an op.

## 7. Formatting (`fmt`)
Deterministic writer settings: 2-space indent, `ids:`/`xs:` prefixes, attribute order as XSD declares, info fields in XSD order, specs in document order, no trailing whitespace, LF. Golden tests. `fmt` makes git diffs of IDS readable for teams that keep IDS in repositories.

## 8. Versioning of the op schema
- `opsVersion: 1`. Ops are additive. Renames require a migration function `vN→vN+1` for persisted logs.
- Agent tool JSON Schemas come from the **same schema the runtime validator interprets** (`validateOp` / `getOpJsonSchema` in `@ifc-lite/ids-authoring`). The AI's contract therefore can't drift from the reducer. (The plan said zod; the workspace has no zod, so the contract is written once as JSON Schema — see §9.)

## 9. As built in P-02 (deviations from the sections above)
`@ifc-lite/ids-authoring` 0.1.0 (draft PR #7168) implements this document with the following differences. Each is recorded with its reasoning in `worklog/P-02.md`. Later ops PRs must keep this section current.

| # | Plan said | As built | Why |
|---|---|---|---|
| 1 | zod schemas → JSON Schema | One JSON Schema plus a small interpreter that both validates and exports | No zod in the workspace; a single source still prevents drift |
| 2 | Inverses expressed with the public ops | Four extra undo ops: `spec.restore`, `spec.patch`, `facet.restore`, `facet.patch` (raw IDS content + node ids) | Exact restoration of everything, including import leftovers |
| 3 | `ValueInput` is a draft | Also `{kind:'raw', constraint}` (verbatim `IDSConstraint`) | Lossless round-trips of imported values |
| 4 | Ops carry all ids | `constraintIds` / `constraintId` optional; derived deterministically from `opId` when absent | Keeps `apply` pure without forcing callers to mint ids |
| 5 | — | `meta.custom.declareUserDefinedType` / `removeUserDefinedType`; `StudioMeta.custom.userDefinedTypes` | The gate refuses a predefinedType outside the entity enumeration unless declared; otherwise an invented value passes as "user-defined" on any entity that allows USERDEFINED |
| 6 | `NodeIndex` as id → path map | `NodeIndex` mirrors the document shape; spec / requirement `id` fields carry node UUIDs | Simpler lookups, cheap verification (`verifyNodeIndex`) |
| 7 | `bulk.applyTemplate { templateId }` | Template passed inline | Reducer needs no template registry |
| 8 | Gate result per op | `checkOps` → `{ok, issues[]}`; each issue has `opIndex`, `facetId`, `field`, `value`, `versions`; undo/redo don't re-run the gate | Replaying an already-gated history must not be refused later |
| 9 | Gate codes as in §5 | Extra codes OP-001/002, CUST-002…004, STR-001…008, VAL-001…008 (listed in the package README) | Structural and value rules live in the same checker |
| 10 | `meta.provenance` written by ops | Provenance stored on history entries | Writing it from the reducer would break exact undo |
| 11 | Full §3 vocabulary | Not yet: `spec.split`, `spec.merge`, `value.convertKind`, `bulk.expandAbstract`, `bulk.fromBsddClass`, `bulk.fromInference`, `bulk.fromMapping`, `bulk.setVersion`, remaining `meta.*`; gate rule GATE-BSDD-001 | Follow-ups in P-02, P-05 (inference) and P-06 (bSDD) |

**Open question (owner):** should `studio.json` carry a content snapshot so an `.idsz` can be re-identified on its own after an external edit? Today the matcher needs the previous document (e.g. from the local library).
