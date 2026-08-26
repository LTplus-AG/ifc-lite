---
'@ifc-lite/export': patch
'@ifc-lite/data': patch
---

STEP string escaping: a run of control characters now becomes one space per character, not one space for the whole run, matching `ifc_lite_export::step_text::escape`. Both TS escapers used `/[\x00-\x1F\x7F]+/g`, so `"a\t\t\tb"` was written as `'a b'` by TypeScript and `'a   b'` by Rust while each escaper's doc comment claimed it matched the other. ISO 10303-21 6.3.3.4 permits either (it only bars the control byte from a literal); preserving the count loses no information.
