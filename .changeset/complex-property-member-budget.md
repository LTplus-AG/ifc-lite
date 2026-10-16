---
'@ifc-lite/parser': patch
'@ifc-lite/rules': patch
---

Bound the `IfcComplexProperty` walk by work and by output, not only by depth. A complex property that lists the same member several times was read once per path (`k^8` reads). A long name was copied at every level, and every entity sharing a property set walked it again. A small file could therefore build gigabytes of property text and run the tab out of memory: 200 walls sharing one set in a 27 KB file did.

One walk now reads at most 1024 nested members. Every complex property a property set lists is resolved once per store, against one output budget for the model: 4 bytes per source byte, at least 1 MiB. Every entity reading that set shares the one value. A value cut by either bound ends with `(truncated: nested properties over the walk budget)`. Its `values` and `members` end with the same marker, so a member past the cut reads as truncated rather than absent, including for a rule's `memberPath`. The cut is counted (`complexPropertyCuts`) and logged once per store.

The server's data model and the Rust STEP exporter apply the same policy, so all three write the same value.
