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

```typescript
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import type { IFCDataAccessor, IDSModelInfo } from '@ifc-lite/ids';

const idsDocument = parseIDS(idsXml);

// Create a data accessor that bridges IDS to your IFC data
const accessor: IFCDataAccessor = {
  getAllEntityIds: () => allEntityIds,
  getEntitiesByType: (type) => entitiesByType.get(type) ?? [],
  getEntityType: (id) => entityTypeMap.get(id),
  getEntityName: (id) => getName(id),
  getGlobalId: (id) => getGuid(id),
  getDescription: (id) => getDescriptionText(id),
  getObjectType: (id) => getPredefinedType(id),
  getPropertyValue: (id, pset, prop) => getProperty(id, pset, prop),
  getPropertySets: (id) => getPropertySetInfo(id),
  getClassifications: (id) => getClassificationInfo(id),
  getMaterials: (id) => getMaterialInfo(id),
  getParent: (id, relation) => getParentInfo(id, relation),
  getAttribute: (id, attr) => getAttributeValue(id, attr),
};

// Model info for the validation report
const modelInfo: IDSModelInfo = {
  modelId: 'model.ifc',
  schemaVersion: 'IFC4',
  entityCount: allEntityIds.length,
};

// Validate (requires: document, accessor, modelInfo, options?)
const report = await validateIDS(idsDocument, accessor, modelInfo, {
  onProgress: (progress) => console.log(`${progress.phase}: ${progress.percentage}%`),
});

console.log(`${report.summary.totalEntitiesChecked} entities checked`);
console.log(`${report.summary.totalEntitiesPassed} passed`);
console.log(`${report.summary.totalEntitiesFailed} failed`);
```

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
// Or: 'en' (English), 'fr' (French)
```

## Viewer Integration

In the IFClite viewer, IDS validation is integrated through the IDS panel:

1. **Load IDS** - Drag and drop an `.ids` XML file
2. **Run Validation** - Click validate to check the loaded model(s) against IDS rules
3. **Browse Results** - View pass/fail per specification and per entity
4. **3D Highlighting** - Failed entities are highlighted in red in the 3D view
5. **Filter** - Show all entities, only failed, or only passed
6. **Navigate** - Click a failed entity to zoom to it in 3D

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
