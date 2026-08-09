---
"@ifc-lite/create": patch
---

Correct the last two dead `store.source` truthiness guards in `in-store` ([#2345](https://github.com/LTplus-AG/ifc-lite/issues/2345)).

`IfcDataStore.source` is a mandatory accessor ([#2183](https://github.com/LTplus-AG/ifc-lite/issues/2183)): even the no-source state is `EMPTY_SOURCE_BYTES`, an object, never null/undefined. So `if (store.source)` is always true and `if (!store.source)` is always false, and the early returns beneath them could not fire. `resolve-anchor.ts` was corrected in [#2392](https://github.com/LTplus-AG/ifc-lite/pull/2392); `extract-walls.ts` (4 sites) and `resolve-source.ts` (1) are its siblings in the same directory, and `extract-walls.ts` is the very file `resolve-anchor.ts`'s own comment names as the one it mirrors.

Neither is the silent-wrong-output failure the USD exporter had — both already failed closed, producing nothing rather than something wrong. What the dead guards cost is diagnostic, on the models that actually have no source: server-parsed, synthetic, GLB and point-cloud.

`extractWallSegmentsForStorey` ran `extractLengthUnitScale` over the empty source. That cannot resolve IFCPROJECT, so it took a `warnUnknownUnit` path and told the user their model may be mis-scaled and is being read as metres — about a model with no source to scale from. Its documented `'no source bytes on data store — extraction cannot run'` early return could never be reached either, so the function went on to build the relating/children indices and walk the storey before arriving at the same empty result.

`resolveDuplicateSource` threw `resolveDuplicateSource: could not parse #N`, blaming the entity, when the entity is fine and the store simply has no bytes to parse it out of. It now throws `data store has no source bytes`, which is the message that was already written for this case and unreachable.
