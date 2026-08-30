# @ifc-lite/bcf

## 2.0.1

### Patch Changes

- [#3328](https://github.com/LTplus-AG/ifc-lite/pull/3328) [`e8c0d71`](https://github.com/LTplus-AG/ifc-lite/commit/e8c0d715de5152c885ddd3b121237d1f17a7fd1d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Write BCF viewpoint cameras in the order and cardinality each schema declares, and refuse non-finite numbers rather than writing them.
  
  `visinfo.xsd` disagrees between versions, and the writer followed neither:
  
  - BCF 2.1 lists `OrthogonalCamera` before `PerspectiveCamera` in
    `VisualizationInfo`'s `xs:sequence`. The writer emitted the perspective
    camera first, so a viewpoint carrying both cameras produced a `.bcfv` that
    fails 2.1 validation ("Element 'OrthogonalCamera': This element is not
    expected"). Both cameras are now written orthogonal-first.
  - BCF 3.0 replaced that pair with an `xs:choice` carrying no `minOccurs` and no
    `maxOccurs` — exactly one camera, required. The writer emitted both when both
    were set, and none when neither was; the latter is what `createBCFFromIDSReport`
    produces for every failing entity whenever no `entityBounds` are supplied.
    Writing a 3.0 archive now fails with an error naming the viewpoint rather than
    producing markup no conforming reader has to accept.
  
  Separately, every number the writer emits under an XSD numeric type is now
  required to be finite. `Camera/AspectRatio` was guarded with `!(aspectRatio > 0)`,
  and `Infinity > 0` is `true`, so `Infinity` was written verbatim and xmllint
  rejected the archive: "Element 'AspectRatio': 'Infinity' is not a valid value of
  the atomic type 'PositiveDouble'". The same gap was unguarded on `FieldOfView`,
  `ViewToWorldScale`, `Bitmap/Height`, `Topic/Index` and every camera, line,
  clipping-plane and bitmap coordinate. `NaN` needs the same guard for a different
  reason: `xs:double` accepts the lexical form `"NaN"`, so those archives validate
  while carrying a number the reader drops on the way back in. All of these now
  throw, naming the field and the viewpoint or topic.
  
  **BCF 3.0 impact on `createBCFFromIDSReport`.** At `version: '3.0'` this
  function now has no working configuration. Nothing in this repository populates
  `aspectRatio` — `computeCameraFromBounds` sets `fieldOfView` but no aspect
  ratio, and `ViewerCameraState` carries none — so a report exported with
  `entityBounds` throws on the required `AspectRatio`, and one exported without
  them throws on the required camera. Before this change the second case did not
  throw; it wrote one schema-invalid `.bcfv` per topic instead. Callers at 3.0
  must supply an `aspectRatio` on the camera; BCF 2.1 export is unaffected, and
  whether the reporter should synthesise a default aspect ratio is left open
  rather than decided here.

## 2.0.0

### Major Changes

- [#3096](https://github.com/LTplus-AG/ifc-lite/pull/3096) [`e19aa0e`](https://github.com/LTplus-AG/ifc-lite/commit/e19aa0ef271eccc7f2f6862b8580e9f98dbd1a66) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Validate real `.bcfzip` output against buildingSMART's published BCF XSDs. That check found eleven schema violations in our output; nine are fixed here and two are reported below as needing a decision this change cannot make.
  
  Every existing test in this package is `parse(write(x)) === x`. That check cannot see a field both sides get wrong the same way — the writer and the reader agree with each other, not with the format. buildingSMART's `markup.xsd`, `visinfo.xsd`, `project.xsd` and `version.xsd` are an authority independent of this codebase, so they can. They are now vendored verbatim under `src/__fixtures__/schemas/` (CC BY-ND 4.0, which permits unmodified redistribution with attribution; see the `UPSTREAM_LICENSE` beside them) and `src/schema-validation.test.ts` writes a maximal archive — every optional field set, a distinct value in every position, cameras on a schema boundary — and validates each entry through `xmllint-wasm`, a WebAssembly libxml2 build with no native dependencies and no network access. It is a `devDependency` pinned to an exact version; nothing ships in the published package.
  
  **BCF 2.1 — affects every archive ifc-lite writes by default,** since `createBCFProject` defaults to 2.1 and both `@ifc-lite/cli` and `@ifc-lite/mcp` use that default:
  
  - **Viewpoint bitmaps used a container that does not exist in BCF 2.1.** `visinfo.xsd` repeats `<Bitmap>` directly under `<VisualizationInfo>` and names the per-entry format element `<Bitmap>` as well (`<Bitmap><Bitmap>PNG</Bitmap><Reference>…`). The writer emitted the BCF 3.0 shape — a `<Bitmaps>` wrapper with `<Format>` children — for both versions, so no 2.1 archive we wrote had schema-valid bitmaps. The reader matched the same non-2.1 shape, and required the wrapper to be present at all (`if (!bitmapsMatch) return bitmaps`), so it dropped every bitmap from a conformant 2.1 file written by any other tool. Its inner match was also a plain non-greedy `<Bitmap>…</Bitmap>`, which on the real 2.1 shape terminates at the nested format tag's closing tag rather than the entry's. Verified against buildingSMART's own `release_2_1` conformance archives: before this change, `readBCF` recovered 0 bitmaps across all 124 of them; after, it recovers the 2 that the `v2.1/Markup/MaximumInformation` fixture contains.
  
  **BCF 3.0 — the `bcf.version`, `project.bcfp` and `.bcfv` writers ignored the version argument entirely** and emitted 2.1 shapes into 3.0 archives:
  
  - `<Version>` in 3.0's `version.xsd` has an empty content type, so `<DetailedVersion>` is not allowed. It must be written self-closing: libxml2 reports even the whitespace inside a `<Version>…</Version>` pair as character content against an empty content model.
  - 3.0's `project.xsd` renames the root element from `<ProjectExtension>` to `<ProjectInfo>`.
  - 3.0's `markup.xsd` gives `<Labels>` a single container holding `<Label>` children, rather than repeating `<Labels>` per value, and groups `<RelatedTopic>` under a `<RelatedTopics>` wrapper.
  - 3.0's `visinfo.xsd` moves `<ViewSetupHints>` inside `<Visibility>` (its `Components` admits only `Selection`, `Visibility`, `Coloring`), adds an inner `<Components>` level inside each `<Color>`, and lowercases the `BitmapFormat` enum to `png`/`jpg`. `BCFBitmap.format` keeps its `'PNG' | 'JPG'` type; only the wire value is lowercased.
  - 3.0 requires `<AspectRatio>` (a positive double) on both camera types. Writing a 3.0 file without one now throws rather than emitting an invalid archive, matching the existing `Topic/@TopicType` and `Topic/@TopicStatus` checks — there is no safe default aspect ratio to invent. Note that `cameraToPerspective`/`cameraToOrthogonal` cannot supply one, as `ViewerCameraState` carries no aspect ratio; a 3.0 caller must set it on the camera.
  
  BCF 2.1 output is otherwise byte-identical to before.
  
  Two gaps this check found are reported but deliberately **not** fixed here, because neither has a contained fix:
  
  - **BCF 2.1 `project.bcfp` omits the schema-required `<ExtensionSchema>`.** `project.xsd` makes it a required child of `<ProjectExtension>`, so every 2.1 archive we write that has a project id or name fails validation. Emitting the element honestly means shipping an `extensions.xsd` in the archive, and a conformant BCF 2.1 `extensions.xsd` is an `xs:redefine` of buildingSMART's `markup.xsd` — a licensing and packaging decision. Emitting the reference without the file would only trade a schema error for a dangling one. `BCFProject.extensions` is currently dropped on write entirely, which is the same gap seen from the data side. `schema-validation.test.ts` pins the exact error so the gap stays visible and cannot change unnoticed.
  - **`cameraToPerspective` clamps field of view to `[1, 179]`**, which is BCF 3.0's range; 2.1's `visinfo.xsd` restricts `FieldOfView` to `[45, 60]`. Clamping to the narrower 2.1 range would silently distort the stored camera, and 2.1's own schema annotation says the limit "will be dropped in the next release and viewers should be expect values outside this range" — buildingSMART's own conformance archives contain values above 60. Which way to resolve that is a judgement call, not a bug fix.

### Patch Changes

- [#3088](https://github.com/LTplus-AG/ifc-lite/pull/3088) [`93b450c`](https://github.com/LTplus-AG/ifc-lite/commit/93b450c1cc0c3cee811625989edb82cf522c70c4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Four places where two things had to agree and nothing made them.
  
  **BCF `<Component>` read back none of what it wrote.** BCF 2.1 and 3.0 both model `OriginatingSystem` and `AuthoringToolId` as child ELEMENTS of `<Component>` — only `IfcGuid` is an attribute. `writeComponent` emits the element form and its docstring says so; `parseComponent` matched `AuthoringToolId="…"` and `OriginatingSystem="…"` as attributes, which the element form never produces. Both fields were dropped from every archive read, whether ifc-lite wrote it or another tool did. Worse, the guard `if (!ifcGuidMatch && !authoringToolIdMatch) return undefined` used a match that could never fire, so a component identified only by its authoring-tool id — legal, `IfcGuid` is optional — was discarded whole rather than losing one field.
  
  The existing writer tests could not see it: no fixture set either field, so the reader's `undefined` looked like a faithful round-trip of an empty input rather than a dropped value. A writer and a reader that only ever meet each other agree with each other, not with the format. The reader now reads the element form (unescaping entities, like every other element it parses) and still accepts the attribute spelling as a fallback, so files from tools that emit the non-spec form keep working.
  
  **`ifc-lite clash`'s "Top 20" was not the top 20.** The engine returns `result.clashes` in `byKeyThenRule` grouping order. Both cap sites sliced that directly — `slice(0, 20)` for the human summary, `slice(0, 1000)` for `--json` — under a header reading `Top N of M clashes`, so on any run above the cap the deepest penetrations could sit past the cut and never be printed. `@ifc-lite/clash` has exported `sortClashes(clashes, 'distance')` for this the whole time, and the viewer's clash panel uses it; the MCP `clash_check` tool had independently hit the same problem and grown a local copy of the sort, minus the deterministic id tie-break. All three now call the one helper, so "top N" means the same N rows on every surface and equal-distance rows stop reshuffling between runs.
  
  **`ifc-lite mcp --allow-origin <origin>` loaded the origin as a model file.** The standalone `ifc-lite-mcp` binary reads a flag and consumes its value in one branch, so it cannot disagree with itself. The `ifc-lite mcp` subcommand only needs to know WHICH flags carry a value, so it can skip them while collecting positional `.ifc` paths — and it kept a hand-written copy of that list. The copy drifted: `--allow-origin` reached the binary and never the list, so the subcommand skipped the flag, failed to skip the origin after it, and called `resolve('https://…')` as a model path. The flag tables now live in `@ifc-lite/mcp/cli-args` next to the binary's parser, which a test drives against them, and the subcommand imports them. Flags the subcommand cannot act on (`--allow-origin`, `--federate`) are now reported on stderr instead of silently appearing to work. `parseArgs` also stopped calling `process.exit` for `--help`/`--version` — it reports them and the binary acts — so it can be tested at all.
  
  **Three query backends, three copies of the same two lookup tables.** `IFC_SUBTYPES`, `expandTypes` and the `related()` relationship map were byte-identical in the viewer's `query-adapter`, `@ifc-lite/cli`'s `HeadlessBackend` and `@ifc-lite/mcp`'s `backend-query`, behind one SDK query API. Only the CLI copy had tests, so the other two were free to drift: deleting `IFCSLABELEMENTEDCASE` from the MCP copy left all 272 of its tests green, meaning `byType('IfcSlab')` could answer differently depending on which surface a caller reached. They now come from `@ifc-lite/parser`, the same home PR [#3009](https://github.com/LTplus-AG/ifc-lite/issues/3009)'s `isProductType` move used, and are covered there rather than by one consumer; that mutation now fails. `@ifc-lite/cli` and `@ifc-lite/mcp` keep publishing `expandTypes` under its old name, so no consumer surface changes.
  
  Putting the SDK's five-entry relationship map next to the parser's eighteen-entry `REL_TYPE_MAP` also makes visible, for the first time, that `related()` exposes five of the relationships the parser indexes — previously that narrowing was invisible in all three copies. Behaviour is unchanged; widening it is now a deliberate edit to one table.
  
  Also documented a near-miss: `harvestUpdatePaths` in `@ifc-lite/collab-server` pre-creates four of the five `TOP` shared types, omitting `annotations`, and reads like an enumeration missing an entry — which would make an `annotations/…` path lock unenforceable. It is not: `Y.applyUpdate` registers any top-level type the update names and `topLevelKeyOf` scans `doc.share`, so the path is harvested regardless. Verified by running, and pinned by two tests so a later "tidy-up" into a fixed list cannot quietly create the hole.
  
  **A fifth pair, found reviewing the fourth: the `<Component>` splitter read two components as one.** Fixing the field parsing above made this reachable, so it belongs in the same change rather than after it. The splitter was `<Component[^>]*(?:\/>|>[\s\S]*?<\/Component>)`, and `[^>]*` is greedy: it eats the `/` of a self-closing tag, so the `\/>` branch can never fire. A uniform list still parsed, because the engine backtracks and gives the `/` back when no later `</Component>` exists. A MIXED list did not.
  
  `writeComponent` emits `<Component .../>` for a component with no child elements and the full form for one with them, so an ordinary selection holding one of each produces exactly that mixed list. The pair matched as ONE element spanning both, and the first component silently inherited the second's `AuthoringToolId` and `OriginatingSystem`. Before this change that was data loss; with the field parsing working it is misattribution, which nothing downstream can detect.
  
  Every fixture in the suite held one shape, which is the one shape the defect cannot reach. There is now one splitter instead of two identical copies, in `parseComponentElements`, with fixtures for the mixed selection, the mixed coloring entry, and a uniform control.
  
  **The attribute fallback did not decode entities.** `AuthoringToolId="A &amp; B"` came back as the literal `A &amp; B` while `<AuthoringToolId>A &amp; B</AuthoringToolId>` came back as `A & B`. Which spelling a file happens to use is not supposed to change the value. All three attribute reads now decode the same way `extractElement` does.
  
  **`reader.ts` was split.** The component, visibility and colouring parsers move to `reader-components.ts` and the XML text helpers to `xml-text.ts`. That is what put one splitter where there were two, and it takes `reader.ts` from 1204 lines to 1045. The module-size gate was genuinely RED before it (1204 against a 1190 budget), and the freed budget is banked rather than left as slack: the row drops to 1045 in the same commit that shrank the file. 1045 is still far above the ~400-line house guideline, so this pays a gate, not the rule behind it.
  
  **Two smaller ones in `@ifc-lite/mcp`.** `--help`/`--version` set `process.exitCode` and return instead of calling `process.exit(0)`, which can truncate stdout when it is a pipe. That makes `ifc-lite-mcp` match its sibling binary, `packages/cli/src/index.ts`, which already returns rather than exits. The same write-then-exit shape survives at about ten sites in `@ifc-lite/cli`'s subcommands; widening to those changes control flow (several exit non-zero) in a package this change does not otherwise open, so they are deliberately left. And four user-facing strings advertised the top clashes "by |distance|" while the code sorts by signed distance. The file's own docstring already warned that an absolute-value sort inverts the hard-clash order, so the text contradicted both the implementation and the comment beside it.
  
  **Reviewing the splitter fix turned up four more in the same file, three of them the same shape.** Fixing them here rather than filing them, because they live in the function the split just moved and the remedy is the one already applied.
  
  `<Visibility DefaultVisibility="false"/>` is schema-legal, since `<Exceptions>` and `<ViewSetupHints>` are both optional. Matching only the paired form returned `undefined` for the WHOLE `<Components>` block, dropping the selection and colouring with it. That is the same missing self-closing branch as the component splitter, twenty lines away.
  
  `DefaultVisibility` was matched against the entire `<Components>` string rather than the `<Visibility>` element, so the attribute on any earlier element won. A file whose `<Visibility>` says `true` with a `DefaultVisibility="false"` anywhere ahead of it hid every element: the exact opposite of what it asked for.
  
  Attribute fallbacks were read from the whole element rather than its opening tag, so `<Component IfcGuid="G"><Child OriginatingSystem="x"/></Component>` reported the child's `x` as the component's own. They also lacked the `\b` name anchor that `reader.ts`'s own `extractAttr` has, so `XAuthoringToolId="sneaky"` satisfied a search for `AuthoringToolId`.
  
  And an EMPTY value now reads as absent whichever spelling carries it. `<AuthoringToolId></AuthoringToolId>` returned `''`, which passed the "a component needs some identity" guard with no identity, and `writeComponent` then wrote it back as a bare `<Component/>` that the reader discards. Three spellings of nothing disagreeing is the defect this changeset opens with.
  
  `IfcGuid` is now entity-decoded like every other field, matching `writeComponent`, which already escapes it. A real IFC GUID contains no `&`, which is why nothing reached it.
  
  Each of these is pinned by a fixture that fails without its fix; all six were checked by reverting the fix and watching the fixture go red.
  
  **`unescapeXml` decodes numeric character references**, not only the five named entities `escapeXml` writes. Other authoring tools emit `&[#38](https://github.com/LTplus-AG/ifc-lite/issues/38);` and `&#x26;`, both legal XML, and those stayed encoded in the data.
  
  It is now a single pass rather than a chain of five `replace` calls. The chain had to decode `&amp;` last, or a literal `&lt;` written as `&amp;lt;` was corrupted into `<` by the earlier pass; adding numeric forms to that chain reintroduces the same hazard from a second direction, since `&[#38](https://github.com/LTplus-AG/ifc-lite/issues/38);lt;` decodes to `&lt;` and would be swept again. A single pass never looks at its own output, so the ordering question stops existing. An unrecognised or out-of-range reference is left untouched, because losing a character from someone else's archive is worse than leaving one encoded.
  
  **`clash_review` asked for something the data could not support.** The prompt requested a top-20 list "ordered by severity", but `clash_matrix` selects `sampleClashes` with `sortClashes(clashes, 'distance')` and caps it, so a high-severity clash with a large distance is not in the sample at all. A severity-ranked list built from it would silently omit exactly the items it claims to rank. The prompt now orders by distance and points at `bySeverity` for the severity picture, which is a complete count over every clash. The tool's own description says which half is complete and which is capped, and `clashReview.description` no longer says "prioritize by severity".

- [#2898](https://github.com/LTplus-AG/ifc-lite/pull/2898) [`ddf9f1d`](https://github.com/LTplus-AG/ifc-lite/commit/ddf9f1da830cef5f941ea09e8aee19624e9def3a) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix BCF 3.0 markup.bcf writing and reading the wrong `Comments`/`Viewpoints` structure.
  
  buildingSMART's BCF 3.0 `markup.xsd` moves `Comments` and `Viewpoints` inside `<Topic>` (each wrapped in its own plural container, with per-entry `<ViewPoint Guid="...">` — capital P, distinct from the `<Viewpoint Guid="..."/>` a `<Comment>` uses to reference one), after `RelatedTopics`. BCF 2.1 instead keeps them as top-level `<Markup>` siblings after `</Topic>`, in schema order `Comment*` then `Viewpoints*`.
  
  The writer previously emitted the 2.1-shaped flat siblings — `Viewpoints` before `Comment` — unconditionally for both versions, which is schema-invalid at 3.0 and out of order at 2.1. The reader's markup lookup only matched the 2.1 top-level `<Viewpoints Guid="...">` shape, so on a genuine 3.0 file the per-viewpoint snapshot filename was silently dropped and resolution fell back to guessing our own `Snapshot_<guid>` naming convention. Verified empirically against buildingSMART/BCF-XML's own release_3_0 conformance fixture (`Test Cases/v3.0/Visualization/Perspective camera`): before the reader fix, the snapshot referenced by that fixture's `markup.bcf` was not attached to the parsed viewpoint.

- [#3089](https://github.com/LTplus-AG/ifc-lite/pull/3089) [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix three BCF fields the writer emits correctly but the reader silently dropped.
  
  Each one was invisible to the existing round-trip tests because no fixture ever populated it: `parse(write(x)) === x` held only because both sides saw `undefined`.
  
  - **`ViewSetupHints`.** `visinfo.xsd` puts `SpacesVisible` / `SpaceBoundariesVisible` / `OpeningsVisible` on `Components`. The writer emits them; no reader path looked for them, so every hint was lost on read. An attribute the file omits now stays `undefined` rather than collapsing to `false`.
  - **`BimSnippet` attribute order.** The reader's regex anchored `SnippetType` to the first attribute position — which our own writer always satisfies — so a spec-correct file that writes `IsExternal` first had its entire snippet dropped. XML attribute order is not semantically significant. `IsExternal` now also accepts the `xs:boolean` `1`/`0` forms, matching how the `Header`/`File` flag is already read.
  - **A project `Name` containing XML metacharacters.** `project.bcfp` is written with `escapeXml` but was read back with a raw regex instead of the shared `extractElement` helper, so the escape had no inverse: `A & B` came back as the literal `A &amp; B`, and each re-export escaped it again.
  
  Covered by round-trip tests that set every affected field, plus two tests that feed the reader third-party-shaped XML directly rather than our own writer's output.

- [#2982](https://github.com/LTplus-AG/ifc-lite/pull/2982) [`4a8fe77`](https://github.com/LTplus-AG/ifc-lite/commit/4a8fe77707127d251702610490f53430610e4ef7) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix two ways `createBCFFromIDSReport` could drop IDS validation failures from the exported BCF file with no trace:
  
  - A specification that fails on cardinality alone (its applicability matched zero entities and `minOccurs` required at least one — e.g. a required element type entirely missing from the model) produces an empty `entityResults`. The `per-entity` (default) and `per-requirement` grouping strategies iterate `entityResults` to build topics, so this kind of failure never became a topic at all: the validator correctly counted the specification as failed, but the exported BCF file showed nothing for it. Both strategies now emit a topic for a cardinality-only failure, the same way `per-specification` grouping already did.
  - `maxTopics` (default 1000) cut generation off with a bare early return in all three grouping strategies, silently dropping the remaining entities/specifications/requirements past the cap. `MAX_COMMENTS_PER_TOPIC` already handles its own, narrower truncation (comments within one topic) with an "... and N more" note; `maxTopics` now gets the same treatment via a synthetic `Info` topic recording how many further items were cut off.
- Updated dependencies [[`8ba612f`](https://github.com/LTplus-AG/ifc-lite/commit/8ba612f90d3bb0ad41f756d6fdef6b3250e8d330)]:
  - @ifc-lite/encoding@2.1.0

## 1.18.2

### Patch Changes

- [#2900](https://github.com/LTplus-AG/ifc-lite/pull/2900) [`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fail `writeBCF` for a BCF 3.0 topic missing `TopicType` or `TopicStatus` instead of silently emitting invalid markup.
  
  buildingSMART/BCF-XML `markup.xsd` (`release_3_0`) tightens both attributes
  from optional (2.1) to `use="required"`:
  
  ```
  <xs:attribute name="TopicType" type="NonEmptyOrBlankString" use="required"/>
  <xs:attribute name="TopicStatus" type="NonEmptyOrBlankString" use="required"/>
  ```
  
  `BCFTopic.topicType`/`topicStatus` are optional in our type, and the writer
  previously omitted the attribute entirely when either was unset, at both
  versions -- valid for 2.1, but schema-invalid for 3.0. Every first-party call
  site (`createBCFTopic`, the viewer's topic form, the IDS-to-BCF reporter, the
  clash bridge) already defaults both fields, so the gap was unreachable from
  the shipped app; it is reachable from the public `@ifc-lite/bcf` API
  (`createBCFProject({version:'3.0'})` + a hand-built `BCFTopic` +
  `addTopicToProject` + `writeBCF`), which SDK/script consumers can call
  directly.
  
  `writeBCF` now throws when writing a 3.0 topic without `topicType` or
  `topicStatus`, naming the missing attribute and the topic's guid, rather than
  inventing a default status the caller never chose -- a fabricated "Open" or
  "Issue" would misrepresent a topic's real state to every downstream
  consumer that reads `TopicStatus` for workflow logic. 2.1 output is
  unaffected; both attributes stay optional there.

- [#2758](https://github.com/LTplus-AG/ifc-lite/pull/2758) [`8f89331`](https://github.com/LTplus-AG/ifc-lite/commit/8f893311b170a983e160737bd9479c3caf961911) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `readBCF` silently dropping topics from spec-legal BCF files written by other tools.
  
  `reader.ts`'s regexes for `<Topic>`, `<RelatedTopic>`, `<Comment>`, and the
  comment's `<Viewpoint>` reference required `Guid` to be the attribute
  immediately after the tag name. XML attribute order is not semantically
  significant, so a file written with e.g. `<Topic TopicType="Issue"
  TopicStatus="Open" Guid="topic-1">` failed to match: `readTopic` logged
  "missing Topic element" and the whole topic -- title, comments, viewpoints --
  was silently dropped with no throw and no partial result.
  
  Our own `writer.ts` always emits `Guid` first, so every self round-trip
  passed and no existing test caught this; only a file from another tool
  exposed it.
  
  Each affected site now matches the opening tag generically (`<Tag\b([^>]*)>`)
  and pulls individual attributes out of the captured attribute string with a
  new shared `extractAttr` helper, so attribute order can no longer matter at
  any of these call sites.

- [#2899](https://github.com/LTplus-AG/ifc-lite/pull/2899) [`bc179f6`](https://github.com/LTplus-AG/ifc-lite/commit/bc179f6a1091c8c307a07b31d8c30fbba140e4a9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `markup.bcf`'s `<Topic>` children being written out of `xs:sequence` order.
  
  buildingSMART's BCF `markup.xsd` `Topic` sequence — identical in release_2_1 and release_3_0 — is `Title, Priority, Index, Labels, CreationDate, CreationAuthor, ModifiedDate, ModifiedAuthor, DueDate, AssignedTo, Stage, Description, BimSnippet, ...`. The writer previously emitted `Description` right after `Title` (before `Priority`/`Index`/`Labels`/the creation and modification fields/`Stage`) and `Labels` after `Stage` (long after `Priority`/`Index`) — both schema-invalid, since `xs:sequence` enforces element order, whenever a topic actually had a `Description` or non-empty `Labels` to write (an absent `Description` or empty `Labels` produced no element to be out of order). Confirmed against buildingSMART/BCF-XML's own release_3_0 conformance fixture (`Test Cases/v3.0/Visualization/Perspective camera`), whose `markup.bcf` places `Description` right before `BimSnippet`/`DocumentReferences`, matching the schema.

- [#2900](https://github.com/LTplus-AG/ifc-lite/pull/2900) [`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `writeBCF` accepting a BCF 3.0 topic whose `topicType` or `topicStatus`
  is XML-whitespace-only (e.g. `'   '` or `'\t'`) and writing it verbatim.
  
  `writeMarkupFile`'s BCF 3.0 required-attribute check used a bare `!value`
  test, which is falsy only for `undefined`/`''`. `markup.xsd` types both
  attributes as `NonEmptyOrBlankString`: after XML whitespace (`#x9`, `#xA`,
  `#xD`, `#x20`) is collapsed, the value must have length >= 1, so a
  whitespace-only value is schema-invalid even though it is JS-truthy. The
  check now also rejects a value that is entirely XML whitespace, with the
  same "fail the write rather than invent a value" behavior as the
  already-existing absent-value case.

- [#2760](https://github.com/LTplus-AG/ifc-lite/pull/2760) [`48b204b`](https://github.com/LTplus-AG/ifc-lite/commit/48b204b868016aad29b694b53ac8ace5e76a0542) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `readBCF` failing to resolve a viewpoint's snapshot when `markup.bcf` names
  it with a non-buildingSMART-convention filename.
  
  `parseViewpoints` looked up each viewpoint's declared `<Viewpoint>`/`<Snapshot>`
  filenames in `markup.bcf` with a regex matching the singular tag
  `<Viewpoint Guid="...">`. The markup element that actually carries those
  filenames is plural — `<Viewpoints Guid="...">`, per the BCF 2.1/3.0 schema and
  this package's own writer (`writer.ts` `writeMarkupFile` emits exactly that tag)
  — so the regex could never match a spec-correct file, and the lookup map was
  always empty. Every snapshot resolution silently fell through to a
  filename-guessing fallback (`Viewpoint_<guid>.bcfv` → `Snapshot_<guid>.png` and
  similar patterns). That fallback happens to cover buildingSMART's own reference
  fixtures, which follow the convention, but a third-party file is free to name
  its entries however it likes; when the filenames don't match a guessed
  pattern, the snapshot markup.bcf explicitly names was silently dropped even
  though it exists in the archive.
  
  The viewpoint's own GUID was never at risk — it comes from the `.bcfv` file's
  `<VisualizationInfo Guid="...">` element directly, independent of this lookup
  — so this was a snapshot-association defect, not a GUID/identity defect.
  
  Fixed the regex to match the plural `<Viewpoints>` tag, so the markup-declared
  filename is used when present and the naming-convention fallback now only
  runs when markup.bcf genuinely doesn't declare a snapshot. Added a test using
  a synthetic third-party-shaped archive (custom filenames, spec-legal) that
  previously lost its snapshot and now resolves it, plus a regression test
  against the buildingSMART `PerspectiveCamera.bcf` fixture.

- [#2902](https://github.com/LTplus-AG/ifc-lite/pull/2902) [`5a9ecfb`](https://github.com/LTplus-AG/ifc-lite/commit/5a9ecfb6bcd3190eae4463bd8926cf38a2143496) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Harden the IDS→BCF reporter's camera-direction test so a sign-flipped viewpoint camera can't pass silently.
  
  `computeCameraFromBounds` (`ids-reporter.ts`) places the BCF viewpoint camera
  off-center and points it back at the failing entity. The only test covering
  that direction, `should point camera toward entity center`, checked just
  `Math.sqrt(x²+y²+z²) ≈ 1` — true for *any* unit vector, including one
  pointing the camera at empty space away from the entity. Reversing the
  `dx/dy/dz` sign in `computeCameraFromBounds` (camera looking away from the
  entity instead of at it) left all 48 `ids-reporter.test.ts` tests green.
  
  The test now asserts `cameraDirection` equals the normalized vector from the
  (converted) camera position to the (converted) entity center, so a reversed
  sign fails. No production code changed — `computeCameraFromBounds` already
  computes the correct direction; this closes the fixture gap that couldn't
  have caught a regression there. Confirmed by mutation: reversing the sign in
  `computeCameraFromBounds` now fails the new assertion; reverting restores 48/48.

## 1.18.1

### Patch Changes

- Updated dependencies [[`b4b3e0c`](https://github.com/LTplus-AG/ifc-lite/commit/b4b3e0cfa8ffa9185e96dc266dd6fdc3fef34797)]:
  - @ifc-lite/encoding@2.0.0

## 1.18.0

### Minor Changes

- [#2479](https://github.com/LTplus-AG/ifc-lite/pull/2479) [`d38e71f`](https://github.com/LTplus-AG/ifc-lite/commit/d38e71feb2778cc2e9a5ee333b4f01339600dc9e) Thanks [@louistrue](https://github.com/louistrue)! - Close the five remaining paths by which a non-finite value reaches camera state: gesture arguments, model bounds, the unprojection basis, the `normalize` floor that both the picking ray and the pose pass through, and a viewpoint restore's reference distance.

  The gestures validated the pose but took their arguments on trust, so a finite pose could be destroyed from the caller's side instead of the file's. `orbit`, `pan` and `moveFirstPerson` each turned a healthy pose non-finite in one call for both NaN and Infinity, and `zoom` did for NaN — its delta clamp `Math.min(|d| * s, MAX)` absorbs Infinity but not NaN, an asymmetry the rest of this family does not share. The inertia velocities are worse than one bad frame: they accumulate in place and are only spent while `Math.abs(v) > minVelocity`, which is false for NaN, so a single poisoned argument would latch orbit, pan or zoom inertia dead for the session, never applied and never decaying. The cursor-anchored zoom divides by the canvas dimensions; the old truthiness test rejected `0` and `NaN` because both are falsy, but accepted a negative width, which mirrors the anchor, and `Infinity`, which pins it to a screen edge — and it never checked the cursor coordinates at all. A non-finite gesture argument now leaves the pose exactly as it found it, and an unusable cursor anchor — a non-finite coordinate or an unusable canvas extent — degrades to the un-anchored zoom, `orthoSize` included, rather than refusing to zoom. In-app event handlers cannot produce these values — wheel and pointer deltas are browser-guaranteed finite, the SpaceMouse driver clamps its axes, the pinch delta is a subtraction rather than a division, and every canvas writer floors the drawing buffer — so the route this guards is the published one, which `docs/guide/quickstart.md` and the `create-ifc-lite` template both teach by wiring raw browser input straight into these methods. `Renderer.resize` is hardened for the same reason: `canvas.width` is an IDL `unsigned long`, so it silently coerces a non-finite argument to `0`, and no pick guard in the package checks the drawing buffer.

  `frameBounds`, `zoomExtent`, `fitToBounds`, `setPresetView` and `fitBoundsAdaptive` all compute a centre and an extent from an AABB and write both into the pose — and, orthographically, into `orthoSize`, which `getOrthoSize()` reads and a saved viewpoint persists, so a bad fit outlived the session. The bounds are not caller-authored constants: every AABB accumulator in the package seeds `min = +Infinity, max = -Infinity` and narrows on a bare comparison, which is false for a non-finite vertex, so a mesh with no finite vertex hands out that inverted sentinel as if it were a real box — `model-bounds-tracker.test.ts` already pinned exactly that value — and `Scene.getEntityBoundingBox` neither filters it nor declines to cache it. An unusable box is now rejected and the camera keeps the pose it had, which is the same policy `setAspect`, `setFOV` and `setOrthoSize` settled on; there is no meaningful clamp for an infinite extent and no previous bounds to fall back to at these stateless entry points. A _degenerate_ box — a flat wall, a single point — is explicitly still framed. The two writers that bypassed `setOrthoSize` (the orthographic zoom and the animator's interpolation) now go through the same clamp, which also catches the reachable overflow of a legitimately huge half-height scaled by one more zoom-out notch.

  `unprojectToRay` returned a `(NaN, NaN, NaN)` ray origin for a non-finite `camera.up`, for both flavours, while the rendered frame stayed perfectly finite. That value leaves the package into picking and measurement, which test hits with comparisons — all false against NaN — so the click read as empty space rather than as an error. The orthographic branch was rebuilding its own screen basis with none of `lookAt`'s degeneracy handling, and that is what settles the design question: because `lookAt` substitutes a deterministic basis when `up` carries no usable orientation, there _is_ a well-defined frame on screen, and the ray must belong to it. `viewBasis` is now the single source of both, so they cannot drift; returning `null` instead would have failed a pick on a frame the user can see and pushed a branch onto every caller of a published API. The same function supplies the ray origin, so a non-finite camera position no longer produces a ray for a pose that was never rendered, and a viewport with no extent reads as a centred cursor rather than as an infinite one.

  The last member of the family is the floor inside `normalize` itself, in both copies of it: `MathUtils.normalize` (published) floored on `len < 1e-10` and the camera controls' private copy on `len > 1e-10`. Both are magnitude tests, so an infinite length passes them, and scaling by `1 / Infinity` turns an infinite component into NaN while the finite ones go to a clean `0` — a result that is neither finite nor the zero vector every caller falls back on, so the degenerate-case branch could not see it. Both are reached from inputs that are finite throughout, which is why no earlier guard in this family caught them: `MathUtils.invert` stores its result in a `Float32Array`, so an inverse component past 3.4e38 saturates to `Infinity` and `unprojectToRay` returned a direction of `{NaN, 0, -0}` — the silent picking miss again, this time in the perspective branch; and `cross(forward, up)` overflows component-wise for an `up` at the top of the double range, which put NaN into all six coordinates of `position` and `target` on one cursor-anchored wheel notch, past an `isUsableUp` that is a finiteness test and therefore accepts `Number.MAX_VALUE`. `normalize` is now total in both places: everything it cannot normalize is the zero vector, which is what its callers already handle.

  On the BCF side, `parsePoint` extracted coordinates with a bare `parseFloat`, which has no out-of-band failure value: `"NaN"` parses to `NaN` and the well-formed literal `"1e999"` parses to `Infinity`. A coordinate, `FieldOfView` or `ViewToWorldScale` that is not a real number is now reported the same way a missing element already was, so the camera is dropped and the rest of the viewpoint — selection, visibility, clipping, snapshot — still applies; every call site already handled that signal, so this adds no new branch. Separately, the conversions that turn a viewpoint into a viewer pose take the viewer's live `camera.getDistance()` as their reference distance, and that value is raw by contract, so once a pose was broken by any route every restore computed `target = viewPoint + direction * NaN` — meaning restoring a known-good viewpoint, the obvious way out, could not repair the camera. `perspectiveToCamera`, `orthogonalToCamera` and `computeMarkerPositions` now fall back to their documented defaults for a reference distance that is not usable, which is one guard at the sink every restore path funnels through rather than one per app-layer consumer; there are six of those, and guarding them individually is the arrangement that produced the gap.

### Patch Changes

- Updated dependencies [[`eb39b27`](https://github.com/LTplus-AG/ifc-lite/commit/eb39b27f5eba186b23b3a683c25fff2c60084d9c), [`7c686f9`](https://github.com/LTplus-AG/ifc-lite/commit/7c686f9ac39f78a707dc083c798b6ef3d255e171)]:
  - @ifc-lite/encoding@1.16.0

## 1.17.0

### Minor Changes

- [#2315](https://github.com/LTplus-AG/ifc-lite/pull/2315) [`1843d9f`](https://github.com/LTplus-AG/ifc-lite/commit/1843d9f13a7a10183f780ae0a1df9dd225938e73) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix BCF 3.0 `BimSnippet` and `DocumentReference` being written and read in the BCF 2.1 shape, which made our 3.0 output schema-invalid and silently dropped or corrupted the equivalent fields when reading a spec-correct 3.0 file from another vendor's tool.

  Three divergences between the two schema versions were unhandled (all per `buildingSMART/BCF-XML` `markup.xsd`):

  - `BimSnippet`'s external flag is `isExternal` in 2.1 and `IsExternal` in 3.0. The reader only matched the lowercase spelling, so a spec-correct 3.0 file with `IsExternal="true"` read back as `isExternal: false` — a silent wrong value, not a parse failure. The writer emitted lowercase at version 3.0. The same rename is already handled for the `Header`/`<File>` attribute; this applies the identical treatment to `BimSnippet`.
  - `DocumentReference` replaced 2.1's `<ReferencedDocument>` plus `isExternal` with a choice of `<DocumentGuid>` (a reference into `project.bcfp`'s Documents) or `<Url>`, dropping `isExternal` entirely. The reader required `<ReferencedDocument>` to be present, so every reference in a 3.0 file was dropped; the writer emitted the 2.1 shape regardless of version.
  - 3.0 groups the entries under a single `<DocumentReferences>` container, while 2.1 repeats `<DocumentReference>` directly under `<Topic>`. The writer emitted the 2.1 containment at version 3.0.

  `BCFDocumentReference` gains optional `documentGuid` and `url`, and `isExternal`/`referencedDocument` become optional since 3.0 has no equivalent — hence a minor rather than a patch, as reading either field now requires a presence check.

### Patch Changes

- [#2310](https://github.com/LTplus-AG/ifc-lite/pull/2310) [`8b09cfd`](https://github.com/LTplus-AG/ifc-lite/commit/8b09cfdadafaea9806e79b73deb9119ea66b5aa4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a zip-slip hazard in `writeBCF`: a viewpoint GUID is parsed unvalidated from untrusted markup XML on read, and was used verbatim in the `Viewpoint_<guid>.bcfv` / `Snapshot_<guid>.*` zip entry names. A crafted GUID containing `../` on a read-modify-save (e.g. `ifc-lite bcf add-comment`) could write a zip entry outside the archive root. The topic GUID already went through a sanitizer for the same reason; the viewpoint GUID now goes through the same sanitizer, computed once per viewpoint so the markup `<Viewpoint>` filename reference and the actual zip entry always agree.

  ifc-lite's own reader is in-memory and unaffected by this; the risk is a re-exported `.bcfzip` containing entries with literal `../` segments that could escape the archive root in a downstream tool that extracts entries by joining names onto a directory.

- Updated dependencies [[`273b068`](https://github.com/LTplus-AG/ifc-lite/commit/273b06827ef1469f63c396d204474a9f2400c642)]:
  - @ifc-lite/encoding@1.15.1

## 1.16.3

### Patch Changes

- [#1772](https://github.com/LTplus-AG/ifc-lite/pull/1772) [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7) Thanks [@louistrue](https://github.com/louistrue)! - Harden BCF archive I/O and the CSV formula-injection guard.

  BCF writer now sanitizes a topic GUID before using it as a zip folder name, so a GUID parsed from untrusted markup (`../../evil`) can no longer traverse outside the archive root on a read-modify-save (zip-slip). Sanitized names that collide (`a?b` and `a:b` both map to `a_b`) are disambiguated with a hash of the original GUID plus a counter backstop, so no topic silently overwrites another. BCF reader now caps the compressed input size, the raw zip record count (scanned from the buffer, so duplicate-pathname floods that JSZip dedupes to one visible entry are still counted), and the declared expanded size; because declared sizes are attacker-controlled, the expansion cap is additionally enforced on the ACTUAL decompressed bytes as entries stream out, aborting mid-entry. Entries declaring invalid (negative-reading) sizes are rejected outright.

  The lists CSV export formula-injection guard no longer quotes genuine numeric cells: `-0.35` and `+1` export unquoted (summable in Excel), while real injection vectors (`=`, `@`, tab/CR, and a leading `-`/`+` that is not a plain number such as `-cmd` or `-1+cmd`) are still prefixed with an apostrophe.

- Updated dependencies [[`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe)]:
  - @ifc-lite/encoding@1.14.11

## 1.16.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a)]:
  - @ifc-lite/encoding@1.14.10

## 1.16.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/encoding@1.14.9

## 1.16.0

### Minor Changes

- [#1619](https://github.com/LTplus-AG/ifc-lite/pull/1619) [`6be7ad4`](https://github.com/LTplus-AG/ifc-lite/commit/6be7ad477e1f20d6ba1a90e5b5db4645fc48a960) Thanks [@louistrue](https://github.com/louistrue)! - `BCFTopic` gains an optional `header?: BCFHeaderFile[]` field: the source IFC file(s) a topic refers to (markup `<Header>`), one entry per distinct model a federated topic spans, so a topic round-trips the provenance of every model it touches (issue [#1591](https://github.com/LTplus-AG/ifc-lite/issues/1591)).

  `writeBCF` now emits the `<Header>` block (version-correct: BCF 2.1 nests `<File>` directly, BCF 3.0 wraps them in `<Files>`), and `readBCF` parses it back into `topic.header`. Both are additive: topics without header files emit no `<Header>` element and existing markup output is unchanged.

## 1.15.7

### Patch Changes

- [#1548](https://github.com/LTplus-AG/ifc-lite/pull/1548) [`ec89d3f`](https://github.com/LTplus-AG/ifc-lite/commit/ec89d3f871f54b58fbfe32915ac6304505de1174) Thanks [@louistrue](https://github.com/louistrue)! - Fix BCF round-trip data loss. On read, XML entities in titles, descriptions, comments, and labels are now unescaped, so `&`, `<`, `>`, `"`, `'` come back exactly as written instead of as literal entities. The comment parser no longer truncates every comment to an empty string: the outer `<Comment Guid="...">` wrapper shares its tag name with its nested `<Comment>` text field, so the parser now slices each wrapper's span up to the next wrapper (or end of markup) and takes the last `</Comment>` as its real close. That is robust across BCF 2.1 and 3.0 (where comments sit inside a `<Comments>` container) and tolerates unknown vendor elements, so no comment is silently dropped. On write, `BimSnippet` (when it carries the schema-required `ReferenceSchema`) and `DocumentReference` are now emitted; they were parsed and typed but never written, so they were silently dropped on every export.

## 1.15.6

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/encoding@1.14.7

## 1.15.5

### Patch Changes

- [#946](https://github.com/LTplus-AG/ifc-lite/pull/946) [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0) Thanks [@louistrue](https://github.com/louistrue)! - Fix a batch of verified findings from a full-codebase review (security, correctness,
  data-loss, and resource/memory leaks). Highlights:

  **Security**

  - collab-server: a malformed WebSocket frame no longer crashes the whole process
    (decode is wrapped; a bad frame is rejected/audited instead of throwing).
  - mcp: the local HTTP transport now validates `Host`/`Origin` and no longer sends a
    wildcard `Access-Control-Allow-Origin`, closing a DNS-rebinding/CSRF hole; the
    `AuthScope.modelIds` allowlist is now enforced at model resolution.
  - server-bin: `extractZip` uses `execFileSync` (argv, no shell), removing command
    injection via archive/destination paths.
  - export / sdk / cli / mcp / lists / viewer CSV exporters now neutralize spreadsheet
    formula injection (CWE-1236) consistently.
  - create-ifc-lite: validates the project name (no path traversal) and drops the
    unused `execSync`-based downloader.
  - embed-sdk: inbound `postMessage` now validates `event.origin`.

  **Correctness / data-loss**

  - parser: `lengthUnitScale` survives the worker transport; the nested STEP list
    parser is string-aware (commas/parens inside quoted values no longer mis-split).
  - mutations: deleting a property from a session-created pset and replaying
    `UPDATE_ATTRIBUTE` / `CREATE_PROPERTY_SET` mutations now work.
  - export: merged-export ID remapping no longer rewrites `#N` inside quoted strings.
  - drawing-2d: GPU section cutter triangle upload/readback use correct WGSL std-layout
    offsets and strides.
  - ifcx: cyclic children no longer abort the parse; spatial children round-trip; the
    mesh transform guards a zero/non-finite homogeneous `w`.
  - data / cache: a `NULL` string property value stays `null` instead of becoming `""`.
  - pointcloud, bcf, server-client, query, viewer-core, viewer store/federation: assorted
    decoding, federation-id, and selection-state fixes.

  **Resource / memory leaks**

  - geometry, query (DuckDB), renderer (GPU buffers), collab (federation presence),
    sandbox (host log capture + runtime), mcp (clash mesh cache), server-bin (signal
    listeners), and the viewer renderer on unmount now release resources deterministically.

  **Hardening (apps, not published)**

  - server: a dedicated `server-release` Cargo profile (`panic = "unwind"`) plus a
    `CatchPanicLayer` contain a malformed-IFC parse panic to the offending request
    instead of aborting the whole server.
  - desktop (Tauri): a Content-Security-Policy is set, and unused `shell:*` /
    `fs:allow-write|mkdir|remove` capabilities (and the unused shell plugin) are removed.

  **Second pass** (additional verified findings)

  - collab-server: S3 log load now follows `ListObjectsV2` pagination (no dropped frames);
    awareness frames are size-capped + rate-limited; path-lock verify runs after role/rate-limit;
    the blob route requires auth and `/metrics` can be token-gated.
  - server-bin: downloaded binaries are SHA-256 verified against a release sidecar (fail-closed on
    mismatch, warn-if-absent for older releases).
  - extensions: inner-ring capability check fails _closed_ for unknown namespaces; signing
    canonicalization is now injective (length-prefixed).
  - correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
    comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
    spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
    point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
    output escaping; and more.

## 1.15.4

### Patch Changes

- [#831](https://github.com/LTplus-AG/ifc-lite/pull/831) [`8b48495`](https://github.com/LTplus-AG/ifc-lite/commit/8b48495bc65c8ca778c3b60f271108f641fafe02) Thanks [@jonatanjacobsson](https://github.com/jonatanjacobsson)! - Color 3D BCF topic markers by topic status instead of priority, and match the active-marker pulse ring to the status color.

## 1.15.3

### Patch Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Add CesiumJS 3D Tiles integration with synchronized camera controls, and expose renderer camera state for external consumers.

## 1.15.2

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/encoding@1.14.6

## 1.15.1

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

- Updated dependencies [[`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7)]:
  - @ifc-lite/encoding@1.14.5

## 1.15.0

### Minor Changes

- [#422](https://github.com/louistrue/ifc-lite/pull/422) [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d) Thanks [@louistrue](https://github.com/louistrue)! - Add 3D BCF topic marker overlay that positions markers above referenced geometry, tracks camera movement in real-time, and supports click/hover interactions with the BCF panel

### Patch Changes

- [#422](https://github.com/louistrue/ifc-lite/pull/422) [`506c65d`](https://github.com/louistrue/ifc-lite/commit/506c65da730a655ad6745a8e7a063435f335ff0d) Thanks [@louistrue](https://github.com/louistrue)! - Fix XSS vulnerability by escaping marker status text before HTML injection in overlay renderer

## 1.14.3

## 1.14.2

## 1.14.1

## 1.14.0

## 1.13.0

## 1.12.0

## 1.11.3

## 1.11.1

## 1.11.0

## 1.10.0

## 1.9.0

## 1.8.0

## 1.7.0

## 1.4.0

### Minor Changes

- 0191843: feat: Add BCF (BIM Collaboration Format) support

  Adds full BCF 2.1 support for issue tracking and collaboration in BIM workflows:

  **BCF Package (@ifc-lite/bcf):**

  - Read/write BCF 2.1 .bcfzip files
  - Full viewpoint support with camera position, components, and clipping planes
  - Coordinate system conversion between Y-up (viewer) and Z-up (IFC/BCF)
  - Support for multiple snapshot naming conventions
  - IFC GlobalId mapping for component references

  **Viewer Integration:**

  - BCF panel integrated into properties panel area (resizable, same layout)
  - Topic management with filtering and status updates
  - Viewpoint capture with camera state, selection, and snapshot
  - Viewpoint activation with smooth camera animation and visibility state
  - Import/export BCF files compatible with BIMcollab and other tools
  - Email setup nudge in empty state for easy author configuration
  - Smart filename generation using model name for downloads

  **Renderer Fixes:**

  - Fix screenshot distortion caused by WebGPU texture row alignment
  - Add GPU-synchronized screenshot capture for accurate snapshots

  **Parser Fixes:**

  - Extract GlobalIds for all geometry entities (not just spatial) to enable BCF component references

  **Bug Fixes:**

  - Fix BCF viewpoint visibility not clearing isolation mode
  - Add localStorage error handling for private browsing mode
  - Fix BCF XML schema compliance for BIMcollab compatibility:
    - Correct element order (Selection before Visibility)
    - Move ViewSetupHints to Components level (not inside Visibility)
    - Write OriginatingSystem/AuthoringToolId as child elements (not attributes)
    - Always include required Visibility element
