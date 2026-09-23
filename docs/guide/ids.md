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
// Or: 'en' (English, default), 'fr' (French)

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
| Units per property | Deferred |
| Georeferencing (`IfcMapConversion`, CRS) | Deferred — model-level, not element-level |
| Complex properties, `IfcPropertyReferenceValue` | Deferred — reads as `present:false` (absent) |
| Negation / exceptions in applicability | Covered: `ne`/`notIn`/`notContains`/`notMatches`/`isNotSet`, OR-ed groups |
| OR logic in requirements | Covered: an `element` requirement is a `RuleBlock` with OR-ed groups |
| Value-to-value comparison (`WarrantyEnd > WarrantyStart`) | Covered: `compare` requirement kind (number or date) |
| Conditional / child-side / inverse `partOf` | Partially covered: applicability + `aggregate count groupBy parent`; arbitrary entity-to-entity predicates deferred |
| Case sensitivity (opt-in insensitive match) | Covered: per-rule `caseSensitive`, default `true` (IDS parity) |
| Class inheritance (exact-type match, no subclass expansion) | Covered: `exactClass` on an `ifcType` rule, default `false` |
| Float tolerance | Covered: per-rule `tolerance` (relative, default `1e-6`) |
| Grouped/aggregated object info inheritance | Deferred |
| Dates | Covered: `compare` with `valueType: 'date'` (ISO-8601 only) |
| Cardinality on applicability / counts | Covered: `cardinality.minApplicable`/`maxApplicable`, plus `aggregate count` without `groupBy` |

**Empty string vs. absent.** IDS issues #403/#430 leave this ambiguous; rule
sets take a single, deliberately stricter position everywhere: a value is
`present` iff at least one candidate, after `String(v).trim()`, is
non-empty. An empty `IFCLABEL`, whitespace-only text, `$`,
`IfcPropertyReferenceValue`, and complex properties are all **absent**, not
present-with-an-empty-value. Consequence: `exists`/`isSet` fails on `""`,
and `ne` on an absent property FAILS rather than vacuously passing — a rule
requiring `FireRating ne '2HR'` does not pass just because `FireRating` was
never set.

## Exporting a rule set as IDS

`@ifc-lite/rules` exports the rules of a `.rules.json` set that IDS 1.0 can
express. Nothing is approximated, and nothing is dropped without being reported.

```typescript
import { ruleSetToIds, type RuleSetFile } from '@ifc-lite/rules';

declare const ruleSet: RuleSetFile;

const exported = ruleSetToIds(ruleSet, { ifcVersions: ['IFC4'] });
exported.xml;      // IDS XML, or null when no rule could be exported
exported.refused;  // [{ ruleId, ruleName, reasons: string[] }]
exported.notes;    // caveats for the exported set as a whole
```

Export covers `element` requirements and applicability built from `eq`,
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
- a classification code/name value (the rule matches code OR name, IDS only the code)
- a regex that uses JavaScript-only syntax
- applicable-count bounds IDS 1.0 can't state

Two caveats are reported as notes. IDS compares measure values in SI units,
while the rule engine compares the stored value. IDS matches property-set and
property names case-sensitively, while the engine matches literal names
case-insensitively.

## Viewer Integration

In the IFClite viewer, IDS validation is integrated through the Data validation panel's IDS validation entry:

1. **Load IDS** - Drag and drop an `.ids` XML file
2. **Run Validation** - Click validate to check the loaded model(s) against IDS rules
3. **Browse Results** - View pass/fail per specification and per entity
4. **3D Highlighting** - Failed entities are highlighted in red in the 3D view
5. **Filter** - Show all entities, only failed, or only passed
6. **Navigate** - Click a failed entity to zoom to it in 3D
7. **Export BCF** - Turn validation failures into BCF topics (see [BCF](bcf.md#ids-validation-reports-as-bcf))

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
