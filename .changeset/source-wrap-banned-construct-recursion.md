---
"@ifc-lite/extensions": patch
---

Make `wrapEntrySource`'s banned-construct check walk the entire entry-script AST instead of only its top-level statements.

The check existed to flag `import`/`export` syntax at wrap time so extension authors get a clear, early error instead of a confusing runtime failure. It only ever inspected `ast.body`, so any of those constructs written inside a nested function, arrow body, or class method passed silently. In practice the QuickJS sandbox realm has no module loader registered, so a nested dynamic `import(...)` was always going to fail at runtime anyway with an opaque engine error — this change moves that failure earlier and makes it legible, and closes the gap between what the check's name and callers assume ("banned constructs are caught") and what it verified.

The walk now also flags dynamic `import(...)` anywhere it appears, not just static top-level `import`/`export` declarations (which the ECMAScript grammar restricts to the top level regardless of where the walk looks). `eval` and `new Function` are deliberately left alone: both run confined inside the same non-module sandbox realm with no path to the host bridge, and banning them would restrict legitimate extension code for no isolation benefit.
