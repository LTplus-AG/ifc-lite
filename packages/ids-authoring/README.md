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
| Facet | `facet.add`, `facet.remove`, `facet.move`, `facet.replace`, `facet.setField`, `facet.setRelation` |
| Requirement | `requirement.setOptionality`, `requirement.set` |
| Value | `value.set`, `value.addEnumValue`, `value.removeEnumValue` |
| Sidecar | `meta.custom.declarePset`, `meta.custom.removePset`, `meta.custom.declareUserDefinedType`, `meta.custom.removeUserDefinedType` |
| Compound | `bulk.renameProperty`, `bulk.retargetEntity`, `bulk.applyTemplate` (each expands to primitive ops and undoes in one step) |
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
| `GATE-PSET-001` | `Pset_`/`Qto_` name is not a standard set (`Qto_` is unverifiable for IFC2X3/IFC4 and accepted) |
| `GATE-PROP-001` | Property not in the standard set |
| `GATE-ENUM-001` | Value not in the standard property's enumeration |
| `GATE-DT-001` | Unknown data type, or inconsistent with the standard property |
| `GATE-CUST-001…004` | Undeclared custom set / reserved prefix on a custom set / property not declared / nothing to remove |
| `GATE-STR-001…008` | Structure: unknown or duplicate node, required field, requirement-only data in applicability, partOf without entity, restricted dataType, index range, empty name or duplicate versions, optional entity requirement |
| `GATE-VAL-001…008` | Values: draft error, min > max, pattern does not compile, ReDoS guard, length/digit facets, literal invalid for its base, author/date, enumeration edit on a non-enumeration |

Patterns on names (for example `Pset_.*Common`) are valid IDS and are never
blocked. Only literal names are grounded.

## Sidecar, bundles, re-identification

- `createSidecar(doc, xml)` and `attachSidecar(parsed, sidecar, { previous })`
  persist node ids and `meta` next to the XML, never inside it.
- `writeIdsz` and `readIdsz` build a plain zip containing `ids.xml`,
  `studio.json`, `fixtures/*` and `appendix.pdf`. The XML is stored byte for
  byte.
- `reidentify(previous, incoming)` matches nodes by identifier, then by name
  and signature, then by similarity. Comments and provenance therefore
  survive a revised IDS sent back by a client.

## License

MPL-2.0.
