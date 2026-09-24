---
"@ifc-lite/cli": patch
---

The CLI refuses a truncated or entity-less IFC file instead of summarising it. A truncated file does not fail to parse — it parses to a prefix — and the loader's only check was `ISO-10303-21` somewhere in the first 256 bytes, so `ifc-lite info` reported "Entities: 59" and exited 0 for the first 4 KB of a real model, and "Schema: IFC4" for a 22-byte `ISO-10303-21;\nHEADER;\n` stub that declares no schema at all. Both now fail with a message saying which is wrong: a missing `END-ISO-10303-21;` terminator means the bytes are truncated, and a file with no `DATA;` section carries no entities. Both scans are bounded (256-byte tail, 64 KB head) so a hundreds-of-megabyte model costs nothing extra.
