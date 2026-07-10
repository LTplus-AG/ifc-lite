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
- `generateIfcGuid`, `generateUuid`: new identifiers
- `uuidToIfcGuid`, `ifcGuidToUuid`: convert between UUIDs and 22-char IFC GUIDs
- `isValidIfcGuid`, `isValidUuid`: validation
- `parsePropertyValue`: turn raw STEP property values (typed arrays, `.T.`/`.F.`, enums) into a display string plus optional IFC type name

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
