---
"@ifc-lite/bcf": patch
---

Fix three BCF fields the writer emits correctly but the reader silently dropped.

Each one was invisible to the existing round-trip tests because no fixture ever populated it: `parse(write(x)) === x` held only because both sides saw `undefined`.

- **`ViewSetupHints`.** `visinfo.xsd` puts `SpacesVisible` / `SpaceBoundariesVisible` / `OpeningsVisible` on `Components`. The writer emits them; no reader path looked for them, so every hint was lost on read. An attribute the file omits now stays `undefined` rather than collapsing to `false`.
- **`BimSnippet` attribute order.** The reader's regex anchored `SnippetType` to the first attribute position — which our own writer always satisfies — so a spec-correct file that writes `IsExternal` first had its entire snippet dropped. XML attribute order is not semantically significant. `IsExternal` now also accepts the `xs:boolean` `1`/`0` forms, matching how the `Header`/`File` flag is already read.
- **A project `Name` containing XML metacharacters.** `project.bcfp` is written with `escapeXml` but was read back with a raw regex instead of the shared `extractElement` helper, so the escape had no inverse: `A & B` came back as the literal `A &amp; B`, and each re-export escaped it again.

Covered by round-trip tests that set every affected field, plus two tests that feed the reader third-party-shaped XML directly rather than our own writer's output.
