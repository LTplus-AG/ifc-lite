---
'@ifc-lite/parser': patch
'@ifc-lite/rules': patch
---

Bound the `IfcComplexProperty` walk by work and by output, not only by depth. A complex property that lists the same member several times was read once per path (`k^8` reads). A long name was copied at every level, and every entity sharing a property set walked it again. A small file could therefore build gigabytes of property text and run the tab out of memory: 200 walls sharing one set in a 27 KB file did.

One walk now reads at most 1024 nested members. Every complex property a property set lists is resolved once per store, against one output budget for the model: 16 bytes per source byte, at least 1 MiB. A complex property is walked once however many sets list it; each further listing is charged only what it keeps (its value and its `values` list), so a de-duplicating optimiser's file, where one property is shared by thousands of sets, keeps every value. A property set id that appears in more than one record is read once, at its last record, the one the entity index resolves. Every entity reading that set shares the one value, and the shared values are frozen. A value cut by either bound ends with `(truncated: nested properties over the walk budget)`. Its `values` and `members` end with the same marker, so a member past the cut reads as truncated rather than absent, including for a rule's `memberPath`. The cut is counted (`complexPropertyCuts`) and logged once per store.

The server's data model and the Rust STEP exporter apply the same policy, so all three write the same value. The server now also reads a nested member that has no `Name` for its value and shows it as a bare part, as the browser and the exporter always did: a complex property with an unnamed member used to read `P: v` on the server and `anon, P: v` in the browser, and now reads `anon, P: v` in both.

`CompactEntityIndex` now resolves an express id written more than once to its last record, as the Rust core, the server and the exporter do, so a duplicate with different content reads the same everywhere (it used to be whichever copy the binary search landed on).
