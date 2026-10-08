# IDS Validation

IFClite supports **IDS (Information Delivery Specification)**, the buildingSMART standard for defining and validating information requirements in BIM models. The `@ifc-lite/ids` package implements IDS 1.0 with full facet and constraint support.

## What is IDS?

IDS allows you to define **specifications** that describe what information an IFC model should contain. Each specification has:

- **Applicability** - Which entities the rule applies to (e.g., all walls)
- **Requirements** - What information those entities must have (e.g., fire rating property)

Validation checks every applicable entity against the requirements and produces a pass/fail report.

## Quick Start

### Parsing IDS Files

```typescript
import { parseIDS } from '@ifc-lite/ids';

// Parse an IDS XML file
const idsDocument = parseIDS(idsXmlString);

console.log(`${idsDocument.info.title}`);
console.log(`${idsDocument.specifications.length} specifications`);

for (const spec of idsDocument.specifications) {
  console.log(`  ${spec.name}`);
}
```

### Running Validation

The easiest way to validate a parsed model is the bridge, which builds the data accessor the validator needs directly from an `IfcDataStore` (the output of `@ifc-lite/parser`):

```typescript
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import type { IDSModelInfo } from '@ifc-lite/ids';

const idsDocument = parseIDS(idsXml);

// Bridge the parsed IFC data store to the validator
const accessor = createDataAccessor(dataStore);

// Model info for the validation report
const modelInfo: IDSModelInfo = {
  modelId: 'model.ifc',
  schemaVersion: 'IFC4',
  entityCount: dataStore.entityCount,
};

// Validate (requires: document, accessor, modelInfo, options?)
const report = await validateIDS(idsDocument, accessor, modelInfo, {
  onProgress: (progress) => console.log(`${progress.phase}: ${progress.percentage}%`),
});

console.log(`${report.summary.totalEntitiesChecked} entities checked`);
console.log(`${report.summary.totalEntitiesPassed} passed`);
console.log(`${report.summary.totalEntitiesFailed} failed`);
```

The bridge mirrors IfcOpenShell `ifctester` semantics (classification sub-reference walking, length unit conversion, predefined property-set unwrapping, schema-driven attribute types). It also exports `narrowSchemaVersion` for mapping a parsed schema string to an IDS `IFCVersion`.

Other options in `ValidatorOptions`: `translator` (see below), `includePassingEntities` (default `true`), and `yieldEveryMs` to keep the thread responsive on large models.

### Reusing viewer checks

The Data Validation panel keeps Information rule sets and IDS documents in separate check libraries. Import another file, then use **Select rule set** or **Select IDS document** to switch between checks. Checks with the same title remain separate entries.

For Information validation, **New rule set** starts an editable check and **New from this check** copies the selected rule set. Edits apply to the copy. For IDS, **New from this check** creates an independent library entry containing the original XML; **Download IDS** exports those XML bytes. Use **Delete check** to remove the selected entry. If another check of the same kind remains, the panel selects it.

The libraries survive model replacement and browser reloads on the same origin. Import or storage errors appear in the panel. An invalid replacement keeps the previously accepted check available. The newest picked file owns import completion, including when another mounted panel started the import.

Selecting a different check cancels the current validation and clears its current report. Reports already saved with **Save report** remain in saved history. Run the selected check again against the currently loaded models to produce a new report.

### Understanding the viewer summary

The viewer shows two different units:

- **Requirement checks** count each applicable entity's individual requirements, matching IFC Tester's checks summary. A requirement passes overall when none of its applicable entities fails it; a required specification with no matching entities fails its requirements.
- **Entity–specification results** count each entity once per applicable specification. An entity passes that specification only when all its requirements pass. The same entity can be counted again under another specification. These are the counts in `report.summary.totalEntitiesChecked`, `totalEntitiesPassed`, and `totalEntitiesFailed`.

For example, if two walls each have two requirements and one wall fails one requirement, three of four requirement checks pass (75%), but only one of two entity–specification results passes (50%). Specification cardinality failures still fail the delivery even when individual requirement checks pass. An empty check population displays no evaluated checks.

Both percentages use IFC Lite's shared rounding policy: partial results stay between 1% and 99%, so 0% means nothing passed and 100% means everything passed. IFC Tester floors percentages and can therefore show 0% for a small nonzero passing count. Capped or unevaluable reports do not show an aggregate requirement-check summary.

### Custom Data Sources

If your IFC data does not come from `@ifc-lite/parser`, implement the `IFCDataAccessor` interface yourself. It requires `getAllEntityIds`, `getEntitiesByType`, `getEntityType`, `getEntityName`, `getGlobalId`, `getDescription`, `getObjectType`, `getPropertyValue`, `getPropertySets`, `getClassifications`, `getMaterials`, `getParent`, and `getAttribute`, plus optional methods (`getAncestors`, `getAttributeNames`, `getAttributeXsdTypes`, `getPredefinedTypeRaw`) that improve spec fidelity when provided.

## Facet Types

IDS supports six facet types for defining applicability and requirements:

| Facet | Description | Example |
|-------|-------------|---------|
| **Entity** | Match by IFC type | `IFCWALL`, `IFCDOOR` |
| **Attribute** | Match by IFC attribute | `Name = "W-042"` |
| **Property** | Match by property set/property | `Pset_WallCommon.FireRating` |
| **Classification** | Match by classification system | `Uniclass 2015: Ss_25_10` |
| **Material** | Match by material name | `Concrete C30/37` |
| **PartOf** | Match by spatial containment | `IfcBuildingStorey "Level 1"` |

## Constraint Types

Each facet can use different constraint types to match values:

| Constraint | Description | Example |
|------------|-------------|---------|
| **Simple** | Exact value match | `"REI 120"` |
| **Pattern** | Regex pattern match | `"REI \\d+"` |
| **Enumeration** | One of several values | `["REI 60", "REI 90", "REI 120"]` |
| **Bounds** | Numeric range | `>= 0.2 AND <= 0.5` |

## Multi-Language Support

Validation reports can be generated in multiple languages:

```typescript
import { createTranslationService } from '@ifc-lite/ids';

const t = createTranslationService('de'); // German
// Or: 'en' (English, default), 'fr' (French), 'it' (Italian)

// Pass it to validateIDS to translate the report:
const report = await validateIDS(idsDocument, accessor, modelInfo, { translator: t });
```

## Auditing IDS Documents

Beyond validating models, the package can audit the IDS document itself for structural and semantic problems:

```typescript
import { auditIDSDocument } from '@ifc-lite/ids';

// Takes the raw IDS XML (string or ArrayBuffer); parse errors become structured issues
const auditReport = await auditIDSDocument(idsXml);
```

Use `auditIDSStructure(idsDocument)` to audit an already-parsed document.

Against the vendored buildingSMART IDS corpus, the audit reports an error on
all 27 `invalid-` cases and on none of the 307 pass and fail cases. Among
other things it checks:

- values against their type: a property value against its `dataType`, an
  attribute value against the attribute's type on the applicability entity
  (`FALSE`, `42.0` for an integer and `42,3` are all rejected), and a
  restriction's base against either;
- entity names: upper case (`IFCWALL`, not `IfcWall`), and an entity
  requirement that no applicable class can satisfy (entity facets match the
  exact class, not subclasses);
- predefined types: any value is accepted when the enum has `USERDEFINED`
  (it is matched against `ObjectType`), IFC2X3 occurrences use their type
  object's enum, and an entity with no PredefinedType rejects one;
- every facet of a conjunctive restriction (`and`), not only the first;
- a prohibited specification (`maxOccurs="0"`) with requirements.

## What `.rules.json` rule sets cover that IDS 1.0 cannot

IDS 1.0 has documented limitations (buildingSMART's own user manual
`Documentation/UserManual/specifications.md` §Limitations, plus several
open `buildingSMART/IDS` issues/discussions). IFClite's `.rules.json`
information-validation rule sets (`@ifc-lite/rules`, run by the viewer's
Data Validation panel, `ifc-lite check`, and `ifc-lite delivery`'s `rules`
field) cover a real subset of that gap — the rest is deferred or genuinely
out of scope, and is called out as such:

| IDS 1.0 limitation | Rule-set coverage |
|---|---|
| Geometry: clashes, distance to boundary | Out of scope — use the Clash panel / `ifc-lite clash` instead |
| Aggregate quantity (`sum(NetFloorArea) > 300`) | Covered: `aggregate` requirement kind (`sum`/`count`/`min`/`max`/`avg`) |
| Value uniqueness (`Name`, `AssetIdentifier` must be unique) | Covered: `unique` requirement kind, scope `federation` (default) or `perModel` |
| GUID uniqueness | Covered: `unique` on subject `globalId` |
| Pumps/AHUs must carry specific properties | Covered via `element` requirements (same as IDS) |
| System/group membership (`IfcRelAssignsToGroup`) | Covered: `group` rule kind (applicability and `element` requirements), optionally scoped to a group class such as `IfcSystem` (subclasses included) |
| Schedules, load time, CDE revision, as-built status | Out of scope — not model data |
| Units per property ("Width recorded in mm") | Covered: `unit` requirement kind — a property/quantity value's explicit unit, else the project unit for its measure type (#5300) |
| Georeferencing (`IfcMapConversion`, CRS), project units, header fields | Covered: a `modelFact` rule/subject (`georef.crs`, `georef.eastings`, `units.length`, `header.author`, …) that every value operator works on, read from the element's model (#5442) |
| List, enumerated and table values | Covered: an element rule matches ANY member / cell, as IDS does for lists and tables; a negated op (`ne`, `notContains`, `notMatches`) holds only when NO member has the value (#5475) |
| `IfcPropertyReferenceValue` | Covered: reads as the referenced object's `Name`, else its `Identification`, else `#<id>` (still present) (#5475) |
| Complex properties (`IfcComplexProperty`) | Covered: `memberPath: ['Frame', 'Width']` on a property rule or subject reads one member by name, one entry per nesting level (names compare case-insensitively); without it the property reads as its members' joined text. A missing member is absent. No IDS facet can address a member, so export refuses such a rule. A server-parsed model (no source bytes) carries no member breakdown, so there a `memberPath` rule reads as absent (#5475) |
| Negation / exceptions in applicability | Covered: `ne`/`notIn`/`notContains`/`notMatches`/`isNotSet`, OR-ed groups |
| OR logic in requirements | Covered: an `element` requirement is a `RuleBlock` with OR-ed groups |
| Value-to-value comparison (`WarrantyEnd > WarrantyStart`) | Covered: `compare` requirement kind (number or date) |
| Conditional / child-side / inverse `partOf` | Partially covered: applicability + `aggregate count groupBy parent`; arbitrary entity-to-entity predicates deferred |
| Case sensitivity (opt-in insensitive match) | Covered: per-rule `caseSensitive`, default `true` (IDS parity) |
| Class inheritance (exact-type match, no subclass expansion) | Covered: `exactClass` on an `ifcType` rule, default `false` |
| Float tolerance | Covered: per-rule `tolerance` (relative, default `1e-6`) |
| Grouped/aggregated object info inheritance | Covered: `inherit: 'aggregation'` on a property/quantity rule, subject or list condition takes the nearest `IfcRelAggregates` ancestor's value when the element has none; `inherit: 'type'` adds the type's quantity sets (properties always read the type) (#5433) |
| Dates | Covered: `compare` with `valueType: 'date'` (ISO-8601 only) |
| Cardinality on applicability / counts | Covered: `cardinality.minApplicable`/`maxApplicable`, plus `aggregate count` without `groupBy` |

**Empty string vs. absent.** IDS issues #403/#430 leave this ambiguous; rule
sets take a single, deliberately stricter position everywhere: a value is
`present` iff at least one candidate, after `String(v).trim()`, is
non-empty. An empty `IFCLABEL`, whitespace-only text, `$`,
and an `IfcPropertyReferenceValue` that references nothing are all **absent**, not
present-with-an-empty-value. Consequence: `exists`/`isSet` fails on `""`,
and `ne` on an absent property FAILS rather than vacuously passing — a rule
requiring `FireRating ne '2HR'` does not pass just because `FireRating` was
never set.

## Converting between rule sets and IDS

`@ifc-lite/rules` converts both ways. Nothing is approximated, and nothing is
dropped without being reported.

```typescript
import { parseIDS } from '@ifc-lite/ids';
import { idsToRuleSet, ruleSetToIds, type EvaluatorModel, type RuleSetFile } from '@ifc-lite/rules';

declare const ruleSet: RuleSetFile;
declare const idsXml: string;
declare const models: EvaluatorModel[]; // the models the rule set runs on

// Rule set -> IDS 1.0: rules IDS can express become specifications.
const exported = ruleSetToIds(ruleSet, { ifcVersions: ['IFC4'], models });
exported.xml;      // IDS XML, or null when no rule could be exported
exported.refused;  // [{ ruleId, ruleName, reasons: string[] }]
exported.notes;    // caveats for the exported set as a whole

// IDS -> rule set: simple specifications become rules you can extend.
const imported = idsToRuleSet(parseIDS(idsXml));
imported.file;     // a RuleSetFile, or null when nothing imported
imported.refused;  // [{ specificationName, reasons: string[] }]
imported.droppedChecks; // ['<rule>: Pset.Prop: data type IFCLABEL not checked', ...]
```

**Export** covers `element` requirements and applicability built from `eq`,
`contains`, `startsWith`, `matches` (regex), `isSet`, `in`, and numeric bounds
(a `between` pair becomes one restriction). The conditions can be on the IFC
class, `PredefinedType`, attributes, properties, quantities (IDS checks those
through the property facet), materials, and classification presence. Every
other rule is refused with each reason listed:

- `unique`, `aggregate` and `compare` requirements
- the negated operators (`ne`, `notContains`, `notMatches`, `isNotSet`, `notIn`)
- OR, whether across groups or inside a group
- an `ifcType` rule without `exactClass` (an IDS entity facet is exact-class)
- `caseSensitive: false`, a non-default `tolerance`, or `severity: 'warning'`
- `model` / `modelTag` targeting
- storey, elevation, relating-type and parent-name conditions
- a complex-property member (`memberPath`), which no IDS facet can address
- a classification code/name value (the rule matches code OR name, IDS only the code)
- a regex that uses JavaScript-only syntax
- applicable-count bounds IDS 1.0 can't state

**Units.** IDS states every measure value in SI units (metres, m², m³). A
property or quantity rule can compare in SI too: `valueUnit: 'si'` (the
**SI** toggle on the chip) converts each value with its own unit, meaning
an explicit `Unit` on the property or quantity, else the project unit for its
measure type, before comparing. In search and in filters it reads unsaved
in-session edits like any other property rule, the edited value converted
with its own unit; validation reads the model as loaded. Such a rule exports
unchanged. A numeric
rule without it compares the model's stored numbers. The export converts its
operand to SI with the unit the given `models` store that value in, and
refuses the rule when there are no models, when no model has the value, or
when the models disagree. Import sets `valueUnit: 'si'` on every numeric
property and quantity check, so an imported IDS gives the same verdicts on
a millimetre model as on a metre one.

One caveat is reported as a note. IDS matches property-set and property
names case-sensitively, while the engine matches literal names
case-insensitively.

**Import** covers specifications whose facets are all entity, attribute,
property, material or classification-presence facets, with simple values,
patterns, enumerations or numeric bounds. A property set named `Qto_…` imports
as a `quantity` rule. A property facet's `dataType` has no rule equivalent, so it is imported without that check, and each dropped one is listed in `droppedChecks` (and in the panel's import summary). An entity facet enumerating several classes imports as one `ifcType` rule with `exactClass`. These block a specification, with the reason:

- `partOf` facets
- `optional` and `prohibited` facets
- a pattern on an entity name, or a pattern or enumeration on an attribute name
- a non-string enumeration on a PredefinedType or GlobalId, or a bound that is not a finite number
- length or digit restrictions
- classification codes
- an entity facet in the requirements
- a specification with no requirements

In the viewer, the Data validation panel's Information validation side has
**Import IDS as rules** next to **Open .rules.json**. The rule-set editor has
**Export as IDS** next to **Save**. Both show what was converted and every
refused rule or specification with its reasons.

The export writes its IDS through `writeIdsXml` from `@ifc-lite/ids` (see
[Writing IDS documents](#writing-ids-documents)).

## Writing IDS documents

`writeIdsXml` (in `@ifc-lite/ids`) is the IDS 1.0 writer behind the rule-set
export and the viewer's assistant-drafted IDS. It writes the `info` block,
entity, attribute, property (with `dataType`), classification, material and
partOf facets, requirement cardinality and `instructions`, and every
constraint the parser produces: simple values, patterns, enumerations,
numeric bounds, length and digit restrictions (`xs:length`, `xs:minLength`,
`xs:maxLength`, `xs:totalDigits`, `xs:fractionDigits`) and conjunctive
restrictions (a pattern, an enumeration and bounds in one `xs:restriction`).
Bounds on `xs:decimal` and the integer bases are written without an exponent.

What has no valid IDS 1.0 form is refused with an error naming it, never
written as a weaker check: unparseable bounds, two patterns or two
enumerations in one conjunction (XSD would OR them), conjunctive facets with
different bases, and a bounds restriction without any facet. Line breaks and
tabs in attributes such as `instructions` are written as character
references, so they read back unchanged; a control character XML cannot carry
is refused with the element or attribute it is in. Every pass/fail case of the
vendored buildingSMART IDS corpus reads back with the same specifications and
verdicts.

```typescript
import { parseIDS, writeIdsXml } from '@ifc-lite/ids';

declare const idsXml: string;
const rewritten = writeIdsXml(parseIDS(idsXml));
// Canonical layout: tab indents, CRLF, applicability facets in ids.xsd order.
const canonical = writeIdsXml(parseIDS(idsXml), { canonical: true, indent: '\t', newline: '\r\n' });
```

The optional second argument (`IdsXmlFormat`) changes layout and order only,
never meaning: `indent` (spaces, 0 to 8, or `'\t'`; default 2 spaces),
`newline` (`'\n'` or `'\r\n'`) and `canonical`. Canonical output writes
applicability facets in the `ids.xsd` sequence (entity, partOf,
classification, attribute, property, material) and `ifcVersion` tokens in
schema order without duplicates, so two documents with the same checks write
the same bytes; requirements keep their authored order. Writing is
idempotent: `writeIdsXml(parseIDS(xml), fmt)` returns `xml` for any `xml` it
wrote with the same `fmt`. `IFC4X3` is written as the IDS 1.0 token
`IFC4X3_ADD2`, which reads back as `IFC4X3`; a `partOf` relation of voids or
fills alone is refused, since IDS 1.0 only has the combined
`IFCRELVOIDSELEMENT IFCRELFILLSELEMENT`.

## IDS 1.1 preview (unstable)

!!! warning "Preview"
    IDS 1.1 is not released. The features below are **candidates** from the
    buildingSMART IDS 1.1 milestone. They are off unless you pass
    `preview: { ids11: true }`, and they will change or disappear when
    upstream decides. A document that uses them is not valid IDS 1.0.

Pass the flag to every entry point that should see the candidates:
`parseIDS(xml, { preview })`, `writeIdsXml(doc, fmt, { preview })`,
`validateIDS(doc, accessor, modelInfo, { preview })` and
`auditIDSDocument(xml, { preview })`. Without it, nothing changes: the parser
ignores the 1.1 attributes and elements, the audit reports them as IDS 1.0
errors, and every buildingSMART IDS 1.0 corpus file writes byte for byte the
same with the flag on as off. A document that does use a 1.1 feature is
never quietly downgraded: the writer and the validator throw
`IDS11PreviewRequiredError` when it reaches them without the flag.

| Feature | Upstream | What the preview does |
|---|---|---|
| `uri` on property, classification and material facets in applicability | IDS #188, #251 (merged on the upstream 1.1 branch) | Read and written; informational, never checked against a model |
| `instructions` on applicability facets | IDS #154 (open proposal) | Read and written. Requirement instructions stay on the requirement, as in 1.0 |
| Attribute, property, classification and material facets nested in `partOf` | IDS #379, draft PR #380 | The related element must match the entity **and** every nested facet. Exactly one related entity is required |
| Specification identifiers should be unique | IDS #339 (resolved as documentation) | The preview audit warns on a duplicate (`W_IDS11_IDENTIFIER_DUPLICATE`) |
| Equality tolerance: inclusive bounds, rounded to 15 decimals | IDS #418 (open) | Simple values and enumerations compare with `v ∓ (abs(v)·1e-6 + 1e-6)`, bounds rounded half-to-even to 15 decimal places, ends included. Ranges never use tolerance |

The audit with the flag reports each use as `I_IDS11_PREVIEW_FEATURE` (an
`info` issue naming the upstream issue), so a report always says which parts
are preview. The writer marks preview output with an XML comment and the
schema location `http://standards.buildingsmart.org/IDS/1.1/ids.xsd`, which
buildingSMART has not published yet.

```typescript
import {
  parseIDS, writeIdsXml, validateIDS, auditIDSDocument, findIds11Features,
} from '@ifc-lite/ids';

declare const idsXml: string;
const preview = { ids11: true };

const doc = parseIDS(idsXml, { preview });
for (const use of findIds11Features(doc)) console.log(use.feature, use.path);

const audit = await auditIDSDocument(idsXml, { preview });
const report = await validateIDS(doc, accessor, { modelId: 'model', schemaVersion: 'IFC4', entityCount: 0 }, { preview });
const xml = writeIdsXml(doc, {}, { preview });
```

The nested partOf facet expresses a case IDS 1.0 cannot: "the spaces of the
storey named `01` must be named `01-…`" (#379). The partOf finds the storey,
and the nested attribute facet is a condition on that storey:

```xml
<partOf relation="IFCRELAGGREGATES">
  <entity><name><simpleValue>IFCBUILDINGSTOREY</simpleValue></name></entity>
  <attribute>
    <name><simpleValue>Name</simpleValue></name>
    <value><simpleValue>01</simpleValue></value>
  </attribute>
</partOf>
```

Where upstream is undecided the preview takes the most conservative reading:
for example the extra `partOf` relation of #247 (`IfcRelSpaceBoundary`) and
the inverse partOf of #200 are not modelled, and translations of names and
descriptions (#154) have no XML form until upstream gives them one. The
decisions are recorded in the IDS Studio P-12 work log.

## Viewer Integration

In the IFClite viewer, IDS validation is integrated through the Data validation panel's IDS validation entry:

1. **Load IDS** - Drag and drop an `.ids` XML file
2. **Run Validation** - Click validate to check the loaded model(s) against IDS rules
3. **Browse Results** - View pass/fail per specification and per entity
4. **3D Highlighting** - Failed entities are highlighted in red in the 3D view
5. **Filter** - Show all entities, only failed, or only passed
6. **Navigate** - Click a failed entity to zoom to it in 3D
7. **Export BCF** - Turn validation failures into BCF topics (see [BCF](bcf.md#ids-validation-reports-as-bcf))
8. **Re-run** - After editing the model, the header's Re-run button repeats the check with the same IDS against the same model the report describes. **Clear results** returns to the pre-run card and keeps the IDS loaded; **Unload IDS** removes both

To correct failures, select a failed specification whose requirement names an exact property and choose **Correct**. Enter the value as the IDS states it (base SI units) and pick the failed elements. **Review as changes** shows each element's stored value and the typed value it would get, scaled into the model's units; apply it from the review and use **Re-run validation** on the receipt to see the before and after counts per specification. **Apply to N entities** writes directly and re-runs validation, without a review or receipt. See [Reviewed table, bulk and IDS corrections](mutations.md#reviewed-table-bulk-and-ids-corrections).

No `.ids` file to hand? With no model of your own open, the empty panel's **Try with demo data** loads the demo project and the IDS written for it.

The [viewer assistant](viewer-assistant.md#reviewed-ids-rule-and-report-drafts) can also draft IDS specifications, information rules and report outlines. It runs the native IDS audit and a dry run on the loaded models before a draft can be saved into this panel's libraries, and keeps requirements no check can cover as explicit unsupported items.

Checks do not automatically create saved reports. To keep a completed IDS or information-validation result, choose **Save report** in its results toolbar. **Saved reports** holds the evidence from that run, including its evaluated model names and fingerprints. The same result can be saved once; later runs can be saved separately. Unsaved results last only for the current session and are replaced by a later completed run or cleared with the results.

### Manual validation

Some checks are done by eye rather than by a rule: the model was uploaded to the CDE on time, objects sit on the right storey. The Data validation panel's third tab, **Manual validation**, holds a checklist of groups of such checks. Each check takes **Pass**, **Fail** or **Warning** and an optional comment; a check with no verdict shows as **Not checked**. Each group has a ring chart and there is an overall ring; a warning is counted on its own and never as a pass.

**Edit checklist** adds, renames, reorders and deletes groups and checks. **Save .checklist.json** downloads the structure only (never the answers), so one file can be reused on every model; **Open .checklist.json** and **Recent checklists** load one back. Answers are stored in the browser per model, keyed by the model file's identity, so they come back when the same file is loaded again; with several models loaded, a picker chooses which one is being checked. Manual results are kept apart from IDS and information-validation reports and never replace them. To put them in a report, add a **Validation report** block to a [document](documents.md) and choose the saved or live manual report as its source.

Validation runs in a Web Worker so the UI stays responsive during large runs, with an automatic fallback to in-process validation if the worker is unavailable.

### Display Options

| Option | Default | Description |
|--------|---------|-------------|
| Highlight failed | On | Red highlight on failed entities in 3D |
| Highlight passed | Off | Green highlight on passed entities in 3D |
| Filter mode | All | Show all, failed only, or passed only |
| Locale | Auto | Language for validation messages (EN/DE/FR) |

## Key Types

| Type | Description |
|------|-------------|
| `IDSDocument` | Parsed IDS file with info and specifications |
| `IDSSpecification` | A single validation rule with applicability and requirements |
| `IDSFacet` | Entity, Attribute, Property, Classification, Material, or PartOf |
| `IDSConstraint` | Simple, Pattern, Enumeration, or Bounds value matcher |
| `IDSValidationReport` | Complete validation results with per-entity details |
| `IDSEntityResult` | Pass/fail result for a single entity with failure details |


## Saved workflows and retained reports

[Session automation](flow.md#file-slots-reports-and-portability) can run several
enabled IDS or information-validation jobs over explicitly selected models and
retain each completed native report. IDS evaluates each target model separately:
a job targeting several models produces adjacent model reports rather than a
merged fictitious IFC model or an averaged pass rate. Information rule sets
evaluate their targeted federation as one job. Validation uses current effective
property/entity edits, preserving the same native evaluator semantics.
