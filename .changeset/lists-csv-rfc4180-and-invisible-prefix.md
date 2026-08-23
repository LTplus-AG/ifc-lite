---
"@ifc-lite/lists": patch
---

Fix two defects in `listResultToCSV` found by validating its output against RFC 4180 and an independent third-party CSV parser rather than against our own reader.

**Records were separated by LF, not CRLF.** RFC 4180 s2.1 says "each record is located on a separate line, delimited by a line break (CRLF)", and its ABNF admits no other separator (`file = [header CRLF] record *(CRLF record) [CRLF]`). Over the 364 real IFC files in this repository the writer produced 1949 bare-LF separators and not one RFC-conformant document; it now emits CRLF and all 364 are clean. No trailing terminator is written, which s2.2 explicitly permits. The viewer's own Lists CSV writer already emitted CRLF, so the two paths disagreed on the same export.

**The CWE-1236 spreadsheet formula guard could be bypassed with a leading invisible character.** The guard anchored `/^[=+\-@\t\r]/` at offset 0, so a BOM, zero-width space, left-to-right mark, no-break space, U+2028/U+2029 or a plain space in front of `=` stopped the regex matching while doing nothing to stop Excel or Sheets evaluating the cell as a formula — `\uFEFF=HYPERLINK(...)` sailed through unguarded. IFC text properties are attacker-controllable and can carry any of them. The trigger is now looked for past any leading `\p{Cf}`/`\p{Z}` run, and the invisibles are preserved rather than stripped so no cell content is lost. This is the same fix `packages/sdk/src/namespaces/export.ts` received for #1944; this copy never got it. The deliberate exemption that keeps a plain signed number such as `-0.35` summable in Excel (#1772) is unchanged.
