# @ifc-lite/ids

IDS (Information Delivery Specification) support for IFClite. Parses buildingSMART IDS XML files and validates an `IfcDataStore` against them — every facet type, every constraint type, with multi-language reports.

## Installation

```bash
npm install @ifc-lite/ids
```

## Validate against an IDS file

```typescript
import { parseIDS, validateIDS, createTranslationService } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';

const idsXml = await fetch('project-requirements.ids').then(r => r.text());
const idsSpec = parseIDS(idsXml);

// Bridge a parsed IfcDataStore into the validator's data-accessor interface
const accessor = createDataAccessor(store);

const translator = createTranslationService('en');
const report = await validateIDS(
  idsSpec,
  accessor,
  { modelId: 'model.ifc', schemaVersion: store.schemaVersion, entityCount: store.entityCount },
  { translator },
);

console.log(`Overall: ${report.summary.totalEntitiesPassed} / ${report.summary.totalEntitiesChecked} passed`);

for (const spec of report.specificationResults) {
  console.log(`\n${spec.specification.name}: ${spec.passRate}%`);

  for (const entity of spec.entityResults) {
    if (!entity.passed) {
      for (const req of entity.requirementResults.filter(r => r.status === 'fail')) {
        console.log(`  ✗ ${entity.entityType} #${entity.expressId}: ${translator.describeFailure(req)}`);
      }
    }
  }
}
```

## Multi-language reports

Reports translate automatically. Supported languages: English (`en`), German (`de`), French (`fr`).

```typescript
const de = createTranslationService('de');
const report = await validateIDS(idsSpec, accessor, modelInfo, { translator: de });
// Failures now read: "Anforderung 'FireRating' nicht erfüllt..."
```

## Audit an IDS document

Check an IDS file itself for authoring mistakes (broken restrictions, impossible cardinalities, unknown entity names) before running it against a model:

```typescript
import { auditIDSDocument } from '@ifc-lite/ids';

const audit = await auditIDSDocument(idsXml);
for (const issue of audit.issues) {
  console.log(`${issue.severity}: ${issue.message}`);
}
```

## Inspect an IDS specification

```typescript
const idsSpec = parseIDS(idsXml);

for (const spec of idsSpec.specifications) {
  console.log(`Spec: ${spec.name} (${spec.identifier})`);
  console.log(`  Applies to: ${spec.applicability.facets.length} facet(s)`);
  console.log(`  Requires:   ${spec.requirements.length} requirement(s)`);
}
```

## Supported facets

| Facet | Matches |
|---|---|
| `Entity` | IFC entity type (`IfcWall`, `IfcDoor`, …) |
| `Attribute` | IfcRoot attributes (`Name`, `Description`, `Tag`, …) |
| `Property` | Property set + property name + value |
| `Classification` | Classification system + reference code |
| `Material` | Material assignment |
| `PartOf` | Spatial / compositional relationship |

## Supported constraints

| Constraint | Matches |
|---|---|
| `SimpleValue` | Exact match |
| `Pattern` | Regex match |
| `Enumeration` | One-of-list |
| `Bounds` | Numeric range (min/max, inclusive/exclusive) |

## API

See the [IDS Guide](https://ifclite.dev/docs/guide/ids/) and [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-liteids).

## License

[MPL-2.0](../../LICENSE)
