---
"@ifc-lite/parser": patch
"@ifc-lite/wasm": patch
---

Report a record holding an unescaped apostrophe (`'it's'` where STEP needs `'it''s'`) instead of silently dropping the records after it. Every entity scanner (the TypeScript fast scan, the Blob worker and the Rust/WebAssembly scan) now requires a closing quote to be followed by `,` or `)`, refuses the record at a quote that is not, and resumes at the next record that begins a line or follows a `;`. Two such apostrophes no longer swallow the records between them with nothing reported; the scan diagnostic now names "an unterminated or unescaped quoted string".
