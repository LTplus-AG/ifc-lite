---
"@ifc-lite/export": minor
"@ifc-lite/sdk": patch
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
"@ifc-lite/viewer": patch
"@ifc-lite/wasm": patch
---

CSV cell escaping now has one implementation per language

`@ifc-lite/export` gains `escapeCsvCell` and `guardSpreadsheetFormula`. Every
CSV writer in the SDK, CLI and MCP now calls them instead of carrying its own
copy of the RFC 4180 quoting and the CWE-1236 spreadsheet formula-injection
guard.

Two behaviour changes come with that, in the copies that were behind:

- The formula trigger is looked for **past** any leading invisible characters
  (Unicode `Cf` + `Z`: BOM, zero-width space, LTR mark, non-breaking space,
  U+2028/U+2029, ordinary spaces). The copies in the CLI, MCP and the SDK's
  CSV export tested it anchored at offset 0, so a crafted IFC value such as
  `﻿=HYPERLINK(...)` was exported unguarded.
- Those invisibles are looked past, not deleted. The one hardened copy removed
  them, and its character class included U+0020, so leading spaces were stripped
  from exported cells — RFC 4180 §2.4 says spaces are part of the field.

Cells with no leading invisible and no formula trigger are unchanged.

The Rust exporter (`ifc_lite_export::csv_cell`) carries the matching
implementation, and both are pinned to one shared table of test vectors so the
two languages cannot drift apart.
