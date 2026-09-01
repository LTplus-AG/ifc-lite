---
'@ifc-lite/cli': patch
---

Stop a single non-finite quantity value (Infinity/-Infinity, reachable from a STEP REAL literal with an extreme exponent such as `1.0E400`, which parses without erroring at the decode boundary) from poisoning `ifc-lite query`'s `--sum`, `--avg`, `--min`, and `--max` aggregates for every other matched entity. The value is now treated the same as the existing present-but-unparseable case: substituted with 0 instead of propagating.
