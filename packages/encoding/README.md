# @ifc-lite/encoding

IFC string encoding and decoding, GlobalId (GUID) utilities, and property value parsing. Small, dependency-free helpers for the text-level details of IFC STEP files: the `\X2\...\X0\` escape sequences used for non-ASCII characters, the 22-character base64-like IFC GUID format, and typed STEP property values like `IFCBOOLEAN(.T.)`.

## Install

```bash
npm install @ifc-lite/encoding
```

## Usage

```ts
import {
  decodeIfcString,
  encodeIfcString,
  generateIfcGuid,
  ifcGuidToUuid,
  parsePropertyValue,
} from '@ifc-lite/encoding';

decodeIfcString('Gew\\X2\\00E4\\X0\\chshaus'); // 'Gewächshaus' (real umlaut)
encodeIfcString('Tür');                   // 'T\\X\\FCr'

const guid = generateIfcGuid();  // 22-char IFC GlobalId
const uuid = ifcGuidToUuid(guid); // standard UUID form

parsePropertyValue(['IFCBOOLEAN', '.T.']); // { displayValue: 'True', ifcType: ... }
```

## Exports

- `decodeIfcString` / `encodeIfcString`: STEP `\X2\`, `\X\`, `\S\` escape handling
- `generateIfcGuid`, `generateUuid`: new identifiers; pass an optional `RandomSource` (a seeded `() => number`) for reproducible output
- `uuidV5(namespace, name)`: name-based (version 5) UUID; `uuidFromSeed`: deterministic version-4-shaped UUID from a seed. Compose either with `uuidToIfcGuid` for a stable GlobalId
- `uuidToIfcGuid`, `ifcGuidToUuid`: convert between UUIDs and 22-char IFC GUIDs
- `isValidIfcGuid`, `isValidUuid`: validation
- STEP text helpers: `decodeStepStringLiteral` (one literal's contents, doublings and directives included), `stepStringLiteralEnd`, `isStepPageQuoteOperand`, `splitStepTopLevel` (split a parameter list at top-level commas), `isWhollyNumeric`
- `parsePropertyValue`: turn a parsed STEP property value (typed arrays, `.T.`/`.F.`, enums) into a display string plus optional IFC type name. It does **not** decode `\X2\`-style escapes: every ifc-lite parse path already decodes exactly once, at the parse boundary, and decoding a second time would collapse an authored `\\` a second time. Pass a still-encoded literal through `decodeIfcString` first.

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
