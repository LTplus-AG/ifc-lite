# @ifc-lite/validate

IFC validation generated from the official buildingSMART EXPRESS schemas by `@ifc-lite/codegen`. Every WHERE rule, DERIVE expression, FUNCTION and global RULE of IFC2X3 TC1, IFC4 ADD2 TC1 and IFC4X3 is compiled to TypeScript, so a model can be checked anywhere JavaScript runs: Node, browsers and Cloudflare Workers (no Node built-ins at runtime).

## What it checks

| Category | Checks |
|---|---|
| `schema` | unknown or abstract entities, attribute count, mandatory attributes, value types (INTEGER vs REAL, typed values only in SELECT slots, references to the declared entity), aggregate bounds, `*` exactly where a subtype redeclares an attribute as DERIVE, INVERSE cardinalities, GlobalId format |
| `simpletype_rule` | WHERE rules of defined types (and the types they are based on) on every attribute value, including inside aggregates and typed SELECT values |
| `entity_rule` | WHERE rules of each entity and its supertypes |
| `unique_rule` | UNIQUE rules across the population of the declaring entity |
| `global_rule` | global RULEs |
| `header` | FILE_DESCRIPTION and FILE_NAME attribute types |
| `evaluation_error` | a rule that could not be decided, for example a CASE on a missing value; reported, never passed silently |

Selecting only `evaluation_error` runs type, entity and global rules and reports evaluation failures. Ordinary rule violations are filtered out. Evaluation failures encountered while running any selected rule family are always reported.

Rules follow ISO 10303-11 three-valued logic: a rule is violated only when it evaluates to FALSE. Where the standard leaves an indeterminate case open, the runtime follows IfcOpenShell, the engine behind the buildingSMART validation service.

## Validate a model

```ts
import { validateStepText } from '@ifc-lite/validate';

const report = await validateStepText(ifcText);
if (!report.valid) {
  for (const f of report.findings) console.log(f.category, f.rule, f.instance, f.message);
}
```

A model parsed by `@ifc-lite/parser` validates without re-reading the file:

<!-- docs-check: skip -->
```ts
import { IfcParser } from '@ifc-lite/parser';
import { validateDataStore } from '@ifc-lite/validate';

const store = await new IfcParser().parseColumnar(buffer);
const report = await validateDataStore(store);
```

The release is picked from `FILE_SCHEMA` (`IFC4X3_ADD2` validates with the IFC4X3 rules). The root entry dynamically imports the selected release. A single-file browser IIFE includes all three releases. An ESM build with code splitting can load the selected release’s chunk on demand. `report.notEvaluated` lists rules the generator could not compile; for the bundled schemas it is empty.

## Validate before writing (zod)

Every entity and type has a zod 4 schema for its authoring form: attributes by EXPRESS name, entity references as `{ ref }`, enumeration items as strings, defined-type values in a SELECT as `{ typed: { type, value } }`. Defined types carry their WHERE rules, and entities the WHERE rules they can decide from their own attributes.

```ts
import { IfcWall } from '@ifc-lite/validate/ifc4/zod';

const result = IfcWall.safeParse({
  GlobalId: '2O2Fr$t4X7Zf8NOew3FLOH',
  OwnerHistory: { ref: 5 },
  Name: 'Wall A',
  PredefinedType: 'USERDEFINED',
});
// result.error: IfcWall.CorrectPredefinedType (USERDEFINED needs an ObjectType)
```

## Regenerate

```bash
pnpm --filter @ifc-lite/codegen build
pnpm --filter @ifc-lite/validate generate
```

`src/generated` is committed; a test fails when it drifts from the generator.

## License

MPL-2.0
