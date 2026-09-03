---
'@ifc-lite/parser': patch
'@ifc-lite/export': patch
---

Stop dropping an entity or typed value whose type name is separated from its opening `(` by whitespace or a `/* ... */` comment.

`EntityExtractor.extractEntity`'s entity regex allowed whitespace around `=` but required the type name and `(` to be adjacent, so a record like `#5=IFCSURFACESTYLERENDERING\r\n(#4,0.);` returned `null` and the entity was invisible to every extractor keyed on it (properties, quantities, materials, units, georeferencing). The typed-value regex in the same file had the same gap one level down: `IFCPOSITIVELENGTHMEASURE\r\n(1.)` fell through to a plain-string attribute instead of a typed value, which then made a downstream conversion-unit reader default an unreadable `ValueComponent` to `conversionValue 1.0` — silently wrong scaling for an inch-based `IFCCONVERSIONBASEDUNIT`.

The same adjacency requirement was found in several more places that read or rewrite a decoded STEP record: `@ifc-lite/export`'s `scaleTypedMeasures` (unit-normalize rewrite), `replaceStepArgument` (positional attribute rewrite), the merged-export helpers that read one attribute of a subcontext, representation context, or spatial-structure line (`merged-subcontext.ts`, `merged-context.ts`, `merged-empty-containers.ts`), and the two record-splitting regexes in `reference-collector.ts` that narrow or drop a relationship line. Each had the same failure mode: a wrapped or commented record read as unparseable, which degrades from a lost dangling reference or an unscaled measure to (depending on the caller) a blocked empty-container drop or a subcontext kind-match collapsing into the wrong bucket.

ISO 10303-21 additionally permits a comment anywhere whitespace is legal, including at this exact position, and the Rust tokenizer already tolerates one there (`skip_step_trivia`). Every site above now shares one pattern (`STEP_TRIVIA`, new in `@ifc-lite/parser`) that tolerates both a run of whitespace and a non-nesting `/* ... */` comment between the type name and `(`, so the TS and Rust halves agree on the same STEP bytes.
