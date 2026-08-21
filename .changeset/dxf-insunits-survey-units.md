---
"@ifc-lite/drawing-2d": patch
---

Fix DXF import treating $INSUNITS codes 17-24 (gigametres, astronomical units, light years, parsecs, and US Survey feet/inch/yard/mile) as unknown and falling back to metres.

The most consequential of these is 21 (US Survey Feet): a civil/survey DXF authored in that unit previously came in at roughly 1/3.28 scale — a large, visible error — even though the fallback correctly warned about the unknown code. US Survey Feet is now converted using its exact legal definition, 1200/3937 m (≈0.3048006096012192 m), not the international foot (0.3048 m exactly); the ~2 parts-per-million difference between the two is the entire reason US Survey Feet is a distinct $INSUNITS code, so Survey inch/yard/mile are derived from the survey foot rather than from international units.
