---
'@ifc-lite/parser': patch
'@ifc-lite/export': patch
---

Stop dropping an entity or typed value whose type name is separated from its opening `(` by whitespace or a `/* ... */` comment.

`EntityExtractor.extractEntity`'s entity regex allowed whitespace around `=` but required the type name and `(` to be adjacent, so a record like `#5=IFCSURFACESTYLERENDERING\r\n(#4,0.);` returned `null` and the entity was invisible to every extractor keyed on it (properties, quantities, materials, units, georeferencing). The typed-value regex in the same file had the same gap one level down: `IFCPOSITIVELENGTHMEASURE\r\n(1.)` fell through to a plain-string attribute instead of a typed value, which then made a downstream conversion-unit reader default an unreadable `ValueComponent` to `conversionValue 1.0` — silently wrong scaling for an inch-based `IFCCONVERSIONBASEDUNIT`.

The same adjacency requirement was found in several more places that read or rewrite a decoded STEP record: `@ifc-lite/export`'s `scaleTypedMeasures` (unit-normalize rewrite), `replaceStepArgument` (positional attribute rewrite), the merged-export helpers that read one attribute of a subcontext, representation context, or spatial-structure line (`merged-subcontext.ts`, `merged-context.ts`, `merged-empty-containers.ts`), the two record-splitting regexes in `reference-collector.ts` that narrow or drop a relationship line, and `subset-entity-reader.ts`'s `readEntityArgs` (whose `null` makes the anonymizer silently skip the entity). Each had the same failure mode: a wrapped or commented record read as unparseable, which degrades from a lost dangling reference or an unscaled measure to (depending on the caller) a blocked empty-container drop or a subcontext kind-match collapsing into the wrong bucket.

ISO 10303-21 additionally permits a comment anywhere whitespace is legal, including at this exact position, and the Rust tokenizer already tolerates one there (`skip_step_trivia`). Every site above now shares one pattern (`STEP_TRIVIA`, new in `@ifc-lite/parser`) that tolerates both a run of whitespace and a non-nesting `/* ... */` comment between the type name and `(`, so the TS and Rust halves agree on the same STEP bytes.

`STEP_TRIVIA` is a `(?:whitespace|comment)*` run, and that shape backtracks catastrophically whenever either alternative gives the outer `*` more than one way to partition the same span: a failing suffix then makes the engine enumerate them all. Both alternatives were shaped to keep that count at one, and both hazards were measured against the real `EntityExtractor` rather than argued:

- The comment body is `(?:[^*]|\*(?!/))*`, not a lazy `[\s\S]*?`. A lazy body is retried against every later `*/` when the overall pattern fails past a comment, so one comment absorbs the ones after it and the two alternatives overlap. With it, ~120 bytes of legal, correctly paired trivia (30 empty comments) took seconds. This also brings the pattern into line with the Rust scanner, which stops a comment at its first `*/`: `/* a */ */` is a comment followed by junk, not one long comment. That is a deliberate narrowing, pinned by a shared Rust/TS vector.
- The whitespace alternative is a single-character class, not `[...]+`. `+` looks like it collapses a run into one iteration, but the outer `*` can still split an n-character run into any composition of `+` matches, which is the textbook `(?:A+|B)*` blowup, on the far more common input: plain whitespace is exactly what this issue is about. Measured with `+`: 26 spaces 510ms, 28 spaces 1.9s, 1000 spaces did not finish in two minutes. Without it, one million spaces match in ~4ms.

`packages/parser/test/step-trivia-redos.test.ts` pins one case per axis.
