# @ifc-lite/ids

IDS (Information Delivery Specification) support for IFClite. Parses buildingSMART IDS XML files and validates an `IfcDataStore` against them — every facet type, every constraint type, with multi-language reports.

## Installation

```bash
npm install @ifc-lite/ids
```

## Validate against an IDS file

```typescript
import { parseIDS, validateIDS, createTranslationService } from '@ifc-lite/ids';

const idsXml = await fetch('project-requirements.ids').then(r => r.text());
const idsSpec = parseIDS(idsXml);

const translator = createTranslationService('en');
const report = await validateIDS(idsSpec, store, { translator });

console.log(`Overall: ${report.totalPassed} / ${report.totalChecked} passed`);

for (const spec of report.specificationResults) {
  console.log(`\n${spec.specificationName}: ${spec.passRate}%`);

  for (const entity of spec.entityResults) {
    if (!entity.passed) {
      for (const req of entity.requirementResults.filter(r => !r.passed)) {
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
const report = await validateIDS(idsSpec, store, { translator: de });
// Failures now read: "Anforderung 'FireRating' nicht erfüllt..."
```

## Inspect an IDS specification

```typescript
const idsSpec = parseIDS(idsXml);

for (const spec of idsSpec.specifications) {
  console.log(`Spec: ${spec.name} (${spec.identifier})`);
  console.log(`  Applies to: ${spec.applicability.facets.length} facet(s)`);
  console.log(`  Requires:   ${spec.requirements.facets.length} facet(s)`);
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

See the [IDS Guide](https://louistrue.github.io/ifc-lite/guide/ids/) and [API Reference](https://louistrue.github.io/ifc-lite/api/typescript/#ifc-liteids).

## License

[MPL-2.0](../../LICENSE)
