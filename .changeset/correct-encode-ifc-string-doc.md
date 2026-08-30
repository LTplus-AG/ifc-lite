---
'@ifc-lite/encoding': patch
---

Correction to `encodeIfcString`'s doc. The `1.14.4` changelog entry for [#357](https://github.com/louistrue/ifc-lite/pull/357) introduced the function as being "for producing STEP-safe string escapes"; that published entry is left as-is and this note is the correction to it. It is not accurate: `encodeIfcString` emits `\X\`/`\X2\`/`\X4\` directive escapes for non-ASCII and the reverse solidus, but it does NOT double the apostrophe (`'`, code point 39, is printable ASCII and passes through unchanged). Placed directly inside a STEP single-quoted string literal, its output for a value like `O'Brien` produces `'O'Brien'`, which no conformant reader parses as intended.

The doc now says plainly what the function does and does not do, and points to `escapeStepString` (`@ifc-lite/data`) for the full literal-context contract — doubling `'` and `\`, mapping control characters to a space, and encoding non-ASCII per ISO 10303-21 6.3.3.4.

This corrects the documentation only; `encodeIfcString`'s behaviour is unchanged, and a test now pins the current apostrophe handling so a future change is a deliberate decision, not a silent one. Whether apostrophe-doubling belongs in `encodeIfcString` itself is an open question — see [#3445](https://github.com/LTplus-AG/ifc-lite/issues/3445).
