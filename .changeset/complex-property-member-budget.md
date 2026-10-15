---
'@ifc-lite/parser': patch
---

Bound the `IfcComplexProperty` walk by work and by output, not only by depth. A complex property that lists the same member several times was read once per path (`k^8` reads), and a long name was copied at every level, so a 10 KB file could build hundreds of megabytes of property text and run the tab out of memory. One walk now reads at most 1024 nested members, and one `extractPsetsFromIds` call builds at most 1 MiB of complex-property text; a value cut by either ends with `(truncated: nested properties over the walk budget)`. The server's data model and the Rust STEP exporter apply the same bounds, so all three write the same value.
