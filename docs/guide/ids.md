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

## Viewer Integration

In the IFClite viewer, IDS validation is integrated through the IDS panel:

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
