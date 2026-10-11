# @ifc-lite/ids-authoring

Headless authoring core for IDS (buildingSMART Information Delivery
Specification) documents. A UI, an AI agent, an import or the CLI changes an
IDS only through the typed, invertible operations defined here. Every
operation passes a grounding gate first, which checks names against the IFC
schema tables of `@ifc-lite/data`.

- **`StudioDocument`**: the `@ifc-lite/ids` `IDSDocument`, plus a stable UUID
  for every node (specification, applicability facet, requirement and
  constraint) and the Studio sidecar (`meta`).
- **Operation vocabulary v1**: plain JSON ops. One JSON Schema is used both
  to validate ops at runtime and as the tool schema handed to AI agents.
- **Reducer**: `apply(doc, ops)` is pure and records the exact inverse of
  every op, so undo restores a deep-equal document.
- **Grounding gate**: `checkOps(ops, doc, ctx)` returns issues as data
  (`code`, `path`, `message`, ranked `candidates`). It never throws on bad
  input.
- **History**: transactions and undo/redo, plus a `PersistenceAdapter`
  interface.
- **Sidecar**: `studio.json` and `.idsz` bundles.
- **Re-identification** of externally edited IDS files.
- **Plain-language rendering** of facets in English, German and French.

## Quick example

```ts
import {
  checkOps,
  commit,
  createGateContext,
  createStudioDocument,
  createStudioState,
  undo,
  uuidv7,
  type StudioOp,
} from '@ifc-lite/ids-authoring';

const ctx = await createGateContext();
let state = createStudioState(createStudioDocument({ title: 'Fire safety' }));

const specId = uuidv7();
const ops: StudioOp[] = [
  { kind: 'spec.add', opId: uuidv7(), payload: { specId, name: 'Doors', ifcVersions: ['IFC4'] } },
  {
    kind: 'facet.add',
    opId: uuidv7(),
    payload: { specId, section: 'applicability', facetId: uuidv7(), facet: { type: 'entity', name: { kind: 'equals', value: 'IfcDoor' } } },
  },
  {
    kind: 'facet.add',
    opId: uuidv7(),
    payload: {
      specId,
      section: 'requirements',
      facetId: uuidv7(),
      facet: {
        type: 'property',
        propertySet: { kind: 'equals', value: 'Pset_DoorCommon' },
        baseName: { kind: 'equals', value: 'FireRatng' }, // typo
      },
    },
  },
];

const gate = checkOps(ops, state.doc, ctx);
// gate.ok === false
// gate.issues[0] → { code: 'GATE-PROP-001', path: 'ops[2].payload.facet.baseName',
//                    candidates: [{ value: 'FireRating', … }], … }

if (gate.ok) {
  state = commit(state, ops, { source: { by: 'user' } }).state; // one history entry
  state = undo(state); // reverts all three ops
}
```

## Operations (opsVersion 1)

All ops have the shape `{ kind, opId, payload }`. `getOpJsonSchema()` returns
the full JSON Schema and `validateOp(value)` checks an untrusted value
against it.

| Group | Kinds |
|---|---|
| Document | `doc.setInfo` |
| Specification | `spec.add`, `spec.remove`, `spec.duplicate`, `spec.move`, `spec.set`, `spec.setCardinality`, `spec.setIfcVersions` |
| Facet | `facet.add`, `facet.remove`, `facet.move`, `facet.replace`, `facet.setField`, `facet.setRelation`, `facet.setUri` |
| Requirement | `requirement.setOptionality`, `requirement.set` |
| Value | `value.set`, `value.addEnumValue`, `value.removeEnumValue` |
| Sidecar | `meta.custom.declarePset`, `meta.custom.removePset`, `meta.custom.declareUserDefinedType`, `meta.custom.removeUserDefinedType`, `meta.suppress`, `meta.unsuppress` |
| Comments | `meta.comment.add`, `meta.comment.reply`, `meta.comment.resolve`, `meta.comment.removeThread`, plus the inverses `meta.comment.removeReply` and `meta.comment.restoreThread` (sidecar only) |
| Test suites | `meta.test.add`, `meta.test.remove`, `meta.test.setExpectation`, plus the inverse `meta.test.restore` (sidecar only) |
| Compound | `bulk.renameProperty`, `bulk.retargetEntity`, `bulk.applyTemplate`, `bulk.fromBsddClass` (each expands to primitive ops and undoes in one step) |
| Fidelity | `spec.restore`, `spec.patch`, `facet.restore`, `facet.patch` (emitted as exact inverses; they carry raw IDS content and node ids) |

Values are written as a `ConstraintDraft`, which the reducer normalises into
an `IDSConstraint`:

- `any`, `equals`, `oneOf`, `pattern`;
- `range`, with an optional `unit` that is converted to SI;
- `length`, `digits`;
- `all`, a conjunction of the above;
- `{ kind: 'raw', constraint }`, a verbatim `IDSConstraint`.

Literal entity names and data types are stored in upper case, as they appear
in IDS XML.

## Gate codes

| Code | Meaning |
|---|---|
| `GATE-OP-001` / `-002` | Malformed op / bad template parameters |
| `GATE-ENT-001` | Entity does not exist in every IFC version of the spec (also partOf entities) |
| `GATE-PDT-001` | Predefined type not in the entity's enumeration (user-defined values must be declared) |
| `GATE-ATT-001` | Attribute not on the applicability entity (inherited attributes included) |
| `GATE-PSET-001` | `Pset_`/`Qto_` name is not a standard set (`Qto_` is unverifiable for IFC2X3/IFC4 and accepted until P-01's IDS-009 schema rows exist) |
| `GATE-PROP-001` | Property not in the standard set |
| `GATE-ENUM-001` | Value not in the standard property's enumeration |
| `GATE-DT-001` | Unknown data type, or inconsistent with the standard property |
| `GATE-CUST-001…004` | Undeclared custom set / reserved prefix on a custom set / property not declared / nothing to remove |
| `GATE-SUP-001…003` | Suppressions: rule is not a lint code or wildcard / blank reason / nothing to remove |
| `GATE-STR-001…009` | Structure: unknown or duplicate node, required field, requirement-only data in applicability, partOf without entity, restricted dataType, index range, empty name or duplicate versions, optional entity requirement, `uri` outside a requirement |
| `GATE-VAL-001…009` | Values: draft error, min > max, pattern does not compile, ReDoS guard, length/digit facets, literal invalid for its base, author/date, enumeration edit on a non-enumeration, `uri` not absolute |
| `GATE-BSDD-001` | A facet `uri` the bSDD URI index knows to be unresolvable (blocking) or inactive (`severity: 'warning'`, not blocking). Unchecked URIs pass. |

Patterns on names (for example `Pset_.*Common`) are valid IDS and are never
blocked. Only literal names are grounded.

## Lint

The audit in `@ifc-lite/ids` answers "is this a valid IDS 1.0 file?". Lint
answers "does it mean what the author intends?". `createLinter(ctx)` runs the
rule catalogue over a `StudioDocument` and returns `Diagnostic[]` (stable
`IDSL-<AREA>-<nnn>` code, severity, node id, message, rationale, docs URL,
quick fixes).

```ts
import { checkQuickFix, createLintContext, createLinter, type StudioDocument } from '@ifc-lite/ids-authoring';

declare const doc: StudioDocument;
const ctx = await createLintContext();
const linter = createLinter(ctx); // keep one per open document
const { diagnostics, suppressed } = linter.lint(doc);
const fix = diagnostics[0]?.fixes?.[0];
if (fix && checkQuickFix(doc, fix, ctx.gate).ok) {
  // commit(state, fix.ops) like any other edit; fixes are never auto-applied
}
```

- **Incremental.** Specification-level findings are cached; a later pass
  re-runs only the specifications whose content changed (pass the reducer's
  `touched` set as a hint if you have it).
- **Quick fixes** are op batches. Every fix the catalogue offers passes the
  grounding gate on the document it was computed for.
- **Suppressions** live in the sidecar, `meta.suppressions[nodeId]`, as
  `{ rule, reason, by?, at }`. A suppression applies to the node and
  everything below it, `rule` may be an area wildcard (`IDSL-SPEC-*`), and
  one without a reason is ignored. Write them with the ops
  `meta.suppress { nodeId, suppression, index? }` (a second suppression of
  the same rule on the same node replaces the first) and
  `meta.unsuppress { nodeId, rule }`. Both undo exactly. The gate refuses an
  unknown node (`GATE-STR-001`), a rule that is not `IDSL-<AREA>-<nnn>`,
  `IDSL-<AREA>-*` or `IDSL-*` (`GATE-SUP-001`) and a blank reason
  (`GATE-SUP-002`). Removing a suppression that is not there is
  `GATE-SUP-003`.
- **Severity.** Defaults are per rule; `createLinter(ctx, { severity: { code: 'off' | … } })`
  overrides them. Rules that rest on an unverified IDS semantic ship at
  `info`.
- **Opt-in rules** (`IDSL-ENT-003`, `IDSL-SPEC-008`) are off by default
  because they fire on most real documents. Enable one by giving it a
  severity (`severity: { 'IDSL-SPEC-008': 'info' }`) or by naming it in
  `rules`.
- `explainXsdPattern(pattern)` explains an XSD pattern part by part.

Per-rule pages: `docs/guide/ids-lint/` (generated by
`scripts/generate-lint-docs.mjs`).

| Code | Severity | Rule | Quick fix |
|---|---|---|---|
| `IDSL-ENT-001` | error | Abstract entity in an entity facet | yes |
| `IDSL-ENT-002` | info | Entity removed in IFC4X3 | yes |
| `IDSL-ENT-003` | info (opt-in) | Entity has subtypes the author may also mean | yes |
| `IDSL-ENT-004` | warning | Type entity where an occurrence is meant | yes |
| `IDSL-ENT-005` | warning | Entity name not in upper case | yes |
| `IDSL-PDT-001` | error | Predefined type not in the entity enumeration | yes |
| `IDSL-PDT-002` | info | USERDEFINED predefined type without an ObjectType requirement | yes |
| `IDSL-PDT-003` | info | Undeclared user-defined predefined type | yes |
| `IDSL-ATT-001` | error | Attribute not defined on the entity | yes |
| `IDSL-ATT-002` | warning | Value check on an entity-typed attribute | yes |
| `IDSL-PSET-001` | warning | Standard property set not applicable to the entity | yes |
| `IDSL-PSET-002` | error | Custom property set with a reserved prefix | yes |
| `IDSL-PSET-003` | warning | Quantity set with a non-measure data type or value | yes |
| `IDSL-PROP-001` | error | Property not in the standard property set | yes |
| `IDSL-PROP-002` | warning | Data type differs from the standard property | yes |
| `IDSL-PROP-003` | info | Numeric constraint without a data type | yes |
| `IDSL-VAL-001` | error | Value not in the standard enumeration | yes |
| `IDSL-VAL-002` | warning | Restriction base incompatible with the data type | yes |
| `IDSL-VAL-003` | warning | Simple value that looks like a list | yes |
| `IDSL-VAL-004` | warning | Simple value that looks like a comparison | yes |
| `IDSL-VAL-005` | warning | Boolean literal in a form IDS does not accept | yes |
| `IDSL-VAL-006` | info | Leading or trailing whitespace, or invisible characters | yes |
| `IDSL-VAL-008` | info | Exact match on a real number | no |
| `IDSL-UNIT-001` | warning | Magnitude suggests a non-SI unit | yes |
| `IDSL-REGEX-001` | warning | ^ or $ in an XSD pattern | yes |
| `IDSL-REGEX-002` | warning | Pattern that is a plain value or matches everything | yes |
| `IDSL-REGEX-003` | warning | Construct not supported by XSD regex | yes |
| `IDSL-REGEX-004` | error | Catastrophic backtracking risk | no |
| `IDSL-CARD-001` | warning | Prohibited requirement with a value or data type | yes |
| `IDSL-CARD-002` | info | Optional requirement that checks nothing | yes |
| `IDSL-CARD-003` | warning | Prohibited specification with requirements | yes |
| `IDSL-CARD-004` | info | Required specification with a narrow applicability | yes |
| `IDSL-SPEC-001` | warning | Requirement that can never fail | yes |
| `IDSL-SPEC-002` | error | Contradictory requirements | no |
| `IDSL-SPEC-003` | warning | Applicability that can never match | no |
| `IDSL-SPEC-005` | warning | Duplicate specification | yes |
| `IDSL-SPEC-006` | warning | Overlapping specifications with conflicting requirements | no |
| `IDSL-SPEC-007` | info | Specification without requirements | no |
| `IDSL-SPEC-008` | info (opt-in) | Specification without description or instructions | no |
| `IDSL-SPEC-009` | warning | Duplicate identifier | yes |
| `IDSL-DOC-001` | error | Author is not an e-mail address, or date is not xs:date | yes |
| `IDSL-VER-001` | warning | Name valid in only some IFC versions of the specification | yes |
| `IDSL-PART-001` | info | Unlikely partOf relation for these entities | yes |
| `IDSL-BSDD-001` | warning | bSDD URI not found or inactive | yes |
| `IDSL-BSDD-002` | info | Classification system differs from the bSDD dictionary name | yes |
| `IDSL-BSDD-003` | warning | Value outside the allowed values bSDD publishes | yes |

## bSDD

The buildingSMART Data Dictionary feeds the pickers, inserts and
generators; only search terms and URIs are sent to it, never model data.
Everything that changes the document goes through `bulk.fromBsddClass`
and the gate.

- **Source.** `createHttpBsddSource({ apiBase, fetch })` speaks the public
  bSDD API v1 (in the viewer, `apiBase` is the `/api/bsdd` proxy). Any
  object implementing `BsddSource` works.
- **Picker.** `initialPickerFilters` pre-fills the related IFC entity from
  the specification; `createBsddSearch` debounces (250 ms), drops
  superseded responses and hides inactive classes; `cardFromClass` /
  `cardFromSummary` give the result cards.
- **Insert.** `snapshotBsddClass` + `bsddInsertOp` build a
  `bulk.fromBsddClass` op: classification facet (`system` = dictionary
  name, `value` = code, `uri` on a requirement), entity facet (bSDD's
  `IfcWallSOLIDWALL` split into entity and predefined type), and property
  requirements through the mapping table.
- **Mapping table.** `mapBsddProperty` maps a bSDD property to a property
  requirement: data type (refined to a measure by dimension or unit),
  allowed values, bounds (converted to SI), pattern, uri, required or
  optional. What it cannot map faithfully is left out and reported as a
  note.
- **Dictionary → IDS.** `loadClassesWithAncestors`, `buildClassTree`,
  `planDictionaryIds` (one spec per class or per entity, inherited
  properties, required/all scope) and `previewDictionaryIds` (gate, counts,
  lint summary on a dry run). Commit the plan's ops as one transaction.
- **URI health.** `checkUriHealth` resolves the document's bSDD URIs
  (`collectDocUris`) one at a time, pausing between requests, into a
  `BsddUriIndex`; records stay fresh for 24 h, and an offline or
  rate-limited answer stops the run. Pass the index to
  `createLintContext({ bsdd })` / `createGateContext({ bsdd })` for
  IDSL-BSDD-001…003 and GATE-BSDD-001.
- **Offline.** `createCachedBsddSource(source, { store })` caches searches,
  classes, dictionaries and URI records (fresh for 24 h). When bSDD cannot
  be reached it serves what it has, however old, and throws
  `BsddUnavailableError` for the rest. `createIndexedDbBsddStore()` is the
  browser store; `loadUriIndex(store)` restores the last URI-health results.

```ts
import {
  bsddInsertOp,
  checkOps,
  createGateContext,
  createHttpBsddSource,
  snapshotBsddClass,
  type StudioDocument,
} from '@ifc-lite/ids-authoring';

declare const doc: StudioDocument;
declare const specId: string;
const source = createHttpBsddSource({ apiBase: '/api/bsdd' });
const gate = await createGateContext();
const cls = await source.getClass('https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWall');
if (cls) {
  const op = bsddInsertOp({
    classes: [snapshotBsddClass(cls, { dictionaryName: 'IFC', gate })],
    target: { specId },
    mode: 'both',
    properties: { select: ['IsExternal'] },
  });
  const result = checkOps([op], doc, gate); // then commit([op]) when result.ok
}
```

## Diff and changelog

`diffDocuments(a, b)` compares two documents in IDS terms. Nodes are paired
with the same matcher as re-identification: by node id when both are
revisions of one Studio document (same `docId`), otherwise by identifier,
then name and applicability signature, then similarity.

```ts
import { changelog, diffDocuments, diffToOps, type StudioDocument } from '@ifc-lite/ids-authoring';

declare const before: StudioDocument;
declare const after: StudioDocument;
const diff = diffDocuments(before, after);
// diff.entries: spec.added / spec.changed / facet.valueChanged / requirement.changed / …
// diff.specs:   the side-by-side alignment (a row per spec and facet)
for (const line of changelog(diff, { locale: 'en' })) console.log(line.text);
// "Doors: FireRating (Pset_DoorCommon) changed from optional to required"
const ops = diffToOps(before, diff); // primitive ops that turn `before` into `after`
```

- Every entry carries the data needed to reproduce it, so `diffToOps`
  rebuilds `after` from `before` exactly. The tests use this as the diff's
  completeness oracle on corpus revisions.
- A reorder is reported only for nodes off the longest run that kept its
  order: moving one specification to the top is one move.
- `changelogMarkdown(diff)` groups the sentences by specification (for
  `ids diff --md`). Sentences exist in English, German, French and Italian; facet
  and value wording comes from `@ifc-lite/ids`.

## Three-way merge

`mergeDocuments(base, ours, theirs)` merges two revisions of one Studio
document at the op level. Each side's diff entries are change units with a
key (a field of a node, a node's existence or place). Units only one side
changed merge automatically; identical changes merge once. The rest are
conflicts: `field` (both changed one field differently) or `deleteEdit`
(one side removed a node, or replaced a facet, that the other changed).

```ts
import { conflictView, mergeDocuments, resolveConflict, type StudioDocument } from '@ifc-lite/ids-authoring';

declare const base: StudioDocument;
declare const ours: StudioDocument;
declare const theirs: StudioDocument;
let result = mergeDocuments(base, ours, theirs);
const view = conflictView(result); // cards with "ours" / "theirs" sentences
if (view.cards.length) {
  const resolutions = resolveConflict(view.resolutions, view.cards[0].id, 'theirs');
  result = mergeDocuments(base, ours, theirs, { resolutions });
}
// result.doc, result.ops (base → doc), result.clean
```

- An unresolved conflict keeps the base value.
- Order is settled per list: the side that reordered wins; when both did,
  theirs wins and `MERGE-ORDER-001` is reported.
- Pass `{ gate }` to re-check the merged ops with the grounding gate
  (`MERGE-GATE-001`), e.g. one side narrowed the IFC versions while the
  other added an entity that only exists in the old ones.
- `mergeOps(base, oursOps, theirsOps)` merges two op sequences.

## Revisions and sign-off

A `RevisionLog` holds immutable snapshots chained by SHA-256: each
revision's hash covers its record and its parent's hash, and its
`contentHash` covers the normative content (IDS content without node ids,
custom declarations, test suites). Sign-offs are chained the same way.
Sign-off is an attestation, not a qualified electronic signature.

```ts
import { commitRevision, createRevisionLog, signOff, verifyRevisionLog, type StudioDocument } from '@ifc-lite/ids-authoring';

declare const doc: StudioDocument;
let log = createRevisionLog(doc.docId);
const released = commitRevision(log, doc, { author: 'lead@example.com', label: 'released', message: 'v1.0' });
log = signOff(released.log, released.revision.revId, { by: 'Client', role: 'Reviewer', statement: 'Accepted' }).log;
verifyRevisionLog(log); // { ok: true, problems: [] }; any edit of a stored record is reported
```

- A released revision is read-only: a later revision with different
  content on top of it must be a `draft`.
- `revisionTimeline(log)` is the view model for a revision list (labels,
  sign-offs, plain-language changes against the parent, verification).

## Test suites

IDS test suites are "unit tests for information requirements": each
specification can carry cases (`meta.tests[specId]`), each an IFC fixture
and the verdict the specification must give on it (`pass`, `fail`, or
`notApplicable`; a `fail` case may name exactly the requirements that
fail). Fixtures are `synthetic` (a recipe for `@ifc-lite/ids-testgen`),
`snapshot` (a subset pinned from a real model) or `file`.

```ts
import { junitXml, outcomeFromSpecResult, runTestSuites, testSuitesView, type CaseEvaluator, type StudioDocument } from '@ifc-lite/ids-authoring';

declare const doc: StudioDocument;
declare const evaluate: CaseEvaluator; // e.g. from @ifc-lite/ids-testgen, or a viewer worker
const report = await runTestSuites(doc, evaluate);
// report.summary: { total, passed, failed, error, skipped }
const xml = junitXml(report); // for CI
const panel = testSuitesView(doc, report); // rows per specification, with verdicts
void outcomeFromSpecResult; // maps a validateIDS specification result onto an outcome
```

The runner does the bookkeeping; the host's `evaluate` turns a fixture
into a validator verdict. Test suites change only through `meta.test.*`
ops and outlive the specification they belong to (undo brings them back).

## Comments

Comment threads live in the sidecar (`meta.comments[nodeId]`) and change
only through `meta.comment.*` ops, so they undo like any other edit and
never touch the IDS XML. A thread is opened on a live node but outlives
it: removing a specification keeps its discussion, and undo re-anchors it.
`commentThreads(doc)` is the view model (anchor, orphan flag, participants,
`@name` mentions, unresolved badges per node). In a three-way merge,
threads merge additively: new threads and replies from both sides are kept.

## Sidecar, bundles, re-identification

`parseSidecar` checks the node index and the metadata structures consumed by the
authoring core before attachment. Malformed same-format data throws with its
field path; `readIdsz` uses the same check for bundled `studio.json`. Valid
metadata, extension fields and opaque later-pitch payloads remain intact.

- `createSidecar(doc, xml)` and `attachSidecar(parsed, sidecar, { previous })`
  persist node ids and `meta` next to the XML, never inside it.
- `studio.json` embeds a content snapshot (`snapshot: { version: 1, ids }`)
  by default, so a standalone `.idsz` whose XML was edited elsewhere is
  re-identified on its own (`binding: 'reidentified'`, `basis: 'snapshot'`).
  An explicit `previous` document still wins. The field is additive and
  versioned separately from `schemaVersion`: sidecars without it load as
  before (an external edit then gives fresh ids), and a snapshot of a later
  version is kept but ignored. `createSidecar(doc, xml, { snapshot: false })`
  leaves it out.
- `writeIdsz` and `readIdsz` build a plain zip containing `ids.xml`,
  `studio.json`, `fixtures/*` and `appendix.pdf`. The XML is stored byte for
  byte.
- `reidentify(previous, incoming)` matches nodes by identifier, then by name
  and signature, then by similarity. Comments and provenance therefore
  survive a revised IDS sent back by a client.

## License

MPL-2.0.
