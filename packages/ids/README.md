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

Other `validateIDS` options: `maxEntities` (cap for sampling), `onProgress`,
`includePassingEntities` (default `true`), `yieldEveryMs` (how often the
validator yields to the event loop, default `40`) and `preview`.

`createDataAccessor(store, propertyOverlay?, entityVisibility?)` also takes an
optional property overlay and entity-visibility view, so unsaved edits can be
validated.

## Multi-language reports

Reports translate automatically. Supported languages: English (`en`), German (`de`), French (`fr`), Italian (`it`), Russian (`ru`).

```typescript
import { parseIDS, validateIDS, createTranslationService } from '@ifc-lite/ids';

const idsSpec = parseIDS(idsXml);
const de = createTranslationService('de');
const report = await validateIDS(idsSpec, accessor, modelInfo, { translator: de });
// A property failure's failureReason is now translated, for example:
// 'Eigenschaft "FireRating" nicht in "Pset_DoorCommon" gefunden'
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

`auditIDSDocument` takes the XML as a `string` or `ArrayBuffer` and returns
`status` (`valid`, `warning` or `error`), `issues` and, when parsing salvaged
anything, `parsedDocument`. Options: `xsdValidation`, `ifcSchemaChecks` and
`coherenceChecks` (each default `true`), `ifcVersion` (override each
specification's declared version for the IFC schema checks) and `preview`.

## Inspect an IDS specification

```typescript
import { parseIDS } from '@ifc-lite/ids';

const idsSpec = parseIDS(idsXml);

for (const spec of idsSpec.specifications) {
  console.log(`Spec: ${spec.name} (${spec.identifier})`);
  console.log(`  Applies to: ${spec.applicability.facets.length} facet(s)`);
  console.log(`  Requires:   ${spec.requirements.length} requirement(s)`);
}
```

## Write IDS XML

`writeIdsXml` turns a parsed (or hand-built) `IDSDocument` back into IDS 1.0 XML.
The second argument sets the layout: `indent` (spaces or `'\t'`, default `2`),
`newline` (default `'\n'`) and `canonical` (default `false`; `true` sorts
applicability facets so equal documents write equal bytes).

```typescript
import { parseIDS, writeIdsXml } from '@ifc-lite/ids';

const idsSpec = parseIDS(idsXml);
const xml = writeIdsXml(idsSpec, { indent: 2, canonical: true });
```

## Supported facets

| Facet | Matches |
|---|---|
| `Entity` | IFC entity type (`IfcWall`, `IfcDoor`, …) |
| `Attribute` | Entity attributes (`Name`, `Description`, `Tag`, …) |
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
| `Bounds` | Numeric range (min/max, inclusive/exclusive), date and time ranges for `xs:date`, `xs:dateTime`, `xs:time` and `xs:duration` (compared in their own order), string length (`length`, `minLength`, `maxLength`) and digit counts (`totalDigits`, `fractionDigits`) |

## IDS 1.1 preview (unstable)

IDS 1.1 is not released. Candidate features from the buildingSMART 1.1
milestone (`uri` and `instructions` on applicability facets, facets nested in
`partOf`, the #418 tolerance rule, identifier uniqueness) are available only
with `preview: { ids11: true }` on `parseIDS`, `writeIdsXml`, `validateIDS`
and `auditIDSDocument`. Without the flag the package is IDS 1.0 only. See
[IDS 1.1 preview](https://ifclite.dev/docs/guide/ids/#ids-11-preview-unstable).

## API

See the [IDS Guide](https://ifclite.dev/docs/guide/ids/) and [API Reference](https://ifclite.dev/docs/api/typescript/#ifc-liteids).

## License

[MPL-2.0](../../LICENSE)
