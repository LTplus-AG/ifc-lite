---
"@ifc-lite/lens": minor
"@ifc-lite/viewer": patch
---

Give unclassified elements a real legend entry in classification auto-color mode, instead of silently ghosting them.

Previously, `evaluateAutoColorLens` pushed any entity whose `extractAutoColorValues` returned no values into `ghostIds` — a faint gray tint, no legend row, no count, no way to select or isolate it. For `source: "classification"` this meant every unclassified element (and, when a system filter was set, every element classified in a *different* system) disappeared into the ghost mass with no way to see how many there were.

`AutoColorSpec` gains an opt-in `includeUnclassified` flag. When set on a `classification` source, value-less entities get real, clickable legend entries instead:

- **"No classification"** — the entity has zero classification references.
- **"Not in this system"** — it has references, but none in the system named by `psetName`. This bucket only appears when `psetName` names a specific system; with no system filter there is nothing to be "not in", so everything collapses into the single "No classification" bucket.

Both buckets get fixed, visually-neutral colors (not drawn from the rank-based palette), so they can never take the most-saturated color just because they're the largest group, and turning `includeUnclassified` on/off never shifts the colors already assigned to real classification values. Each `AutoColorLegendEntry` for one of these buckets carries `isAbsent: true` so a consumer can tell an absence bucket apart from a real classification code.

The flag defaults to unset/`false`, which reproduces the exact pre-existing ghosting behavior — this is additive, not a new default, so an existing saved lens or SDK caller relying on unclassified elements being ghosted sees no change. An older `@ifc-lite/lens` build that doesn't know this field simply ignores it and keeps ghosting, which is also the safe fallback if the field is ever malformed on import.
