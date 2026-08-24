# @ifc-lite/mcp

## 0.12.0

### Minor Changes

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

- [#3115](https://github.com/LTplus-AG/ifc-lite/pull/3115) [`8ba612f`](https://github.com/LTplus-AG/ifc-lite/commit/8ba612f90d3bb0ad41f756d6fdef6b3250e8d330) Thanks [@louistrue](https://github.com/louistrue)! - CSV: numeric cells export as numbers. **The formula guard's default changed.**
  Pass `exemptNumbers: false` to `escapeCsvCell` / `guardSpreadsheetFormula` to
  keep the old behaviour.
  
  **Read this first if you consume `@ifc-lite/export`.** The CWE-1236 guard
  prefixes a leading `=`, `+`, `-`, `@`, TAB or CR with `'` so a spreadsheet reads
  the cell as text. It now makes one exception by default: a cell that is *wholly*
  a signed number is left alone. Nothing in your code has to change for the
  behaviour to change, which is why this is called out here rather than in a
  footnote.
  
  The exception cannot weaken the guard. The exempted language contains only
  `+ - . e E` and the digits `0-9`, which cannot spell a function name, a cell
  reference or a `(`. `=`, `@`, TAB and CR are never exempted, `-0.35=cmd` is not
  wholly a number and stays guarded, and a leading invisible character defeats the
  exemption rather than the guard, so `<ZWSP>-1` is still prefixed.
  
  **What it costs.** The default has to guess from the text, because most callers
  hand it a bare string, and guessing gets identifiers wrong: a `+`-prefixed phone
  number is wholly numeric as text, so it is written bare and Excel renders
  `4.1791E+10` with the `+` gone. `-007` becomes `-7`. Both were previously kept
  exactly, as `'`-prefixed text.
  
  The viewer's Lists CSV does not guess, because it has the value itself: it
  exempts a cell when the value really is a number and guards it otherwise, so a
  phone number stays text there and a measure stays summable even in a column that
  also holds text. So this cost applies to the writers that only ever see strings,
  which is the CLI, the SDK, MCP, the compare report, search results, zone tables
  and `@ifc-lite/lists`' own CSV. Pass `exemptNumbers: false` to opt any of them
  out.
  
  **Why the exception exists.** `@ifc-lite/lists` had exempted numbers since [#1772](https://github.com/LTplus-AG/ifc-lite/issues/1772)
  ("`-0.35` exported as `'-0.35` and broke Excel SUM()") while every other writer
  guarded them, so the same list exported two ways did not match. The policy is
  now one default rather than eleven call-site decisions that drift.
  
  **The viewer's Lists CSV stopped formatting numbers before writing them.** It
  ran every value through the display formatter, which calls `toLocaleString()` on
  integers. Under en-US that wrote `"-1,000"`, quoted because of the comma, so the
  column stopped summing. Under a locale that groups with `.` it wrote a bare
  `-3.000`, which a spreadsheet in a `,`-grouping locale reads back as **-3**, a
  silent 1000x error in a quantity column. Exempting numbers fixes neither, since
  neither string is wholly numeric in the locale that produced it. CSV is
  machine-readable output, so it now writes the number, matching what the XLSX
  writer always did. PDF, which a human reads, is unchanged.
  
  Two consequences of that, both deliberate. Unit-converted values now show their
  full double precision (3 ft in metres is `0.9144000000000001`, not `0.9144`),
  which is the same value the XLSX export already carried, so the two agree. And grouping a
  list by a numeric column used to hard-code that column as non-numeric in the
  schedule/pivot export, where the grouping value is the *only* place the value
  appears; it wrote `"'-3,000"` and nothing else for -3000. Schedule grouping
  columns now inherit `numeric` and carry the raw value, falling back to the group
  label where a bucket holds values that merely format alike.
  
  **The numeric test no longer backtracks.** It was
  `/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/`, quadratic on a failing match and
  reached only after a trigger matched, so `-` plus 60k digits took ~1.8s. IFC
  property text is attacker-controllable, which made that a denial of service on
  an export. It is a linear scan now, and lives in `@ifc-lite/encoding` (no
  dependencies, already depended on by both callers) as the new `isWhollyNumeric`
  export, so there is one copy per language rather than one per package. The
  accepted language is unchanged, checked by sweeping every string up to four
  characters over the alphabet it is built from against the old regex.

- [#3034](https://github.com/LTplus-AG/ifc-lite/pull/3034) [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b) Thanks [@louistrue](https://github.com/louistrue)! - Stop dropping entities from an unfiltered query, and stop reporting their class as `Unknown`, when the curated `IfcTypeEnum` does not carry it.
  
  **`isProductType` now keys on the inheritance chain.** It gated on `IfcTypeEnumFromString(type) !== Unknown`, and `TYPE_STRING_TO_ENUM` is a curated 138-entry subset — the same table PR [#3009](https://github.com/LTplus-AG/ifc-lite/issues/3009) found rejecting standard buildingSMART classes. An unfiltered `bim.query()` walks `store.entityIndex.byType` and keeps only entries this predicate accepts, so every class outside those 138 was absent from the result with nothing to say so. On a 176k-entity MEP model that was every `IfcAirTerminal` (139), every `IfcDuctFitting` (383) and every `IfcDistributionPort` (2,053): 2,575 real elements, reported as not present rather than as unclassified.
  
  The gate is now `isQueryableObjectType` in `@ifc-lite/parser`: `getInheritanceChain(type).includes('IfcObjectDefinition')`, minus `IfcTypeObject` descendants. It lives in the parser rather than in each backend because `isProductType` was a verbatim copy in `packages/cli` and `packages/mcp` and only the CLI copy had tests — a predicate that had just diverged once should not be left in two places to diverge again. Both backends now alias the single implementation and keep publishing it under the old name. That is the exact line the four prefix tests were approximating: `IfcObjectDefinition` covers products, type objects, groups, systems and `IfcContext`, and excludes the other two `IfcRoot` branches, `IfcPropertyDefinition` and `IfcRelationship`. The chain resolves across the bundled schema union, so it answers for classes the pin omits. `IFC_ENTITY_NAMES` alone would not work here: it carries all ~880 classes, so keying on "is a known IFC name" floods the same query with that model's 42,024 `IfcCartesianPoint`.
  
  The MCP `dataQuality` audit counts the same set, so its score moves for an unchanged file: ports, groups, systems and annotations now enter the naming denominator that the 138-entry table kept out, and most of them are unnamed.
  
  **Behaviour change worth planning for:** on that model an unfiltered `bim.query()` returns 3,090 entities where it returned 515. The growth is real elements that were missing, and it is dominated by ports on MEP models. Callers that want the narrower set should filter with `byType`.
  
  **`EntityNode.type` no longer answers `Unknown` for an entity the product table does not index.** `store.entities` indexes products, so `getTypeName` has no row for `IfcPropertySet`, `IfcElementQuantity`, `IfcRelDefinesByProperties` or `IfcRelAssociatesMaterial` and answered `'Unknown'` for all four, while `entityIndex.byId` carried the class the whole time as the raw uppercase STEP token. `type` is what callers key passes on, so iterating a model's classes by it skipped 8,928 entities on that same model. It now falls back to the index and canonicalises through `normalizeIfcTypeName`, which resolves against the bundled schema union. `IFC_ENTITY_NAMES` would have been the same curated-subset trap one file over: it is ~880 hand-maintained entries whose generator script no longer exists, so an `IfcMove` on an IFC2X3 model came back as the raw `IFCMOVE` token — a second wrong answer.
  
  `QueryResultEntity.type`, which is what `EntityQuery.execute()` returns, carried the identical getter and is fixed with it. Both now call one `resolveEntityTypeName`; fixing only `EntityNode` would have left the two disagreeing on the same entity.
  
  Verified against the real columnar parser, not only against the query package's mock store. With both changes reverted, 3 of the 5 new CLI tests fail and 1 of the 4 new query tests fails; the two CLI tests that still pass are the ones asserting what stays excluded.

- [#3034](https://github.com/LTplus-AG/ifc-lite/pull/3034) [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b) Thanks [@louistrue](https://github.com/louistrue)! - Add `bim.style`, colour that ends up in the exported IFC.
  
  `bim.viewer.colorize` paints the current view. The colour is an overlay and is gone the moment the model is written out, so a script that wanted a coloured file had to hand-build the `IfcColourRgb → IfcSurfaceStyleShading → IfcSurfaceStyle → IfcStyledItem` chain itself and walk `IfcProductDefinitionShape → IfcShapeRepresentation → Items` to find something to attach it to. `StepExporter` already builds that chain internally for demeshed output; nothing exposed it.
  
  `bim.style.apply(refs, color)` and `bim.style.applyAll(batches)` take any hex form `bim.viewer.colorize` takes — they share its `hexToRgba` — or channels in 0..1. The one deliberate difference is the failure mode: `hexToRgba` degrades an unparseable string to black, which is right for a transient overlay and wrong for something written into the file, so a non-hex string throws instead of being baked in as black.
  
  The work lives in `applyStylesInStore` in `@ifc-lite/create`, beside the other in-store builders, and writes through the same `StoreEditor` overlay as `bim.spaces.generate`. Both headless backends implement it; a backend without direct store access, including the browser viewer's, throws.
  
  Four things the call site no longer has to get right:
  
  **Mapped geometry.** An `IfcMappedItem` is followed through to the `IfcRepresentationMap` and the mapped representation's items are styled, so one style covers every occurrence of a type. On a real MEP model, 139 air terminals share 63 geometry items; styling per occurrence would write a second `IfcStyledItem` on geometry that already had one, which IFC does not allow.
  
  **Geometry that already has a style, including geometry this session styled.** IFC permits at most one `IfcStyledItem` per representation item. The index of existing styles covers both the source file and the overlay: `StoreEditor.addEntity` does not insert into `store.entityIndex`, so a source-only check could not see the session's own writes and a second `apply` over the same products emitted two styled items on one solid — a schema-invalid file, from the very machinery meant to prevent it. That index is also built once per pass rather than per batch, which was 87 ms per batch on a 92k-styled-item model, about two thirds of a colour-by-class run.
  
  **Entities created in the same session.** Reads fall back to the overlay, so `bim.store.addWall(...)` followed by `bim.style.apply` colours the new wall instead of reporting it as geometry-less and leaving an orphan `IfcSurfaceStyle` in the file.
  
  **Schema differences.** `Representation` is resolved by attribute name rather than by a hardcoded index 6, because that slot is `RepresentationMaps` on `IfcTypeProduct` — a list, so a constant index turned a type object into a silent no-op. IFC2X3 gets the `IfcPresentationStyleAssignment` wrapper that IFC4 deprecated. Transparency is rounded, since `1 - 0.9` otherwise reaches the STEP text as `0.09999999999999998`.
  
  A style chain is only left in the file while something references it. Colour a wall red and recolour it green — in a later batch or a later call — and the red chain goes with the styled item it belonged to. What gets swept is tracked as it is authored, per editor, rather than inferred from the overlay: inference could not see `setPositionalAttribute` edits (`getNewEntities` reports attributes as created, while the exporter applies positional mutations on top), so it removed live styles and left the real garbage; it took a chain's shading and colour without checking whether anything else used them; and it collected any overlay `IfcSurfaceStyle` at all, including one a caller had authored with `bim.store.addEntity` and not yet attached. Only chains `bim.style` created are its to remove, and a chain whose styled items were repointed elsewhere is kept rather than risked. A batch that styles nothing writes nothing at all: `surfaceStyleId` is `null`. A caller colouring by IFC class hands in one batch per class, and most classes in a real model — types, ports, spatial structure — reach no geometry, so emitting the style up front left an orphan `IfcColourRgb` / `IfcSurfaceStyleShading` / `IfcSurfaceStyle` per such batch. Found by using the API for a colour-by-class pass: 16 styles in the file where 5 were referenced.
  
  `productsWithoutGeometry` counts a product only when its own walk reached nothing. Deciding it from the growth of the shared item set instead would report every occurrence after the first as geometry-less whenever a type's occurrences share one mapped representation — which is most of them, and was wrong in the first cut of this.
  
  `followMappedItems: false` styles the `IfcMappedItem` per occurrence instead. Following the representation map is right for colouring by IFC class and wrong for any other grouping — by system, storey or property value, shared geometry takes whichever colour ran last and drags unrelated occurrences with it.
  
  `schema` names the schema the chain is built for, defaulting to the store's. The style shape is decided when the style is authored and the export schema is chosen later, so an IFC4 model exported as IFC2X3 otherwise emits `IfcStyledItem.Styles` pointing straight at an `IfcSurfaceStyle`, which that schema does not allow. Converting existing style records during a schema change is a separate job for `StepExporter` and is not attempted here.
  
  An `#rrggbbaa` string's alpha pair is honoured. `hexToRgba` discards those digits and takes alpha from its own argument, which is right for the viewer; here they are the only way the string form can ask for transparency, and dropping them silently wrote an opaque style.
  
  Verified on the export rather than on the overlay, against a fixture carrying direct geometry, two occurrences behind one representation map, a product with no representation, and geometry that already carries a style.

### Patch Changes

- [#3102](https://github.com/LTplus-AG/ifc-lite/pull/3102) [`7ff31ba`](https://github.com/LTplus-AG/ifc-lite/commit/7ff31ba854671a9ca3ebbf30b15e928e1b52a8b9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - CSV cell escaping now has one implementation per language
  
  `@ifc-lite/export` gains `escapeCsvCell` and `guardSpreadsheetFormula`. Every
  CSV writer in the SDK, CLI and MCP now calls them instead of carrying its own
  copy of the RFC 4180 quoting and the CWE-1236 spreadsheet formula-injection
  guard.
  
  Two behaviour changes come with that, in the copies that were behind:
  
  - The formula trigger is looked for **past** any leading invisible characters
    (Unicode `Cf` + `Z`: BOM, zero-width space, LTR mark, non-breaking space,
    U+2028/U+2029, ordinary spaces). The copies in the CLI, MCP and the SDK's
    CSV export tested it anchored at offset 0, so a crafted IFC value such as
    `﻿=HYPERLINK(...)` was exported unguarded.
  - Those invisibles are looked past, not deleted. The one hardened copy removed
    them, and its character class included U+0020, so leading spaces were stripped
    from exported cells — RFC 4180 §2.4 says spaces are part of the field.
  
  Cells with no leading invisible and no formula trigger are unchanged.
  
  The Rust exporter (`ifc_lite_export::csv_cell`) carries the matching
  implementation, and both are pinned to one shared table of test vectors so the
  two languages cannot drift apart.

- [#3034](https://github.com/LTplus-AG/ifc-lite/pull/3034) [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b) Thanks [@louistrue](https://github.com/louistrue)! - Make `bim.mutate.*` persist in the headless CLI and MCP backends instead of silently discarding every edit.
  
  `HeadlessBackend.createMutateAdapter` answered `setProperty`, `setAttribute` and `deleteProperty` with no-ops in both `packages/cli` and `packages/mcp`. Nothing threw and nothing returned a failure, so an `ifc-lite run` script could call `bim.mutate.setProperty` six thousand times, report six thousand edits, and get an export back byte-for-byte identical to its input. The write path that does persist was already present — `MutablePropertyView`, which `StepExporter` reads when `applyMutations` is on, and which `bim.store.*` and `bim.spaces.*` already routed into — nothing connected `bim.mutate` to it.
  
  Both backends now share `createHeadlessMutateAdapter` from `@ifc-lite/sdk`, which owns `MutateBackendMethods` and already depends on `@ifc-lite/mutations`. The adapter takes a thunk rather than a view so the overlay is still built on first write and a read-only session pays nothing.
  
  Values are classified before they are stored. `MutablePropertyView.setProperty` defaults to `PropertyValueType.String`, so forwarding a raw JavaScript value wrote `IFCLABEL('true')` where the caller passed `true`; `propertyValueTypeOf` maps boolean to `IFCBOOLEAN`, whole numbers to `IFCINTEGER` and the rest to `IFCREAL`.
  
  `undo` and `redo` still answer `false` and `batchBegin`/`batchEnd` are still accepted and ignored: the mutation history they would walk belongs to the viewer's store, and a headless session has none. That is now documented at the adapter rather than implied by a bare stub.
  
  The browser viewer's adapter had the same defect from the other direction: it forwarded the raw value to `mutationSlice.setProperty`, whose `valueType` also defaults to `String`, so `bim.mutate.setProperty(ref, pset, prop, true)` wrote `IFCLABEL('true')` there too. It now passes `propertyValueTypeOf`, which is also why that helper is exported. The two other character-identical copies of the classifier — `detectValueType` in the MCP mutation tool and `inferValueType` in the CLI gym ops — now alias it, so the paths cannot diverge on a future correction.
  
  Verified on the export, not on the overlay — reading the view back passes against the broken adapter too. With the original no-ops restored, 5 of the 6 new CLI tests fail; the sixth is the control that asserts an unmutated re-export still contains the original name.

- [#2988](https://github.com/LTplus-AG/ifc-lite/pull/2988) [`f135c02`](https://github.com/LTplus-AG/ifc-lite/commit/f135c02624b8a7aa1915068405545d108f55fce4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `ids_validate`'s summary reporting a specification as failed when it legitimately passed while matching zero entities.
  
  `summarizeIdsReport` cast the report to a hand-written minimal shape,
  ignored `spec.status` entirely, and used `entityResults.length > 0` as the
  pass condition for a specification. A specification with an explicit
  `minOccurs="0"` (or a prohibited spec that correctly matches nothing) is a
  legitimate pass with zero matched entities -- the validator's own
  `report.summary` already gets this right, but the tool never read it.
  
  `summarizeIdsReport` now projects `report.summary` directly instead of
  re-deriving the counts, and the report parameter is typed as the real
  `IDSValidationReport` rather than `unknown`, so there is no longer a
  hand-written shape for the two to drift apart on.
- Updated dependencies [[`93b450c`](https://github.com/LTplus-AG/ifc-lite/commit/93b450c1cc0c3cee811625989edb82cf522c70c4), [`ddf9f1d`](https://github.com/LTplus-AG/ifc-lite/commit/ddf9f1da830cef5f941ea09e8aee19624e9def3a), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`e19aa0e`](https://github.com/LTplus-AG/ifc-lite/commit/e19aa0ef271eccc7f2f6862b8580e9f98dbd1a66), [`66697fc`](https://github.com/LTplus-AG/ifc-lite/commit/66697fc57de1de4475a2c5eed4361e0e378e0f7a), [`447f02e`](https://github.com/LTplus-AG/ifc-lite/commit/447f02eefc2933c63c03aea6c7793343df20fcd7), [`228bbe7`](https://github.com/LTplus-AG/ifc-lite/commit/228bbe730522148ea797780c5acd08502b18a3a3), [`e6caf11`](https://github.com/LTplus-AG/ifc-lite/commit/e6caf11a8f8d9d8634a6811b6705ab3367cd02e0), [`2580830`](https://github.com/LTplus-AG/ifc-lite/commit/25808308bbbc63eb0fd8b25e6dd0c08864adb6a8), [`b25b2e7`](https://github.com/LTplus-AG/ifc-lite/commit/b25b2e7387bd365fda02d48095266f16b4f05cd7), [`7ff31ba`](https://github.com/LTplus-AG/ifc-lite/commit/7ff31ba854671a9ca3ebbf30b15e928e1b52a8b9), [`8ba612f`](https://github.com/LTplus-AG/ifc-lite/commit/8ba612f90d3bb0ad41f756d6fdef6b3250e8d330), [`9359bc4`](https://github.com/LTplus-AG/ifc-lite/commit/9359bc488173585b2b90e124cc66dcf8292c4be9), [`8571d70`](https://github.com/LTplus-AG/ifc-lite/commit/8571d70270d072170fc4e204e8b0d11a424d2330), [`f6febcc`](https://github.com/LTplus-AG/ifc-lite/commit/f6febcc2d4986e79b3c44d63853bb72a16475c65), [`bc2e5e5`](https://github.com/LTplus-AG/ifc-lite/commit/bc2e5e56d7324f605b15b6e6f939849859a5d0ad), [`1118399`](https://github.com/LTplus-AG/ifc-lite/commit/11183991d9fb042221d20f1ca432dc0b2293c928), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`063a140`](https://github.com/LTplus-AG/ifc-lite/commit/063a1408e4c54ebc874618f8d68fe298ed3f3a6f), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`f76c805`](https://github.com/LTplus-AG/ifc-lite/commit/f76c80511dce5ffc1756365b786042c4bc64808d), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`4a8fe77`](https://github.com/LTplus-AG/ifc-lite/commit/4a8fe77707127d251702610490f53430610e4ef7), [`ffcc9e6`](https://github.com/LTplus-AG/ifc-lite/commit/ffcc9e6f048cd263a5b70946417c9b6aceec1bec), [`4a8fe77`](https://github.com/LTplus-AG/ifc-lite/commit/4a8fe77707127d251702610490f53430610e4ef7), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`0146f0a`](https://github.com/LTplus-AG/ifc-lite/commit/0146f0a3b2ed36313f7f91236bcc95587cdcc8d3), [`f449776`](https://github.com/LTplus-AG/ifc-lite/commit/f4497765cb4e17828ff6ca6b52fb8a96caa2f81f), [`5ea5f99`](https://github.com/LTplus-AG/ifc-lite/commit/5ea5f9969f3a4a3f8b21eb2a90a1df2be48eb7b0), [`412f78c`](https://github.com/LTplus-AG/ifc-lite/commit/412f78c1bf4907f8c230fc149bbb00e0711b6689), [`487866d`](https://github.com/LTplus-AG/ifc-lite/commit/487866dac131bf50a0b3008ddce5db933768dca2), [`932f043`](https://github.com/LTplus-AG/ifc-lite/commit/932f0439fc1625419aae3cf2d9f81a614fb2273c), [`f1ee3e8`](https://github.com/LTplus-AG/ifc-lite/commit/f1ee3e88889281af34f0e382cef7ea57ee9d47c1), [`24c0d75`](https://github.com/LTplus-AG/ifc-lite/commit/24c0d75c5e5f1f162737e82e1ff24f7958b9f9b6), [`754837b`](https://github.com/LTplus-AG/ifc-lite/commit/754837b066172dad8afcdf1a0104f1a021b5f6e5), [`2273a73`](https://github.com/LTplus-AG/ifc-lite/commit/2273a73127d03ec36d667544da6237479737881a), [`131e3dc`](https://github.com/LTplus-AG/ifc-lite/commit/131e3dc84244d9dd24859a5923ef0aef4d6119c4), [`a8587cc`](https://github.com/LTplus-AG/ifc-lite/commit/a8587cc21c309ebd6c87119cb0d1cd6d1005c281), [`945c4d7`](https://github.com/LTplus-AG/ifc-lite/commit/945c4d7a773614dd664feb9490e13372782a543b), [`fdd6121`](https://github.com/LTplus-AG/ifc-lite/commit/fdd61211e41d3e563a7604ac5e0630a9daae2de1), [`b59c520`](https://github.com/LTplus-AG/ifc-lite/commit/b59c5206a154728139d1307bf823e5c5d7c4786a), [`870ec9e`](https://github.com/LTplus-AG/ifc-lite/commit/870ec9ee9a35f798196c59ce82e65e210eddd429), [`00f6e79`](https://github.com/LTplus-AG/ifc-lite/commit/00f6e79c22641ff59bfb3327d910b04f9a164d8b), [`116a3e9`](https://github.com/LTplus-AG/ifc-lite/commit/116a3e94de753b95fa94b2d6c41a0171cd254729), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`147693a`](https://github.com/LTplus-AG/ifc-lite/commit/147693a7a8fd0778ddb71839199b75bf1d622327), [`af48854`](https://github.com/LTplus-AG/ifc-lite/commit/af488542a19a8559065cfd450d0eaad5ba2f7489), [`3969c52`](https://github.com/LTplus-AG/ifc-lite/commit/3969c523063d02e501f421e6b42d1a9a516dc2e4), [`bb734da`](https://github.com/LTplus-AG/ifc-lite/commit/bb734da27afbea4b6e595714950cdb195cddeb1f), [`043e06a`](https://github.com/LTplus-AG/ifc-lite/commit/043e06a05c6625fef91bb17d84e3a3447f1379e3)]:
  - @ifc-lite/bcf@2.0.0
  - @ifc-lite/parser@4.3.0
  - @ifc-lite/collab@0.6.0
  - @ifc-lite/extensions@0.5.0
  - @ifc-lite/ifcx@3.0.0
  - @ifc-lite/merge@0.4.4
  - @ifc-lite/export@3.0.0
  - @ifc-lite/sdk@3.0.0
  - @ifc-lite/data@3.4.1
  - @ifc-lite/geometry@4.0.0
  - @ifc-lite/query@2.0.0
  - @ifc-lite/ids@1.15.49
  - @ifc-lite/clash@1.9.1
  - @ifc-lite/mutations@1.27.0
  - @ifc-lite/viewer-core@0.2.14
  - @ifc-lite/create@2.2.0

## 0.11.3

### Patch Changes

- [#2845](https://github.com/LTplus-AG/ifc-lite/pull/2845) [`8226c0a`](https://github.com/LTplus-AG/ifc-lite/commit/8226c0aae9c4ca641b970873c0a0adf648429205) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix two declared-but-ignored MCP tool inputs.
  
  `ids_validate`'s `locale` field (`en`/`de`/`fr`) was read into a variable and immediately discarded (`void input.locale`); no translator was ever built, so every call produced English `failureReason` / requirement-description text regardless of the requested locale. It now builds a `@ifc-lite/ids` translation service from `locale` and passes it into `validateIDS`, so `de`/`fr` actually translate the report.
  
  `geometry_bbox` / `geometry_volume` / `geometry_area`'s `global_id` / `global_ids` selectors resolved by scanning the parsed store directly, never consulting the session's pending-mutation overlay. That put them out of step with every other GlobalId-keyed tool (`get_entity`, `query_entities`, `bsdd_match`, `entity_delete`, ...), which all fold the overlay per the [#2014](https://github.com/LTplus-AG/ifc-lite/issues/2014)/[#2015](https://github.com/LTplus-AG/ifc-lite/issues/2015) one-resolution-rule: an entity created this session (`entity_create`) was invisible to the geometry tools by GlobalId even though `get_entity` found it immediately, and an entity queued for deletion (`entity_delete`) stayed resolvable there after `get_entity` already reported it gone. `resolveExpressIds` now resolves `global_id`/`global_ids` through the same overlay-aware `resolveGlobalIds` helper `get_entity` and `entity_delete` use.

- [#2734](https://github.com/LTplus-AG/ifc-lite/pull/2734) [`2edf1c6`](https://github.com/LTplus-AG/ifc-lite/commit/2edf1c60023832a7a9a3629e9d5aaa40e4be1e35) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `ServerConfig.autoOpenViewer` / `.viewerPort` being declared on the public
  `MCPServer` config type but never read by the server (issue [#2731](https://github.com/LTplus-AG/ifc-lite/issues/2731), finding 4).
  
  `MCPServer` takes `config: Partial<ServerConfig>` in its constructor, and the
  sibling fields `readOnly`, `bsddEndpoint`, `samplingEnabled` and
  `allowedPaths` are honoured via `ctx.config.*` — but `autoOpenViewer` and
  `viewerPort` were not. The CLI's own `--viewer` / `--viewer-port` auto-open
  behaviour came entirely from separate local variables (`opts.autoViewer`,
  `opts.viewerPort`) that happened to be written into `config` but never read
  back out of it. An embedder constructing `MCPServer` directly with
  `config: { autoOpenViewer: true }` got nothing, silently.
  
  Adds `MCPServer.maybeAutoOpenViewer(overrides?)`, which opens the in-process
  viewer for the first loaded model when configured to do so and no-ops
  otherwise. Precedence: an explicit `overrides` argument (what a CLI flag
  represents) beats `this.config` (set at construction, e.g. by an embedder)
  beats the built-in default (no auto-open, port 0). The CLI now calls this
  method with `{ autoOpen: opts.autoViewer, port: opts.viewerPort }` instead of
  calling `server.viewer.open()` directly, so its `--viewer` / `--viewer-port`
  behaviour is unchanged but now goes through the same config-aware path any
  other caller gets.

- [#2850](https://github.com/LTplus-AG/ifc-lite/pull/2850) [`5660d53`](https://github.com/LTplus-AG/ifc-lite/commit/5660d53f5326188c474bb0c31d3e1ff6b104426c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `mutation_batch` dispatching each sub-op with its raw, pre-validation `args` instead of `validateInput`'s validated result.
  
  Same shape as the collab-server bug in [#2846](https://github.com/LTplus-AG/ifc-lite/issues/2846): `mutation_batch`'s per-op loop already calls `validateInput(tool.inputSchema, subArgs)` and checks `validation.valid`, but then handed `subArgs` — the original, unvalidated object — to `tool.handler`, discarding `validation.value`. A single, non-batched call to the same tool goes through `MCPServer.handleToolCall`, which correctly dispatches with `validation.value` (the schema-default-filled result).
  
  No sub-tool on the batch whitelist (`entity_set_property`, `entity_delete_property`, `entity_set_attribute`, `entity_create`, `entity_delete`) currently declares a schema `default`, so this had no observable effect today — but the moment one does, a batched call and a single call would silently disagree about what an omitted field means, exactly like the `handleMessage`/`verifyWithReplayProtector` divergence, and the mismatch would be invisible to any test that only exercises `validateInput` in isolation or only exercises the reject path through `mutation_batch`.
  
  `mutation_batch` now dispatches with `validation.value`, matching the single-call path.
- Updated dependencies [[`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8), [`8f89331`](https://github.com/LTplus-AG/ifc-lite/commit/8f893311b170a983e160737bd9479c3caf961911), [`bc179f6`](https://github.com/LTplus-AG/ifc-lite/commit/bc179f6a1091c8c307a07b31d8c30fbba140e4a9), [`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8), [`48b204b`](https://github.com/LTplus-AG/ifc-lite/commit/48b204b868016aad29b694b53ac8ace5e76a0542), [`b14e710`](https://github.com/LTplus-AG/ifc-lite/commit/b14e710ae8d56f518f84abb4d4ec8d1f98aacad8), [`05592f8`](https://github.com/LTplus-AG/ifc-lite/commit/05592f8c1ef5b34a00c2ea077542dc68107a7ae5), [`432fdb8`](https://github.com/LTplus-AG/ifc-lite/commit/432fdb8dd12dd90af17d1ca3ce24a2fd5b7168b0), [`6a43522`](https://github.com/LTplus-AG/ifc-lite/commit/6a43522cdf3b0a9b0f7ce303b59f479dca2a2aca), [`b699875`](https://github.com/LTplus-AG/ifc-lite/commit/b6998754039676def950735335147556afcb2977), [`b3a4d30`](https://github.com/LTplus-AG/ifc-lite/commit/b3a4d307c50c9b0a8b8bb0e29952c4a98e417c16), [`0a10389`](https://github.com/LTplus-AG/ifc-lite/commit/0a1038972a72b27bda99c8793055efe39d623f10), [`5334bd1`](https://github.com/LTplus-AG/ifc-lite/commit/5334bd1589acb1c4b81a1f255d1a9171530b1467), [`b1ac6be`](https://github.com/LTplus-AG/ifc-lite/commit/b1ac6be425cd89ff90eaab02636211f0d928b3e6), [`c688a12`](https://github.com/LTplus-AG/ifc-lite/commit/c688a1272ec72d575e8ecf78072e0a0084b517ca), [`4ce3879`](https://github.com/LTplus-AG/ifc-lite/commit/4ce38798211b6b5f84e5b21ed335aa80fe1514c4), [`79322b6`](https://github.com/LTplus-AG/ifc-lite/commit/79322b6e76049be0df3b07149c711414bd80863e), [`2156528`](https://github.com/LTplus-AG/ifc-lite/commit/2156528c926114233c79ba74925c0c8656f1ea65), [`7869a90`](https://github.com/LTplus-AG/ifc-lite/commit/7869a90f35384ceba40b7ce4f3e9fadbe6990fa8), [`be6b43c`](https://github.com/LTplus-AG/ifc-lite/commit/be6b43c2b334811422c1cbfbea5d6e6d1b9a401d), [`989ee2c`](https://github.com/LTplus-AG/ifc-lite/commit/989ee2c4e396575529488c17b73e1a884e4e8b9d), [`1cda2d0`](https://github.com/LTplus-AG/ifc-lite/commit/1cda2d04dc66542892dd0181768c027b3d1b4e6f), [`b4740a1`](https://github.com/LTplus-AG/ifc-lite/commit/b4740a1fb18050c065e8fbd58714626bdf852f00), [`5a9ecfb`](https://github.com/LTplus-AG/ifc-lite/commit/5a9ecfb6bcd3190eae4463bd8926cf38a2143496), [`9fb50eb`](https://github.com/LTplus-AG/ifc-lite/commit/9fb50ebcfaaf2926b2badd4d4d8dfc6ca55b762f), [`969cff9`](https://github.com/LTplus-AG/ifc-lite/commit/969cff95a77ce4c17a949a93632c8a0378fd3ede), [`a29b040`](https://github.com/LTplus-AG/ifc-lite/commit/a29b04069fec3c6b726f49fc58054e535c255034), [`cc19a8d`](https://github.com/LTplus-AG/ifc-lite/commit/cc19a8d4a79a5e8563a90ab663b28e1b93ef9c18), [`36e4eca`](https://github.com/LTplus-AG/ifc-lite/commit/36e4eca3b19a2fe02f1679acc9a2a43cd90aa163), [`a7b8a20`](https://github.com/LTplus-AG/ifc-lite/commit/a7b8a201eaecd411a4246421893e887bf55aafd3), [`ad50aa9`](https://github.com/LTplus-AG/ifc-lite/commit/ad50aa9751c31f6895944e26ce19fe8cbbf3018e), [`ccc38b0`](https://github.com/LTplus-AG/ifc-lite/commit/ccc38b0de9925a3de1106893a5785117e0e7551d), [`105eb31`](https://github.com/LTplus-AG/ifc-lite/commit/105eb31e7ccdd697f74db3bc9fac41396cdc6faa), [`679c7cb`](https://github.com/LTplus-AG/ifc-lite/commit/679c7cb680ab0d8f17e8f5c267fdb424049ec0d0), [`ae14cd3`](https://github.com/LTplus-AG/ifc-lite/commit/ae14cd3036f11c039d9b7cd786acf51a68b884dc), [`f31822b`](https://github.com/LTplus-AG/ifc-lite/commit/f31822b0833e1bcd76c43736daf1d76cb3e59914), [`4d1c611`](https://github.com/LTplus-AG/ifc-lite/commit/4d1c611b822e80a6123b040887a31cdb43c460da), [`5254699`](https://github.com/LTplus-AG/ifc-lite/commit/52546994268440a468de81ce6ac0b385e6ef73d7), [`c233d48`](https://github.com/LTplus-AG/ifc-lite/commit/c233d48a935a70851271b61a305f43dd9261dcca), [`b28a629`](https://github.com/LTplus-AG/ifc-lite/commit/b28a629d49f279ce01537cb06ae4c28f32beb2bb), [`1900a1a`](https://github.com/LTplus-AG/ifc-lite/commit/1900a1a9f8174ef874dddbd1541ccadd9a89415e), [`6ce17fa`](https://github.com/LTplus-AG/ifc-lite/commit/6ce17fa903d38ab8ee3e6ebaf6da8453726d3ce2), [`b7d2a11`](https://github.com/LTplus-AG/ifc-lite/commit/b7d2a11345add8acdf0926ade5d4c1ca19ccecf7), [`c849b13`](https://github.com/LTplus-AG/ifc-lite/commit/c849b1395511e48ed6c8b6bd01bc0b1a66d60bfa), [`adc37ca`](https://github.com/LTplus-AG/ifc-lite/commit/adc37cac288e53be88796fddf06b0a7ae179f451), [`2affb53`](https://github.com/LTplus-AG/ifc-lite/commit/2affb534e8ed7b339dc52984789638d4ea4774bc), [`adc37ca`](https://github.com/LTplus-AG/ifc-lite/commit/adc37cac288e53be88796fddf06b0a7ae179f451), [`f19206b`](https://github.com/LTplus-AG/ifc-lite/commit/f19206b8912ba418627373e147c1699019450ebf), [`c49c7f6`](https://github.com/LTplus-AG/ifc-lite/commit/c49c7f644cd7930bd3937ed850f3864aa516934b)]:
  - @ifc-lite/bcf@1.18.2
  - @ifc-lite/collab@0.5.0
  - @ifc-lite/mutations@1.26.1
  - @ifc-lite/clash@1.9.0
  - @ifc-lite/geometry@3.8.4
  - @ifc-lite/parser@4.2.0
  - @ifc-lite/query@1.14.17
  - @ifc-lite/data@3.4.0
  - @ifc-lite/ids@1.15.48
  - @ifc-lite/create@2.1.2
  - @ifc-lite/ifcx@2.3.7
  - @ifc-lite/sdk@2.1.3
  - @ifc-lite/export@2.9.4
  - @ifc-lite/merge@0.4.3
  - @ifc-lite/viewer-core@0.2.13

## 0.11.2

### Patch Changes

- Updated dependencies [[`7f2d9cf`](https://github.com/LTplus-AG/ifc-lite/commit/7f2d9cf1fdcf8facd9bf3f1445ddf3c665206b76), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`8324512`](https://github.com/LTplus-AG/ifc-lite/commit/8324512daee39a018056aa88a148f72791db89c4), [`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f), [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599), [`307693c`](https://github.com/LTplus-AG/ifc-lite/commit/307693c678d525ab007773f74e13a308bfe63b34), [`649aa0c`](https://github.com/LTplus-AG/ifc-lite/commit/649aa0ccbc4e67c233b9175a6a2f9c8e1ff310ec), [`2d87b39`](https://github.com/LTplus-AG/ifc-lite/commit/2d87b3919c0ca5afff03e205c5f598142bbc980d), [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599), [`7cd8193`](https://github.com/LTplus-AG/ifc-lite/commit/7cd81939ed4acf9e93686d1d96dddcf7606fb59a)]:
  - @ifc-lite/clash@1.7.0
  - @ifc-lite/parser@4.1.0
  - @ifc-lite/geometry@3.8.3
  - @ifc-lite/diff@0.7.0
  - @ifc-lite/export@2.9.2
  - @ifc-lite/ids@1.15.47
  - @ifc-lite/sdk@2.1.2
  - @ifc-lite/ifcx@2.3.6
  - @ifc-lite/merge@0.4.2

## 0.11.1

### Patch Changes

- [#2389](https://github.com/LTplus-AG/ifc-lite/pull/2389) [`e20c520`](https://github.com/LTplus-AG/ifc-lite/commit/e20c520b0c898ecd3c418e338e3684d6f9f39fed) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Move `await gp.init()` inside the `try` in `export_glb`, `export_obj`, `export_ifcx`, and `export_usd`, so an `init()` rejection reaches `dispose()` instead of skipping it.

  All four handlers in `packages/mcp/src/tools/export.ts` called `await gp.init()` before the `try { ... } finally { gp.dispose(); }` block, so an `init()` rejection bypassed `dispose()` entirely. `packages/mcp/src/tools/clash.ts` already used the correct shape; all four export tools now match it.

  Scope, stated precisely: this makes the cleanup path _reachable_, which is the shape the codebase already standardises on, but on today's code the recovered `dispose()` is a no-op. `IfcLiteBridge.init()` catches its own failures and calls `reset()`, which nulls `ifcApi` without calling `free()` (`packages/geometry/src/ifc-lite-bridge.ts:229`), and `dispose()` is optional-chained on that now-null handle. So a WASM handle allocated before a late `init()` throw is still not freed after this change — the leak lives one layer down, in the bridge's own error path, and is tracked separately. This change is correct and defensive, but it should not be read as closing that leak.

- [#2328](https://github.com/LTplus-AG/ifc-lite/pull/2328) [`d27d043`](https://github.com/LTplus-AG/ifc-lite/commit/d27d043c62a0243ac95c4b25d7262e96622f3e3e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `descriptor.limit` / `descriptor.offset` in the read backend (`backend-query.ts`) silently ignoring a non-numeric, negative, or `Infinity` value instead of rejecting it. `descriptor.offset && descriptor.offset > 0` (and the equivalent for `limit`) is falsy for `NaN` — every comparison with `NaN` is false — so a caller that computed a bad value from e.g. `Number(userInput)` got back every matching row instead of an error, silently returning more than it asked for. The same falsy-zero shape made `limit: 0` ("no rows") a no-op instead, silently returning every row.

  No built-in MCP tool reaches this today: `query_entities` validates `limit`/`offset` as JSON-Schema integers before its handler runs and paginates separately via its own `paginate()` helper rather than the query builder's `.limit()/.offset()`. The live path is the public SDK surface — `HeadlessLikeBackend` is exported from both `./index.js` and `./browser.js` for embedders, and driving it through `@ifc-lite/sdk`'s fluent `QueryBuilder` (`bim.query().limit(n).offset(m).toArray()`) reaches `descriptor.limit`/`descriptor.offset` directly, unguarded by any tool schema.

  `entities()` now throws on a non-finite or negative `limit`/`offset` instead of quietly serving the wrong slice. `limit: 0` is now a deliberate empty result rather than being silently ignored — a behaviour change, not just a bugfix, and nothing in this package uses `0` as an "unlimited" sentinel.

  Same defect shape as the CLI's `headless-backend.ts` fix ([#2298](https://github.com/LTplus-AG/ifc-lite/issues/2298)); `packages/mcp` has its own parallel implementation of this adapter (not a shared import), with its own tests and release cadence, so it needed its own fix.

- [#2297](https://github.com/LTplus-AG/ifc-lite/pull/2297) [`4565cf3`](https://github.com/LTplus-AG/ifc-lite/commit/4565cf3bf8e04a289cf066a8858ded7c972c1c21) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `mutation_undo` reporting mutations as reverted while leaving the overlay untouched. It only trimmed `MutablePropertyView`'s append-only mutation-history array (documented in `@ifc-lite/mutations` as _not_ poppable for undo) and never reverted the actual property/attribute/entity overlay state, so a caller that undid an edit and then read the entity back still saw the edited value — the tool claimed success on an operation that did nothing. `mutation_undo` now applies the inverse of each reverted mutation (property set/create/delete, attribute set, entity create/delete) to the live overlay, mirroring the viewer's undo-stack dispatch.

  Also fixes `entity_set_attribute` never recording the attribute's prior value in its mutation record, so any consumer of `Mutation.oldValue` (including the undo above) restored to an empty value instead of the true original.

- [#2158](https://github.com/LTplus-AG/ifc-lite/pull/2158) [`15f3c23`](https://github.com/LTplus-AG/ifc-lite/commit/15f3c23a417d3af29a0a8302ce68173b016c6369) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `fullScope()` and `readOnlyScope()` now copy the `scopes` array as well as the
  wrapper object. The shallow spread handed every caller the same array instance
  as the exported `FULL_ACCESS` / `READ_ONLY` constants, so an in-place mutation
  (`readOnlyScope().scopes.push('mutate')`) widened the constant itself and every
  token minted afterwards in the same process carried the extra scope.

- [#2339](https://github.com/LTplus-AG/ifc-lite/pull/2339) [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8) Thanks [@louistrue](https://github.com/louistrue)! - **Breaking:** `IfcDataStore.source` is now an `IfcSourceBytes` accessor instead of a `Uint8Array` ([#2183](https://github.com/LTplus-AG/ifc-lite/issues/2183)).

  On a 342 MB model the source is 327 MB of the ~671 MB the viewer's main thread holds, and it is resident for the model's whole lifetime because property and attribute reads slice it synchronously during render. The contract "here are all the bytes, contiguous, forever" is what blocks any cheaper representation; the accessor replaces it with "ask for the range you need", which makes every whole-file consumer an explicit `materialize()` call you can see and count.

  This release is behaviour-neutral: the only implementation shipped is the contiguous one, whose `slice` is a `subarray`. STEP export is byte-identical across the default, header-fallback, `visibleOnly`, merged and merged-`visibleOnly` paths (verified against a 44,249-entity model, both new reads mutation-checked). The compressed block-backed implementation lands behind the same interface.

  **Migrating.** Most guards need no change: `byteLength`, `length` and truthiness behave exactly as they did, so the existing `!store.source?.length` shape still compiles and still means the same thing.

  - Reading a range — `store.source.slice(a, b)` and `new TextDecoder().decode(...)` become `store.source.decodeUtf8(a, b)`. `slice` still returns a view.
  - Needing the whole file — `store.source.withMaterialized(bytes => ...)` (or `withMaterializedAsync`), which scopes the buffer so it cannot outlive the call. `materialize()` exists for the cases where scoping is impractical.
  - Constructing a store — wrap with `contiguousSourceBytes(bytes)`, or `EMPTY_SOURCE_BYTES` for stores with no source (server-parsed, synthetic, GLB, point cloud). Helpers that must accept both shapes can normalise with `asSourceBytes`.
  - `parseSourceHeader` now accepts either shape and reads only the first 64 KiB, so exporters no longer materialise a whole file to read its header.
  - `fromTransport` passes an `IfcSourceBytes` argument straight through rather than re-wrapping it. Hydrating several stores from one source (the streaming parser's partial + final pair) should share one accessor, so the memoised `contentKey` is computed once.
  - `toTransferable()` no longer forces the `contentKey` hash. Describing a source for a worker is meant to be cheap; computing the key there would walk the whole file on the sending thread. It now carries the key only when something has already computed it, and `sourceBytesFromTransferable` reads a `null` key as "not computed yet" so the receiver hashes lazily to the same value.

  New exports from `@ifc-lite/parser`: `contiguousSourceBytes`, `EMPTY_SOURCE_BYTES`, `isSourceBytes`, `sourceBytesFromTransferable`, and the `IfcSourceTransfer` type. (`toTransferable` is on the public interface, so its inverse belongs in the same surface -- otherwise a consumer can produce a transfer envelope with no supported way to rehydrate one.) (`asSourceBytes` and the `IfcSourceBytes` type were already exported by the widening step above.)

  `isSourceBytes` is exported because a store built behind an `as unknown as` cast cannot be type-checked on this field, so the contract has to be assertable at runtime -- which is how a producer that kept handing over a raw `Uint8Array` was found.

- Updated dependencies [[`1843d9f`](https://github.com/LTplus-AG/ifc-lite/commit/1843d9f13a7a10183f780ae0a1df9dd225938e73), [`8b09cfd`](https://github.com/LTplus-AG/ifc-lite/commit/8b09cfdadafaea9806e79b73deb9119ea66b5aa4), [`160bf1f`](https://github.com/LTplus-AG/ifc-lite/commit/160bf1fda7ad5f2c7921b833982a53acd1ee79ad), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`29409e5`](https://github.com/LTplus-AG/ifc-lite/commit/29409e57227d3c458707dbc2cf0cb2e8ae8fcf7b), [`5dd1d18`](https://github.com/LTplus-AG/ifc-lite/commit/5dd1d181437bf0d1d357f3c5505049f802beb2cf), [`6635ddf`](https://github.com/LTplus-AG/ifc-lite/commit/6635ddfa91911b0fbc489452c02cf19e232201c3), [`6f5566f`](https://github.com/LTplus-AG/ifc-lite/commit/6f5566fa761f25a02818a750351b0b0db785ef9b), [`55f7591`](https://github.com/LTplus-AG/ifc-lite/commit/55f759154421bd002d0bdc171e82aa93b574470d), [`d260a35`](https://github.com/LTplus-AG/ifc-lite/commit/d260a35669e379e5f465861294391c95ee48cb3d), [`d75786f`](https://github.com/LTplus-AG/ifc-lite/commit/d75786f631047d234f204289426f708f0be8674b), [`51cd3ab`](https://github.com/LTplus-AG/ifc-lite/commit/51cd3ab46c7f9d40588e319e7b2c24ce66e99c29), [`79781f5`](https://github.com/LTplus-AG/ifc-lite/commit/79781f57c50bbc9641516a42d0de53e5b9d89932), [`403f448`](https://github.com/LTplus-AG/ifc-lite/commit/403f4485c21b9928f16566fa482c170f230852b0), [`58fbc63`](https://github.com/LTplus-AG/ifc-lite/commit/58fbc634994742c79375830c1983508752fd78e9), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`c866bee`](https://github.com/LTplus-AG/ifc-lite/commit/c866bee62a7d6e40b15a7de63948354cbbe049a7), [`262b9df`](https://github.com/LTplus-AG/ifc-lite/commit/262b9df485e4bfd3760f73c30d93bb518e599b72), [`2e16736`](https://github.com/LTplus-AG/ifc-lite/commit/2e167367037fa3b5d1d2d5d26dd4fb7ac169e2f5), [`710fd83`](https://github.com/LTplus-AG/ifc-lite/commit/710fd83638b51b2e4744a1ac364827a27dc0fc73), [`d9490e6`](https://github.com/LTplus-AG/ifc-lite/commit/d9490e6e2ecacb65aea42fcaef73fd292a4c3095), [`55f7591`](https://github.com/LTplus-AG/ifc-lite/commit/55f759154421bd002d0bdc171e82aa93b574470d), [`d89960a`](https://github.com/LTplus-AG/ifc-lite/commit/d89960aaab08387fbd2307c0f238bd112c684933), [`f67c622`](https://github.com/LTplus-AG/ifc-lite/commit/f67c622147ea51f2b04b93a7b7a9b485160b3e9c), [`33f11a8`](https://github.com/LTplus-AG/ifc-lite/commit/33f11a82d34b622c9d6d2c417e9fb38a7ace816e), [`8751ba4`](https://github.com/LTplus-AG/ifc-lite/commit/8751ba41dc4d1893530b0f1db6ad0f8fa0d5d3fd), [`deb54d3`](https://github.com/LTplus-AG/ifc-lite/commit/deb54d3ff75f35c3c9206c8ea9a1e875426352c6), [`51ec81b`](https://github.com/LTplus-AG/ifc-lite/commit/51ec81b125532cd0efe4f004c7ab01f4efe55cb8), [`35e37ac`](https://github.com/LTplus-AG/ifc-lite/commit/35e37ac99ab444773bfec669cfc5cf3937443942), [`dae94e2`](https://github.com/LTplus-AG/ifc-lite/commit/dae94e23f7514945ca60f7074f50f196a90dfc5d), [`8d1972d`](https://github.com/LTplus-AG/ifc-lite/commit/8d1972d059fe5e8725fffbf661cc56bb6a23767b), [`6d52ca3`](https://github.com/LTplus-AG/ifc-lite/commit/6d52ca369fa7cece428a15bedd69ae1d933b888f), [`958aef1`](https://github.com/LTplus-AG/ifc-lite/commit/958aef125743682da75c3da7b41991abd9d36d32), [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8), [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da), [`72bf949`](https://github.com/LTplus-AG/ifc-lite/commit/72bf949bd3a58dfb460c2c445e546d930a248e02), [`512406f`](https://github.com/LTplus-AG/ifc-lite/commit/512406f0d21c7e33b8c84a83865ffaff299e7cc1), [`5d763d6`](https://github.com/LTplus-AG/ifc-lite/commit/5d763d6bde10c0232cbf28e7d8e4e956ebaf4ff1)]:
  - @ifc-lite/bcf@1.17.0
  - @ifc-lite/viewer-core@0.2.12
  - @ifc-lite/collab@0.4.2
  - @ifc-lite/create@2.0.2
  - @ifc-lite/merge@0.4.1
  - @ifc-lite/export@2.8.3
  - @ifc-lite/query@1.14.16
  - @ifc-lite/data@3.2.2
  - @ifc-lite/ids@1.15.42
  - @ifc-lite/ifcx@2.3.4
  - @ifc-lite/parser@4.0.0
  - @ifc-lite/mutations@1.24.2
  - @ifc-lite/geometry@3.7.1
  - @ifc-lite/clash@1.6.5
  - @ifc-lite/sdk@2.0.3

## 0.11.0

### Minor Changes

- [#2052](https://github.com/LTplus-AG/ifc-lite/pull/2052) [`d44b6c1`](https://github.com/LTplus-AG/ifc-lite/commit/d44b6c1710ee86596e96e0204785d2bf7c0940a9) Thanks [@louistrue](https://github.com/louistrue)! - Add OpenUSD ASCII (`.usda`) export — a real Z-up USD stage, distinct from the existing IFCX (USD-flavored JSON) export.

  The stage mirrors the IFC spatial hierarchy as `Xform` prims with `UsdGeomMesh` geometry, `UsdPreviewSurface` materials, and IFC metadata (`ifc:class`, `ifc:GlobalId`, property/quantity sets) as custom attributes; it opens in usdview / Blender / Omniverse. Geometry outside the spatial tree (opening elements, type-product meshes) is placed under a synthetic `Unassigned` prim rather than dropped, and each mesh carries its placement as a `double3 xformOp:translate` so georeferenced models keep full precision.

  - `@ifc-lite/geometry`: `GeometryProcessor.exportUsd(bytes)` (and `IfcLiteBridge.exportUsd`) returning the `.usda` bytes.
  - `@ifc-lite/cli`: `ifc-lite export --format usd` (whole-model; entity filters do not apply).
  - `@ifc-lite/mcp`: the `export_usd` tool.

### Patch Changes

- [#2125](https://github.com/LTplus-AG/ifc-lite/pull/2125) [`07c0b4c`](https://github.com/LTplus-AG/ifc-lite/commit/07c0b4cc5a0b5617ed6ad300639e5c52ce225d44) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `ViewerManager` now warns once per session when an SSE frame from the viewer fails to parse as JSON, or when GlobalId enrichment fails for a picked selection ([#2100](https://github.com/LTplus-AG/ifc-lite/issues/2100) follow-up). Both paths still degrade the same way as before — a bad frame is dropped, a selection without a GlobalId is still reported — but they no longer swallow the failure with no diagnostic at all. Both triggers are viewer-client controlled and can repeat at high frequency (once per frame, once per pick), so the warning is a once-per-session latch rather than a per-occurrence log, reset the next time `open()` starts a session.

- Updated dependencies [[`2c47277`](https://github.com/LTplus-AG/ifc-lite/commit/2c47277ee6dfbd9779eb4948d1f2e7b0ea61d00e), [`5371d7d`](https://github.com/LTplus-AG/ifc-lite/commit/5371d7def2671f6568c838879b8be058bb6247c9), [`bdeb80d`](https://github.com/LTplus-AG/ifc-lite/commit/bdeb80d79443d89027a4d96879116e99dcc989a4), [`b3742d9`](https://github.com/LTplus-AG/ifc-lite/commit/b3742d9d29c3adfcbf67f573c62194547d7d172d), [`803005f`](https://github.com/LTplus-AG/ifc-lite/commit/803005f1c8d976350111c2f52a6b41b584393ca6), [`4c739be`](https://github.com/LTplus-AG/ifc-lite/commit/4c739be2aba74ad6868b6dca51dad441c6fa9903), [`f493930`](https://github.com/LTplus-AG/ifc-lite/commit/f4939309aed136979bd5cc1f95a25c2a0ebe779f), [`befc108`](https://github.com/LTplus-AG/ifc-lite/commit/befc1083e377315231006352cb3fe95949e92b47), [`6722e08`](https://github.com/LTplus-AG/ifc-lite/commit/6722e08b76c4cd89d8e7e1bbd06c768a36ae93ac), [`6cbf69a`](https://github.com/LTplus-AG/ifc-lite/commit/6cbf69acb2163ab671c41df36878f4d4e490e244), [`0ceb99a`](https://github.com/LTplus-AG/ifc-lite/commit/0ceb99a36125a2dfc8775e762d9f4f9ddb69d733), [`3c2ffa6`](https://github.com/LTplus-AG/ifc-lite/commit/3c2ffa6a1bd0a04d3d73e2ea7c0fb1a2233599a9), [`d44b6c1`](https://github.com/LTplus-AG/ifc-lite/commit/d44b6c1710ee86596e96e0204785d2bf7c0940a9)]:
  - @ifc-lite/geometry@3.7.0
  - @ifc-lite/export@2.8.2
  - @ifc-lite/mutations@1.24.1
  - @ifc-lite/data@3.2.1
  - @ifc-lite/create@2.0.1
  - @ifc-lite/extensions@0.4.1
  - @ifc-lite/sdk@2.0.2
  - @ifc-lite/parser@3.15.1
  - @ifc-lite/ifcx@2.3.3
  - @ifc-lite/ids@1.15.41

## 0.10.0

### Minor Changes

- [#2036](https://github.com/LTplus-AG/ifc-lite/pull/2036) [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab) Thanks [@louistrue](https://github.com/louistrue)! - `export_ifc`'s `global_ids` allowlist reaches entities the session created, and fails closed when it matches nothing ([#2012](https://github.com/LTplus-AG/ifc-lite/issues/2012)).

  Two problems, and the second was the worse one. A mixed allowlist naming both a created and a parsed entity exported only the parsed one, because the exporter's visible-only closure could not see an overlay-created id — fixed in `@ifc-lite/export`. And an allowlist that matched **nothing** produced an empty ref set, which the export adapter reads as "no filter": asking to export one created entity wrote the entire model to disk and reported success. That now raises `ENTITY_NOT_FOUND` instead. Ids that match nothing while others do are reported in `unmatchedGlobalIds`, and the matched ones still export.

  `foldedEntityCount` also stopped double-subtracting: with created-then-deleted entities now tombstoned, only tombstones that name a store entity are deducted.

- [#2000](https://github.com/LTplus-AG/ifc-lite/pull/2000) [`084c32c`](https://github.com/LTplus-AG/ifc-lite/commit/084c32c26c82dedb32ef62d38fc60c4965c741e1) Thanks [@louistrue](https://github.com/louistrue)! - `model_diff` gains `by_content`, putting the MCP surface on the real `@ifc-lite/diff` engine ([#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)).

  Until now `model_diff` was a GlobalId set intersection: it built two sets of `node.globalId` and diffed them. It predates `@ifc-lite/diff` and never imported it, so a model re-exported from scratch read as **the entire model deleted and added** — on the surface least able to notice a wrong answer, and most likely to act on it unsupervised. On the bundled FZK-Haus fixture and its re-GUIDed re-export, that pass reports 1304 added and 1304 removed; the engine reports 117 renamed, 4 ambiguous groups, and 29 entities genuinely unresolved.

  `by_content: true` runs the engine's content-keyed matching pass and adds a `contentDiff` to the result: `scope`, the `added`/`modified`/`deleted`/`unchanged` `counts`, whole per-kind totals in `contentMatchCounts`, and the matches themselves. `duplicated`, `deduplicated` and `ambiguous` matches list every candidate on each side rather than being flattened to a number — silently collapsing "we could not tell" into a count is the one failure an unsupervised agent cannot recover from. Two caps bound the payload and neither can hide anything: `max_matches` (default 200) caps how many matches are listed, with unresolved kinds listed first and `truncatedMatches` reporting what was left out; `max_group_members` (default 20) caps how many GlobalIds each _side of one match_ lists, because a single ambiguous group in a repetitive model can hold thousands and would otherwise overflow the very context window the first cap protects. Every group reports `baseCount` / `headCount` and `baseTruncated` / `headTruncated`, computed before either cap.

  **`model_diff` now answers about the session, not about the file as parsed.** A `model_id` names a loaded session, and `entity_set_property` / `entity_set_attribute` / `entity_create` / `entity_delete` queue their edits in a mutation overlay the parsed store never sees. All three passes — per-type counts, `entityDiff`, and the new `contentDiff` — read straight through it now: tombstoned entities leave, created ones join, and edited names, descriptions, object types and property values are hashed at their new values. A created entity is read through the overlay like any other, so create-then-rename — an ordinary two-step for an agent — is hashed at the name the session ended up with, not at the one the `entity_create` payload carried. `contentDiff.pendingMutations` reports how many queued edits are in play per side (absent when there are none) and the text summary says so too. Before this, an agent that had just edited a model and asked what changed was told nothing had — created entities were missing, deleted ones were still reported as present and unchanged, and edited ones kept their old hashes. The rest of the read surface (`entity_get`, `entity_query`, …) still answers from the parsed store; `model_diff` is the tool where a pre-edit answer is not recoverable.

  **Fixes a data-loss bug in `export_ifc` / `model_save` on the way.** The MCP mutation overlay had no base to merge against — the columnar parser leaves `store.properties` empty and serves properties on demand — so `MutablePropertyView.getForEntity` answered with the edited property set and nothing else. `StepExporter` re-emits exactly that set and skips the original records, so editing one property in a pset dropped every sibling property in it on save. The overlay is now wired to the parser's on-demand extractors, as the viewer's already is.

  Deliberate limits, all reported rather than assumed:

  - **Opt-in, default off.** An `ambiguous` group has no honest scalar form, so enabling this by default would change what `counts` means for agent scripts that already call the tool. What `typeDiffs` and `entityDiff` measure is unchanged; they are only read through the mutation overlay now, as above.
  - **Data scope.** Node has no geometry pipeline here, so there is no world geometry hash and no bounding box; the handler passes `scope: 'data'` and echoes it back. Every unambiguous 1:1 match therefore reports as `renamed`, and `moved`/`reshaped` are not available.
  - **`components` is supplied**, so the engine's collision guard against a `dataHash` collision retiring an unrelated add/delete pair is live rather than inert.

  The comparison covers every `IfcObjectDefinition`, decided from the inheritance chain of every bundled schema (IFC2X3 + IFC4 + IFC4X3) rather than from whether the columnar parser's `EntityTable` happened to hold the entity — the same chain-checked extraction the CLI's `diff` uses. That is what lets `IfcTask`, `IfcActor` and other non-product objects participate at all (the table answers an empty GlobalId for them), and what keeps `IfcMaterial` and friends out, whose Name sits in the table's GlobalId column and would otherwise enter the comparison as a colliding key.

  Reading the chain from the parser's IFC4 codegen pin instead would get an IFC2X3 file wrong in both directions at once, so it does not: the pin carries no chain for the 23 IFC2X3 and 77 IFC4X3 `IfcObjectDefinition` classes outside it, which silently drops every one the `EntityTable` does not hold (`IfcMove`, `IfcSpaceProgram`, `IfcScheduleTimeControl`, …) while leaving an IFC2X3-only _resource_ class the table does hold — an `IfcSymbolStyle`, taken in because its name ends in `STYLE` — keyed on the Name in slot 0. For all 776 classes the pin does carry, both lookups agree on every verdict and on the leaf name, so no IFC4 model changes behaviour.

- [#2014](https://github.com/LTplus-AG/ifc-lite/pull/2014) [`678e90d`](https://github.com/LTplus-AG/ifc-lite/commit/678e90d93e97d2b9ec3c8de9f2713e83361cab18) Thanks [@louistrue](https://github.com/louistrue)! - **read surface**: `get_entity`, `query_entities`, `model_info` and the rest of the read tools now answer about the model as the _session_ has it, not as the file was parsed (the MCP read-after-write half of issue [#2004](https://github.com/LTplus-AG/ifc-lite/issues/2004); the playground viewer's staleness is a separate surface and that issue stays open for it).

  `MutablePropertyView` is an overlay: the parsed store's buffer and index are never touched, and the queued edits only materialise in `StepExporter` at `export_ifc` / `model_save`. Every read went straight to the store, so an agent that edited and then read back to confirm was told its edit had not happened — and the natural recovery from that is to edit again. `model_diff` was fixed in [#2000](https://github.com/LTplus-AG/ifc-lite/issues/2000); this is the rest of the surface.

  What changed, in the order an agent hits it:

  - `get_entity` / `get_entities_bulk` return the attribute and property values that were just written, resolve a created entity by the GlobalId it was given, and report a deleted one as not found instead of as present. A created entity's `attributes` are the authored positional list named from the schema, so it reads as a real entity rather than an empty one.
  - `query_entities` includes created entities, excludes deleted ones, and — the part that made folding rather than reporting the only workable answer — **matches its property filters against written values**. A query for the value an agent just wrote has to find it; a tool that merely reported "1 mutation pending" next to an empty row set would not have fixed anything.
  - `count_entities` and `model_info` count creations in and deletions out. A created `IfcWall` lands on the existing `IFCWALL` row rather than opening a second one.
  - `properties_unique` and everything else routed through `bim.*` folds too, because the fold lives in the query backend rather than in each tool.
  - `entity_set_property` / `entity_set_attribute` / `entity_delete` also resolve `global_id` against queued entities, so a `mutation_batch` can create an entity in one step and address it by GlobalId in the next.

  **Every folding payload gains `pendingMutations`** — the same number `mutation_diff` reports — and the field is _absent_, not zero, on a session with no queued edits, so a read-only caller's response shape is untouched. Folding answers "what is there now"; the field is what still separates that from "what is on disk", and nothing is written until `export_ifc` or `model_save`.

  Containment folds through the same seam. `bim.storey`, `bim.path`, `bim.contains` and `bim.decomposes` are all thin wrappers over the backend's `related()`, so folding there fixed `in_storey`, `count_entities(group_by: 'storey')`, `containment_chain` and `spatial_hierarchy` at once: a queued `IfcRelContainedInSpatialStructure` places its `RelatedElements` inside its `RelatingStructure`, a deleted relationship record stops relating its two ends (the graph carries a `relationshipId` per edge, so that is exact), and a deleted spatial entity stops containing anything. The tools that were broken were exactly the ones bypassing `bim.*` with a raw `EntityNode` on the parsed store; they no longer do.

  `model_audit` folds too — it is the tool an agent is most likely to trust, and scoring a model clean on identity while a queued `entity_create` has just duplicated a GlobalId is a pass that was never earned. Its structure, identity and naming rules all read the session.

  The MCP resources (`ifc-lite://model/{id}/manifest`, `…/entity/{globalId}`, `…/spatial-tree`) fold as well. The entity resource used to read its header off the parsed store and fill the rest from `bim.*`, so one payload reported a stale name beside freshly-written properties.

  **Deliberately not folded, and they never carry `pendingMutations` so you can tell:** `relationships` (voids, fills, groups and connections come from a parser-side extractor with no overlay seam, unlike containment), `units` and `georeferencing` (header data no mutation tool writes), and the geometry, clash and viewer tools (parsed geometry, which queued edits do not regenerate).

  `get_entities_bulk` keys its result map by GlobalId, and used to let whichever row it visited last win — the parsed store's. That contradicted `get_entity`, which prefers the entity the session created, so reading one entity and reading a hundred disagreed about the same entity after a duplicate. Both now go through one documented precedence (queued first, tombstoned never), stated once beside `findByGlobalId` and pinned by a test that fails if the two implementations drift. A GlobalId that names more than one live entity is reported in a new `ambiguousGlobalIds` array — `globalId`, every `expressIds` seen, and which one was `returned` — rather than silently resolved; the field is absent when there is no ambiguity.

  Review follow-ups in the same area, several pre-existing:

  - **Created entities are only read positionally when they are `IfcRoot` subtypes.** `entity_create` accepts any IFC class, and slots 0/2/3 are `GlobalId`/`Name`/`Description` only for a root. `entity_create('IfcPropertySingleValue', ["'Width'", …])` therefore produced an entity whose GlobalId was `Width`, which then joined the cross-model identity list: `get_entity(global_id: 'Width')` resolved to a property value and `model_diff` reported `Width` as an added entity. The header is now read only when the class derives from `IfcRoot`, resolved cross-schema.
  - **The spatial tree is one walk.** `spatial_hierarchy` and the `…/spatial-tree` resource had two, which disagreed about which `IfcProject` to hang from and about whether contained elements are children. Neither carried a visited set, so a cyclic aggregation recursed until the stack gave out — a malformed file could hang the server. Children now come from aggregation only (contained elements are reported in `elements`, once), and the walk is cycle-safe.
  - **A deleted entity answers nothing about itself.** `related`, `attributes`, `properties` and `quantities` filtered the far end of a relationship but never checked whether the _queried_ entity was tombstoned.
  - **`model_audit`'s naming score uses a product denominator.** It counted every type that was not a relationship or a property set, so `IfcCartesianPoint`, `IfcLocalPlacement` and every other geometry primitive were scored for having no Name. `dataQuality` measured how much geometry a file had rather than how well its products were named; it now uses the same "is a product" rule an untyped `query_entities` does, and reads names off the store's fast path instead of reparsing every entity.
  - **`schema_describe` resolves a class's parent in the schema that declares the class.** Subtracting the merged union's parent attribute count for `include_inherited: false` cut one attribute too many from 67 bundled classes — `IfcScheduleTimeControl` lost `ActualStart`, because IFC4 added `Identification` to `IfcControl`.
  - **Type names are IfcPascalCase** in `model_info.typeCountsTop20` and `count_entities(group_by: 'type')`, matching `model_diff.typeDiffs`; `count_entities` also honours `type` on that branch (previously ignored) and expands subtypes.
  - **`pendingMutations` is a number at every level.** `model_diff.contentDiff` published a `{ base, head }` object under the same name; the split moved to `contentDiff.pendingMutationsBySide`.
  - `bim.attributes` no longer invents `Attribute7`-style names for a created entity whose payload runs past what the schema declares.
  - The overlay is rebuilt per read — there is no revision counter to cache against, and a stale overlay is a correctness bug where a rebuild is not — so the rebuild was made cheap instead: nothing is derived in the constructor and the per-entity lookup goes straight to the view's id map. A 1,000-id `get_entities_bulk` against a 20k-entity model with 2,000 queued creates went from ~1,960ms to ~7ms (median of five).

- [#2014](https://github.com/LTplus-AG/ifc-lite/pull/2014) [`678e90d`](https://github.com/LTplus-AG/ifc-lite/commit/678e90d93e97d2b9ec3c8de9f2713e83361cab18) Thanks [@louistrue](https://github.com/louistrue)! - **model_audit / schema_describe**: both now read the IFC schema across every bundled version instead of the IFC4_ADD2_TC1 codegen pin alone (issue [#2003](https://github.com/LTplus-AG/ifc-lite/issues/2003)).

  `model_audit`'s GlobalId-uniqueness check skips any type whose inheritance chain does not reach `IfcRoot`, and the pinned lookup answers an **empty** chain for any class it has no row for: 39 IFC2X3 classes (`IfcScheduleTimeControl`, `IfcSpaceProgram`, `IfcServiceLife`, `IfcMove`, …), 80 IFC4X3 ones (`IfcCourse`, `IfcBorehole`, …) and 4 post-ADD2 IFC4 ones. The audit skipped every one of them and still scored the file on identity, so an agent was told a file was clean on a rule that had not run. It now checks them, and `duplicate-globalid` can fire on files where it previously stayed silent.

  `schema_describe` rejected those same classes with `INVALID_INPUT: Unknown IFC entity type` — for a class an agent may have just found with `query_entities` on the file it is holding. It now answers from the bundled schema union when the pin has no row, and the payload gains a `schemaSource` field: `IFC4_ADD2_TC1` when the pinned registry answered (attributes carry their EXPRESS type as before) or `bundled-schema-union` when it did not (attribute _names_ in positional order, no types — the union does not carry them, and inventing them would be worse than saying so).

  For every class the pin does carry, `schema_describe`'s answer is unchanged, `inheritanceChain` included. That is deliberate rather than incidental: the two lookups disagree on chain _content_ for 62 pinned classes because the union lets IFC4X3 win a name collision (`IfcBeam`'s supertype is `IfcBuildingElement` in IFC4 and `IfcBuiltElement` in IFC4X3, and IFC4X3 inserts `IfcFacility` above `IfcBuilding`), so the pin stays primary and the union only fills the gap. They also return their chains in opposite order — the pinned one root→leaf, the union one leaf→root, differing at `chain[0]` on 717 of the 776 — so the chain is normalised by finding the leaf by name, never by index.

- [#2033](https://github.com/LTplus-AG/ifc-lite/pull/2033) [`2716893`](https://github.com/LTplus-AG/ifc-lite/commit/2716893ac9d825fc529f3fd8164d9a6f766e87f8) Thanks [@louistrue](https://github.com/louistrue)! - **diff**: `buildDataFingerprint` and `buildComponentFingerprints` now hash a new optional `DataFingerprintInput.tag`, and it belongs to **type objects only**. A type object carries no geometry hash, so its data fingerprint is the whole of the evidence a content match has about it — and same-named types are ordinary: the Duplex sample has eight `IfcFurnitureType` entities all named `800 mm`, identical in every other hashed attribute and separable only by `Tag`. They shared one content bucket and `matchUnpairedByContent` correctly abstained on all eight. Measured on the content-matching fixture (`scripts/xmatch`), recall on geometry-less objects went from 0.468 to 1 on Duplex, 0.680 to 0.880 on AC20-FZK-Haus and 0.718 to 0.768 on a Revit export, with precision staying at 1.000 and zero false pairs throughout.

  Supply `tag` for an `IfcTypeObject` subtype and **not** for an occurrence — that is what the CLI, MCP and viewer adapters do, deciding it from the cross-schema inheritance chain. `IfcElement.Tag` is the authoring tool's own element id (Revit writes its `ElementId`), so two tools exporting one design disagree on it for every element; since `dataHash` is the content bucket key, hashing it on occurrences would break exactly the re-export matching this pass exists for. Re-tagging a type does not move the fingerprint of any element assigned to it: type assignments still project the assigned type's name and IFC class only.

  **Every cached fingerprint is invalidated.** `buildDataFingerprint` and `buildComponentFingerprints` (its `attr:core` sub-hash) return different strings for the same input than they did before, whether or not you supply a `tag` — the projection now always carries a `Tag` field. Nothing in this repo persists these values, and base and head are always fingerprinted by the same build, so a normal diff, merge or compare is unaffected. Any caller that has stored fingerprints across sessions must recompute them; comparing a pre-upgrade hash with a post-upgrade one reports everything as changed. Stored identity-map sidecars are not affected: they carry GlobalId aliases and model digests, no fingerprint values.

  **cli**: `ifc-lite diff --by-content` now tells two same-named type objects apart when they differ only in `Tag`, so a re-export whose furniture, door and window _types_ share a name no longer reports them as an unresolved ambiguous group. On the Duplex sample the command abstained on 25 of 47 geometry-less objects and now pairs all 47. Two consequences to expect: pairs you previously had to resolve by hand are now reported as `renamed`, and a type object whose `Tag` genuinely changed between the two files now reports as added and deleted rather than matched, because its content really did change. An ordinary element's `Tag` is still not compared, so nothing about occurrence matching moves. Fingerprints from this version do not compare against fingerprints from an older one; replaying an existing identity-map sidecar is unaffected, since a sidecar stores GlobalIds rather than hashes.

  The lookup also spans every bundled schema, so `Tag` is now found on IFC4X3-only type objects (`IfcRailType`, `IfcTrackElementType`, `IfcSignalType`, …). Routed through the IFC4 codegen pin it silently found nothing on those classes, which meant infrastructure models got none of the benefit above while IFC2X3 and IFC4 models got all of it.

  **mcp**: the same change to `model_diff` with `by_content: true`, from the same adapter — same-named type objects are separated by `Tag`, so an agent gets `renamed` pairs where it used to get an ambiguous group it could not act on, including on IFC4X3 infrastructure classes. `entity_set_attribute` on `Tag` now moves the fingerprint of a queued-edit **type object** (and only a type object), so `model_diff` reflects that edit instead of ignoring it. Hash values differ from previous versions, so anything an agent stored and compares across an upgrade must be recomputed.

- [#1979](https://github.com/LTplus-AG/ifc-lite/pull/1979) [`8f139a8`](https://github.com/LTplus-AG/ifc-lite/commit/8f139a8ef44235b68c2f97c032419fa586111b62) Thanks [@louistrue](https://github.com/louistrue)! - **BREAKING:** every `IfcCreator` element constructor now places its product relative to the storey it is added to. Element coordinates are storey-relative across the whole API.

  ## What was wrong

  `IfcCreator` chained the product's `IfcLocalPlacement` to a different parent depending on which method you called. Seven methods — `addIfcWall`, `addIfcSlab`, `addIfcColumn`, `addIfcBeam`, `addIfcStair`, `addIfcRoof`, `addIfcGableRoof` — chained to the storey placement, which carries `[0, 0, Elevation]`. The other 21 — `addIfcDoor`, `addIfcWindow`, `addIfcRamp`, `addIfcRailing`, `addIfcPlate`, `addIfcMember`, `addIfcFooting`, `addIfcPile`, `addIfcSpace`, `addIfcCurtainWall`, `addIfcFurnishingElement`, `addIfcBuildingElementProxy`, `addIfcCircularColumn`, `addIfcIShapeBeam`, `addIfcLShapeMember`, `addIfcTShapeMember`, `addIfcUShapeMember`, `addIfcHollowCircularColumn`, `addIfcRectangleHollowBeam`, `addElement`, `addAxisElement` — chained to the world.

  On a storey with a non-zero `Elevation`, a caller mixing the two families got two datums in one model, with no error and nothing downstream to notice. Measured on a real scan-to-IFC run: the storey and its spaces at −1.368653 m, the walls at −2.737307 m — exactly 2 × the elevation, standing 1.37 m below the spaces they bounded.

  Every one of these methods already took the storey as its first argument and already emitted an `IfcRelContainedInSpatialStructure` into it. Only the placement disagreed.

  ## Why storey-relative, and not world-relative

  The placement hierarchy has to agree with the containment hierarchy. A product contained in a storey whose placement chains past that storey to the world is not a coherent IFC product: moving the storey leaves its own contents behind, and `IfcBuildingStorey.Elevation` and the storey's `ObjectPlacement` become decoration that no geometry honours. The world-relative alternative would have meant deleting the storey's `[0, 0, Elevation]` placement or leaving it as a transform nothing chains to — the wrong half of the schema to surrender.

  It is also what the rest of this package already did: the `*ToStore` builders (`addWallToStore`, `addSpaceToStore`, `addDoorToStore`, …) have always chained from `anchor.storeyPlacementId`. Choosing world would have split `@ifc-lite/create` against itself.

  ## Migrating

  If your storeys all have `Elevation: 0`, nothing moves — the storey placement is the identity and the two parents were already the same point.

  Otherwise, for the 21 methods listed above: **stop adding the storey elevation to element coordinates.** Pass the height above that storey's floor.

  ```ts
  const storey = creator.addIfcBuildingStorey({
    Name: "Level 1",
    Elevation: 3.2,
  });

  // before — absolute Z, because addIfcSpace ignored the storey
  creator.addIfcSpace(storey, {
    Position: [0, 0, 3.2],
    Width: 4,
    Depth: 4,
    Height: 2.6,
  });

  // after — storey-relative Z, like addIfcWall always was
  creator.addIfcSpace(storey, {
    Position: [0, 0, 0],
    Width: 4,
    Depth: 4,
    Height: 2.6,
  });
  ```

  If you compensated for the asymmetry — passing absolute Z to the world-parented methods and storey-relative Z to the storey-parented ones, so the two families lined up — remove the compensation from the world-parented calls only. The storey-parented calls were already correct and must not change. A caller that had settled on `Z = 0` for walls and `Z = elevation` for spaces now passes `Z = 0` to both.

  `addIfcWallDoor` and `addIfcWallWindow` are unaffected: they were and remain wall-local, and inherit the storey datum through their host.

  Also in this release: `getStoreyPlacement` throws `Unknown storeyId #N` instead of silently falling back to the world placement. This is a strictly earlier version of the error `trackElement` already threw a few lines later, so no working call changes — it just means a bogus storey id no longer emits orphan placement entities before failing.

  ## `@ifc-lite/sandbox`

  The `llmSemantics.placement` metadata in `NAMESPACE_SCHEMAS` is corrected to match: the seven methods previously tagged `'world'` (`addIfcMember`, `addIfcPlate`, `addIfcCurtainWall`, `addIfcRailing`, `addIfcDoor`, `addIfcWindow`, `addAxisElement`) are now `'storey-relative'`, and the `useWhen`/`cautions` prose that described them as world-placement is rewritten. The `MethodPlacementKind` union is unchanged and no export was added or removed. Consumers that read `placement` to generate guidance will see different values for those seven methods — which is the point: the old values now describe behaviour that no longer exists.

  Thirteen constructors that carried no `llmSemantics` at all — `addIfcRamp`, `addIfcFooting`, `addIfcPile`, `addIfcSpace`, `addIfcFurnishingElement`, `addIfcBuildingElementProxy`, `addIfcCircularColumn`, `addIfcHollowCircularColumn`, `addIfcIShapeBeam`, `addIfcLShapeMember`, `addIfcTShapeMember`, `addIfcUShapeMember`, `addIfcRectangleHollowBeam` — now declare `placement: 'storey-relative'` with their coordinate keys. They were invisible to every consumer that groups methods by placement frame, so nothing generated from this schema said which datum their coordinates were in. `NAMESPACE_SCHEMAS.create` now tags all 30 coordinate-taking constructors (27 storey-relative, `addElement` explicit-placement, and the two wall-local hosted inserts).

  ## Downstream packages carrying the break

  The behaviour change is not confined to `@ifc-lite/create`: four packages re-expose `IfcCreator` and therefore ship it to their own consumers. Each is versioned to say so, rather than letting a caller pick the change up through a range they believed was compatible.

  - **`@ifc-lite/sdk` (major)** — re-exports the class directly (`packages/sdk/src/index.ts`: `export { IfcCreator } from '@ifc-lite/create'`). Without a major, a consumer on `^1.21` accepts the release and gets storey-relative placement with no signal.
  - **`@ifc-lite/sandbox` (major, was minor)** — `buildCreateMethods()` auto-discovers `IfcCreator.prototype` and dispatches to it, so every affected constructor is reachable from sandbox scripts. A script passing absolute coordinates against a non-zero-elevation storey now emits geometry one elevation off. That is breaking for the script author even though the sandbox's own surface is unchanged.
  - **`@ifc-lite/cli` (minor)** — `create` constructs `IfcCreator` and passes `--elevation` straight through, so the same shift reaches CLI users following the previous absolute-coordinate convention. Minor rather than major because the package is pre-1.0, where the house rule maps a breaking change to a minor bump.
  - **`@ifc-lite/mcp` (minor)** — exposure is indirect but real: `loadIfcModel()` (`src/index.ts`) returns a `LoadedModel` carrying `bim: BimContext` (`src/loader.ts`), whose `create` namespace constructs the class (`@ifc-lite/sdk` `namespaces/create.ts`: `project()` returns `new IfcCreator(params)`, `building()` takes a `StoreyElevation`). A library consumer calling `model.bim.create.building({ StoreyElevation })` gets the new datum. Minor for the same pre-1.0 reason as the CLI.

  `@ifc-lite/wasm` is unaffected — it neither constructs nor re-exports `IfcCreator`, directly or through a namespace. The viewer apps are private and unpublished.

### Patch Changes

- [#2024](https://github.com/LTplus-AG/ifc-lite/pull/2024) [`63905dc`](https://github.com/LTplus-AG/ifc-lite/commit/63905dc3993ad227500a0f68c406276c909eb6f5) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fixed the remaining `GeometryProcessor` WASM handle leaks tracked in issue [#1959](https://github.com/LTplus-AG/ifc-lite/issues/1959), beyond the viewer P0 sites fixed separately. Each site now frees its handle in a `try/finally` covering every early-return and throw path, not just the happy path:

  - `@ifc-lite/mcp`: `clash_check` / `clash_matrix`'s model meshing (long-lived MCP server process, one handle per never-before-clashed model).
  - `@ifc-lite/export`: `generateLod1`'s primary and fallback processors, including the forced-meshing-failure fallback path.
  - `@ifc-lite/cli`: `diagnose-geometry`, `extract-entities --detect`, and `gym`'s lazily-created clash-channel processor — all reachable more than once per process from a long-lived host (a test harness, a REPL session) even though each is a one-shot CLI command in normal use.
  - `create-ifc-lite`: the generated React + WebGPU template's mount effect now disposes its `GeometryProcessor` on both the mid-init cancellation path and on unmount, so scaffolded projects don't inherit the leak.

  `apps/viewer/src/hooks/useIfcLoader.ts` is intentionally untouched: its processor's WASM handle is shared with `IfcParser.parseColumnar` via `getApi()`, and disposal there needs a design decision (owned-and-reused vs. freed-per-call) that has not been made yet.

- Updated dependencies [[`d42fbf1`](https://github.com/LTplus-AG/ifc-lite/commit/d42fbf1c7a4abed637b7e80e28cbed69088bc943), [`e651699`](https://github.com/LTplus-AG/ifc-lite/commit/e651699180b791b95cbd721ad66d5f38e03eca2b), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`63905dc`](https://github.com/LTplus-AG/ifc-lite/commit/63905dc3993ad227500a0f68c406276c909eb6f5), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`263c3ef`](https://github.com/LTplus-AG/ifc-lite/commit/263c3efba5baf503f192700ba7f70ce08a1dafc8), [`a2ca053`](https://github.com/LTplus-AG/ifc-lite/commit/a2ca0535c14cd1bf9d55713584766dff55430158), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841), [`dc000cf`](https://github.com/LTplus-AG/ifc-lite/commit/dc000cff25a647d2a224f34a063f84b3d2d84ca8), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`2716893`](https://github.com/LTplus-AG/ifc-lite/commit/2716893ac9d825fc529f3fd8164d9a6f766e87f8), [`620f4d2`](https://github.com/LTplus-AG/ifc-lite/commit/620f4d2100b397d33d2e61440950b7a31660dbb8), [`7261f1a`](https://github.com/LTplus-AG/ifc-lite/commit/7261f1a6a8595350d3ec400212e293a8924d57bf), [`8f139a8`](https://github.com/LTplus-AG/ifc-lite/commit/8f139a8ef44235b68c2f97c032419fa586111b62), [`ed63063`](https://github.com/LTplus-AG/ifc-lite/commit/ed63063c952bd1804ce83922da80635f03c77193)]:
  - @ifc-lite/diff@0.6.0
  - @ifc-lite/export@2.8.0
  - @ifc-lite/geometry@3.6.0
  - @ifc-lite/parser@3.13.0
  - @ifc-lite/data@3.2.0
  - @ifc-lite/mutations@1.23.0
  - @ifc-lite/sdk@2.0.0
  - @ifc-lite/create@2.0.0
  - @ifc-lite/merge@0.4.0
  - @ifc-lite/ids@1.15.38
  - @ifc-lite/viewer-core@0.2.11

## 0.9.2

### Patch Changes

- Updated dependencies [[`0cfb88b`](https://github.com/LTplus-AG/ifc-lite/commit/0cfb88b3ac3e5615c7e125c5076ea75cf2039a09), [`382fa7c`](https://github.com/LTplus-AG/ifc-lite/commit/382fa7cf97c04bad07963e25052cbaeb6c2ba7e3), [`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7), [`87f3507`](https://github.com/LTplus-AG/ifc-lite/commit/87f3507f6fb67a3fd834a190737ea33d7e9ad661), [`6842c56`](https://github.com/LTplus-AG/ifc-lite/commit/6842c56c72065fd9f43ac282cacb766b7808c282), [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14), [`8799484`](https://github.com/LTplus-AG/ifc-lite/commit/87994844a5edb66404fa12b0719c89f5ec026c4d), [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc), [`87f3507`](https://github.com/LTplus-AG/ifc-lite/commit/87f3507f6fb67a3fd834a190737ea33d7e9ad661), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`428c5ae`](https://github.com/LTplus-AG/ifc-lite/commit/428c5ae54bac236a3950f451ee12a0dc23226336), [`3dc3eb5`](https://github.com/LTplus-AG/ifc-lite/commit/3dc3eb56bd372ddd0e317347db1cad888dffd609)]:
  - @ifc-lite/clash@1.6.4
  - @ifc-lite/create@1.17.0
  - @ifc-lite/data@3.0.0
  - @ifc-lite/parser@3.11.0
  - @ifc-lite/export@2.7.0
  - @ifc-lite/mutations@1.21.1
  - @ifc-lite/ifcx@2.3.2
  - @ifc-lite/geometry@3.5.0
  - @ifc-lite/collab@0.4.1
  - @ifc-lite/ids@1.15.35
  - @ifc-lite/query@1.14.14
  - @ifc-lite/sdk@1.21.3

## 0.9.1

### Patch Changes

- [#1774](https://github.com/LTplus-AG/ifc-lite/pull/1774) [`8a0b09f`](https://github.com/LTplus-AG/ifc-lite/commit/8a0b09f161fffbc3302e173bd639a5aa85074e59) Thanks [@louistrue](https://github.com/louistrue)! - Harden the collab server, MCP path guard, and point-cloud decoders against abuse and hostile input.

  - collab-server: rate-limit the unauthenticated fresh-room token-mint path per client IP (authenticated admin re-mints are exempt) and cap `claimedRooms` growth (`COLLAB_MAX_CLAIMED_ROOMS`, default 100k). `X-Forwarded-For` is IGNORED by default when deriving the rate-limit IP (a spoofable header would hand every request its own bucket); set `COLLAB_TRUST_PROXY=1` (or `tokenEndpoint.trustForwardedFor`) behind a trusted reverse proxy, which then uses the LAST header entry (the hop the proxy itself appended).
  - collab-server: access-control persistence (revocations + claimed rooms) is now debounced, written atomically (temp file + rename, no torn state file on crash), and flushed on SIGINT/SIGTERM; `flush()` rejects (and the CLI exits non-zero, loudly) when the state never reached disk. Startup is fail-closed: a present-but-unreadable or malformed state file throws instead of running open, and a MISSING state file on a data dir that already has persisted rooms marks those rooms claimed (admins re-mint with their still-valid admin bearers; squatters cannot first-claim them). Revocations now persist as `jti -> exp` (the legacy `revoked: string[]` shape still loads) and are pruned once the revoked token would have expired anyway, so the deny-list stays bounded without ever evicting a live revocation. The policy moved from `bin.ts` into an exported `createAccessControl` for reuse and testing.
  - collab-server: a ref that requires human approval now refuses approvals when its reviewer allowlist is empty (previously any non-author principal could self-approve past the merge gate).
  - collab-server: metrics-token comparison hashes both sides to fixed-length digests before `timingSafeEqual`, removing the length oracle; startup without `COLLAB_TOKEN_SECRET` on a non-loopback host logs an explicit OPEN-server warning; idle rooms unload after `COLLAB_IDLE_UNLOAD_MS` (default 5 min) so long-lived deployments can't wedge at `maxRooms`.
  - mcp: the safe-path guard now also refuses shell startup/persistence files (`.bashrc`, `.zshrc`, `.profile`, `.gitconfig`, …) and the `~/.config` tree for both read and write.
  - pointcloud: E57/PCD/PLY decoders reject header-declared record/point/vertex counts (and LZF uncompressed sizes) that the actual body bytes cannot back, so a small hostile file can no longer force multi-GB allocations before the first read fails; ascii floors allow EOF-terminated final records. The PCD LZF expansion bound is format-derived (90x, above LZF's real 88x back-reference maximum, so genuinely repetitive valid files decode) plus an absolute 1 GiB uncompressed ceiling; PCD field SIZE/COUNT must be positive safe integers and the accumulated stride may not overflow. PLY element counts are parsed strictly, and list-valued properties on the vertex element (variable-length records the fixed-stride readers cannot walk) are rejected up front.

- Updated dependencies [[`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`7ef3622`](https://github.com/LTplus-AG/ifc-lite/commit/7ef36225d863ec64dfb254cf0767d4ab9d034849), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe), [`564a800`](https://github.com/LTplus-AG/ifc-lite/commit/564a800e997322d863aac84127497ef4f8310ac3), [`cc92f17`](https://github.com/LTplus-AG/ifc-lite/commit/cc92f171661eb8e27170bcc0360336df819f9ab7), [`a42b8a9`](https://github.com/LTplus-AG/ifc-lite/commit/a42b8a9cfc559781575dde893b2116a5dc493732)]:
  - @ifc-lite/bcf@1.16.3
  - @ifc-lite/parser@3.9.1
  - @ifc-lite/data@2.6.0
  - @ifc-lite/export@2.5.3
  - @ifc-lite/geometry@3.2.1
  - @ifc-lite/ids@1.15.32

## 0.9.0

### Minor Changes

- [#1729](https://github.com/LTplus-AG/ifc-lite/pull/1729) [`b54f704`](https://github.com/LTplus-AG/ifc-lite/commit/b54f70478a7b92055750f11267ffe7fa47ed7da1) Thanks [@louistrue](https://github.com/louistrue)! - Review comments as BCF topics (08-review.md §8.6): registry reviews gain `GET/POST /api/v1/reviews/:id/topics` — topics bound to (entity, componentKey?) with server-derived authors, optional viewpoints, and the named-reviewers write gate. The MCP review loop matches: new `add_review_topic` tool, and `get_review_feedback` returns the topics.

### Patch Changes

- Updated dependencies [[`c1695d7`](https://github.com/LTplus-AG/ifc-lite/commit/c1695d777263483110460df767ec86ca691048ab), [`5e90494`](https://github.com/LTplus-AG/ifc-lite/commit/5e904942e3fd167d0d0e1a9c37b391d638eb6932), [`cd6c9bd`](https://github.com/LTplus-AG/ifc-lite/commit/cd6c9bda1066b7c7cda19e164d787d15b57e3483)]:
  - @ifc-lite/collab@0.4.0
  - @ifc-lite/merge@0.3.0
  - @ifc-lite/mutations@1.20.0

## 0.8.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer PRs surfaces:

  - **cli**: new `layer` namespace (`create`, `status`, `publish`, `diff`, `merge --preview`, `log`, `bake`, `revert`, `rebase`) and `ref` namespace (`list`, `create`, `move`, `protect`) over a local content-addressed layer store, with stable exit codes (0 clean, 2 conflicts, 3 required-check/policy failure, 4 scope violation).
  - **mcp**: draft-layer tool family — `create_draft_layer`, `draft_apply_ops` (write-time scope enforcement), `publish_layer` (publish-time claim-vs-ops verification), `diff_layer`, `dry_run_merge`, `list_conflicts`, `request_review`, `add_review_feedback`, `get_review_feedback`, `respond_to_review`.

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer store and merge hardening:

  - **cli**: `loadLayer` verifies the blake3 content address on every read (a tampered or corrupted layer file fails loudly instead of composing silently); refs.json, layer files, and draft.json are written atomically (temp file + rename); `layer publish --check <spec.ids>=<report.json>` stamps verified check evidence into the provenance manifest — pass/fail derived from the `ifc-lite ids --json` report, spec and report content-addressed; `layer merge` refuses a candidate whose declared base matches nothing on the target ref (exit 5) unless `--allow-unrelated` is passed.
  - **mcp**: `diff_layer`, `dry_run_merge`, and `list_conflicts` report `base_resolved` so agents can tell when a preview ran against an empty ancestor (the placeholder `would_fail_checks` field is gone).

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Session-scoped layer workspaces and ownership checks ([#1030](https://github.com/LTplus-AG/ifc-lite/issues/1030)): layer drafts are keyed by transport session id (private per Streamable HTTP session, disposed on session end; stdio keeps the local draft space) while published layers, refs, and reviews are process-shared so reviewers can act on them from their own sessions. `ToolContext` carries a `SessionIdentity`, drafts/reviews record their creating principal, mutating layer tools are owner-gated (reviews also visible to listed reviewers), and unknown-id error details only enumerate ids visible to the caller. `HttpTransport` enforces the same scope identity on DELETE/SSE-attach as on POST and rejects session factories that don't bind the provided session id; both in-repo factories (`@ifc-lite/mcp` CLI and `ifc-lite mcp`) bind it.

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Serialize structured entity branches (psets, quantities, classifications, materials, geometryRef) through the IFCX snapshot pipeline ([#1031](https://github.com/LTplus-AG/ifc-lite/issues/1031)): `snapshotToIfcx` folds them into namespaced attributes (`bsi::ifc::v5a::<Set>::<Name>` for psets/quantities, `ifclite::` carriers for the rest), `seedFromIfcx` re-inflates them, and `extractMinimalLayer` diffs the same flattened view so structured edits and deletions survive snapshot → seed round-trips and minimal layers. The typed `TypedPropertyValue` record is the canonical wire shape: the MCP `set_property` draft op emits it, property extraction decodes it (and skips `ifclite::` carriers), composition resolves `null` attribute opinions as removals, and `bakeLayers` preserves the persistent carriers while stripping bookkeeping.

### Patch Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - The layer-diff JSON is now one shared contract: `diffStackStates`/`diffLayerStacks` (`StackDiff` shape, deterministically ordered) live in `@ifc-lite/merge`, and the CLI `layer diff` command and the MCP `diff_layer` tool consume the identical implementation — the two previously separate copies had already drifted on ordering. A byte-exact contract test pins the wire shape the review UI will consume.

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`8f3fafd`](https://github.com/LTplus-AG/ifc-lite/commit/8f3fafd7cc777e60cdc006956f8336680723c440), [`a2c31a1`](https://github.com/LTplus-AG/ifc-lite/commit/a2c31a185e868d15183df8360badb001789bd978), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`a1bbd6c`](https://github.com/LTplus-AG/ifc-lite/commit/a1bbd6c209ded2da1405a8d1c816a193601ae625)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/extensions@0.4.0
  - @ifc-lite/mutations@1.19.0
  - @ifc-lite/collab@0.3.0
  - @ifc-lite/merge@0.2.0
  - @ifc-lite/geometry@3.2.0
  - @ifc-lite/clash@1.6.3
  - @ifc-lite/parser@3.8.5
  - @ifc-lite/viewer-core@0.2.10
  - @ifc-lite/ids@1.15.30

## 0.7.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`3267aaf`](https://github.com/LTplus-AG/ifc-lite/commit/3267aaf5dfe98f9550695d44c1d12644f2c04b88), [`26de705`](https://github.com/LTplus-AG/ifc-lite/commit/26de705b8608b9cd75e90411288c7ada96b3352b), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/bcf@1.16.2
  - @ifc-lite/clash@1.6.2
  - @ifc-lite/create@1.16.4
  - @ifc-lite/data@2.5.2
  - @ifc-lite/export@2.5.2
  - @ifc-lite/geometry@3.1.4
  - @ifc-lite/ids@1.15.27
  - @ifc-lite/mutations@1.18.1
  - @ifc-lite/parser@3.8.2
  - @ifc-lite/query@1.14.13
  - @ifc-lite/sdk@1.21.2
  - @ifc-lite/viewer-core@0.2.9

## 0.7.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/bcf@1.16.1
  - @ifc-lite/clash@1.6.1
  - @ifc-lite/create@1.16.3
  - @ifc-lite/data@2.5.1
  - @ifc-lite/export@2.5.1
  - @ifc-lite/ids@1.15.26
  - @ifc-lite/parser@3.8.1
  - @ifc-lite/query@1.14.12
  - @ifc-lite/sdk@1.21.1
  - @ifc-lite/viewer-core@0.2.8

## 0.7.0

### Minor Changes

- [#1580](https://github.com/LTplus-AG/ifc-lite/pull/1580) [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47) Thanks [@louistrue](https://github.com/louistrue)! - Plumb the IFC measure type through the property pipeline so consumers can show units (issue [#1573](https://github.com/LTplus-AG/ifc-lite/issues/1573)):

  - `@ifc-lite/data`: `Property` gains an optional `dataType?: string` carrying the raw IFC measure value type (e.g. `"IFCVOLUMETRICFLOWRATEMEASURE"`) of a typed nominal value. Additive and optional; existing consumers are unaffected.
  - `@ifc-lite/mutations`: the `PropertyExtractor` function type now carries the same optional `dataType?` per property, and `MutablePropertyView.getForEntity` preserves it through the base and mutation-merge paths, so a property's measure type survives the merge for unit display.
  - `@ifc-lite/mcp`: `geometry_volume` / `geometry_area` now resolve the volume/area symbol from the file's declared `IfcUnitAssignment` (via `@ifc-lite/parser`'s `extractProjectUnits`) instead of hardcoding `m³` / `m²`, and report the resolved symbol in a new `unit` response field. Falls back to the SI default when the store has no source buffer or declares no such unit.

### Patch Changes

- Updated dependencies [[`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47), [`3a2cd42`](https://github.com/LTplus-AG/ifc-lite/commit/3a2cd42158313d8e22f21885e62b6c705814ab47)]:
  - @ifc-lite/parser@3.7.0
  - @ifc-lite/data@2.4.0
  - @ifc-lite/mutations@1.18.0
  - @ifc-lite/ids@1.15.24

## 0.6.0

### Minor Changes

- [#1497](https://github.com/LTplus-AG/ifc-lite/pull/1497) [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1) Thanks [@Blogbotana](https://github.com/Blogbotana)! - feat(parser): support opening `.ifcZIP` containers (issue [#1494](https://github.com/LTplus-AG/ifc-lite/issues/1494))

  The buildingSMART IFC container format — a zip archive wrapping a single
  `.ifc`/`.ifcxml` file — is now unwrapped transparently. New `@ifc-lite/parser`
  exports:

  - `isZipBuffer(buffer)` — cheap magic-byte check.
  - `unwrapIfcZip(buffer)` — returns the model file's bytes if `buffer` is a
    zip container, or `buffer` unchanged otherwise (safe to call
    unconditionally on every load). Throws if the archive has zero or more
    than one `.ifc`/`.ifcxml` entry rather than guessing which to load, or if
    the entry's declared uncompressed size exceeds 4 GiB (a zip-bomb guard,
    checked from the zip central directory — no decompression needed to check).
  - `unwrapIfcZipView(view)` — same contract for a Node `Buffer`/`Uint8Array`.

  `parseAuto` calls it automatically. The CLI and MCP loaders (`loadIfcFile`,
  `loadIfcModel`) unwrap before their STEP-signature check, so `ifc-lite info
model.ifcZIP` and MCP's `model_load` just work. The viewer's file picker and
  drag-and-drop now accept `.ifczip` alongside `.ifc`/`.ifcx`/`.glb`.

  The hosted Rust parsing server (`apps/server`) unwraps `.ifcZIP` too, in its
  multipart `extract_file` path (alongside the existing gzip handling), so an
  uploaded container is decompressed server-side before parsing and the viewer's
  multi-core server fast-path works for zipped uploads. It applies the same
  single-`.ifc`/`.ifcxml`-entry rule and bounds the decompressed size against the
  server's max-file-size ceiling (zip-bomb guard).

  Referenced resources inside the container (textures, documents) are not
  extracted in this pass — only the model file's bytes.

### Patch Changes

- Updated dependencies [[`218e613`](https://github.com/LTplus-AG/ifc-lite/commit/218e613b06cc5ca2a74c84f72e039b430be6caee), [`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd), [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1), [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`47bde10`](https://github.com/LTplus-AG/ifc-lite/commit/47bde10dcacddf8f99e1e6b2bf036c78c192c5ff), [`b157b48`](https://github.com/LTplus-AG/ifc-lite/commit/b157b4841bfa795f8a937a9be20c21b645757fbe)]:
  - @ifc-lite/clash@1.5.0
  - @ifc-lite/geometry@3.1.0
  - @ifc-lite/parser@3.6.0
  - @ifc-lite/export@2.5.0
  - @ifc-lite/ids@1.15.23

## 0.5.0

### Minor Changes

- [#1491](https://github.com/LTplus-AG/ifc-lite/pull/1491) [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53) Thanks [@louistrue](https://github.com/louistrue)! - feat(export): large-model GLB reliability - bounded memory, fail-closed, byte returns

  Three related hardening changes on the export surface:

  - **Bounded-memory GLB.** Inputs at or above 64 MB (native override
    `IFC_LITE_GLB_STREAM_THRESHOLD_MB`, `0` disables) are exported through a
    two-pass streaming assembler: pass 1 records per-mesh metadata only, pass 2
    re-streams and bakes vertex bytes directly into an exactly-preallocated GLB.
    Peak memory is the final artifact plus one mesh batch instead of the whole
    model's meshes plus multiple full-buffer copies - this fixes the wasm
    `RuntimeError: unreachable` / OOM on large in-browser exports. Models without
    instanceable groups produce byte-identical output; instanced models keep
    identical world geometry (rep-identity instancing is skipped above the
    threshold, content-hash dedup is kept).

  - **Fail-closed empty GLB at the boundary.** `exportGlb` now throws a typed
    `Error` whose message starts with `NO_RENDER_GEOMETRY` when the visible mesh
    set is empty, instead of returning a structurally valid but empty GLB.
    `@ifc-lite/geometry` exports `NO_RENDER_GEOMETRY` and
    `isNoRenderGeometryError(err)` to match it; the CLI and MCP map it to their
    existing tailored messages.

  - **BREAKING: sibling exporters return bytes.** `exportObj`, `exportCsv`,
    `exportJson`, `exportJsonld`, `exportIfcx`, `exportStep`, `exportMerged` and
    `exportHbjson` (wasm boundary, `IfcLiteBridge`, and `GeometryProcessor`) now
    return `Uint8Array` (UTF-8) instead of `string`, so output is no longer capped
    by the V8 max-string ceiling (~512 MB) - the same escape GLB already had.
    Decode with `TextDecoder` where a string is genuinely needed; file writers
    should write the bytes directly.

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`204cab4`](https://github.com/LTplus-AG/ifc-lite/commit/204cab48f8e3b6326a8005628ed5b7174d9d694c), [`a48abac`](https://github.com/LTplus-AG/ifc-lite/commit/a48abacfacdf226702f2454859afe9abe018e029), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/data@2.3.0
  - @ifc-lite/query@1.14.11
  - @ifc-lite/export@2.4.0
  - @ifc-lite/clash@1.4.1
  - @ifc-lite/parser@3.5.2
  - @ifc-lite/viewer-core@0.2.7
  - @ifc-lite/ids@1.15.22

## 0.4.1

### Patch Changes

- 24e1648: Make the Rust-backed exporters reliable on large and degenerate inputs.

  Remove the ~512 MB input cap on GLB/glTF (and the sibling OBJ, CSV, JSON, JSON-LD,
  STEP, IFCX, HBJSON exporters). They decoded the entire input IFC byte buffer into a
  single JS string via `safeUtf8Decode` before crossing into WASM, where the binding
  immediately turned it back into bytes (`content.as_bytes()`). For an input over V8's
  `0x1fffffe8` (~512 MB) string ceiling that decode threw "Cannot create a string longer
  than 0x1fffffe8 characters", so files in the 0.5 GB+ range failed before any geometry
  ran. The boundary now passes the raw `Uint8Array`/`&[u8]` straight through (matching the
  existing `exportMerged` path), which removes the cap, drops a redundant full-buffer copy
  and a UTF-8 re-encode, and is byte-faithful for non-UTF-8 input.

  Scope: this lifts the cap on the INPUT side for all exporters. GLB returns a
  `Uint8Array`, so its output also escapes the V8 ceiling; the string-returning
  exporters (OBJ/CSV/JSON/JSON-LD/STEP/IFCX/HBJSON) still cap their serialized OUTPUT
  at the same ~512 MB string limit. In-browser, the wasm32 linear-memory heap (not the
  string cap) is the practical ceiling for the very largest models.

  Fail loud on an empty GLB export. A malformed-but-parseable model (or a filter whose
  matched entities carry no triangulated geometry) produced a structurally valid GLB with
  zero meshes, which the CLI and MCP tools wrote to disk and reported as success. Both now
  reject a zero-mesh GLB with a clear error (new `countGlbMeshes` helper in
  `@ifc-lite/export`).

  Guard the GLB assembler against the glTF 32-bit buffer limit. The assembler cast every
  buffer offset and byteLength `as u32`; past 4 GiB those casts silently wrapped (release
  builds disable overflow checks) and emitted a corrupt GLB. It now sums the binary buffer
  length in `usize` and asserts the 4 GiB ceiling with a clear message instead of wrapping.

- 7c45192: Instance repeated geometry in GLB/glTF export (50-85% smaller on repetitive models).

  The from-bytes GLB assembler baked every element occurrence in full, so a model with
  hundreds of identical windows, doors, or steel parts (one IFC `RepresentationMap`
  referenced by many `IfcMappedItem`s) emitted that geometry hundreds of times. The
  exporter now reuses the same representation-identity collation the GPU/native
  instancing path uses: each repeated shape is emitted ONCE and every occurrence is
  placed with a glTF node matrix carrying its world pose.

  Each occurrence's node matrix is recomputed in f64 from the per-occurrence world
  placement, the model RTC / site-local offset the baker subtracted, and the Z-up to Y-up
  basis change, then folded against the model-wide scene centre before the single f32
  downcast. Doing the relative transform in the post-RTC baked frame (not the placement's
  pre-RTC frame) is what keeps a ROTATED occurrence correct under a non-zero site/georef
  offset — otherwise it is mis-translated by `(R - I) * rtc`, kilometres at national-grid
  coordinates. The f64 composition keeps the absolute-magnitude terms cancelling to a
  model-relative, f32-precise translation even at national-grid scale.

  Only exact-bit groups are instanced (the template's local geometry IS each occurrence's),
  so the exported per-occurrence geometry is byte-faithful; rigid-tier and any
  singular-placement groups fall back to the flat path. Two round-trip tests reconstruct
  every instanced occurrence's world geometry from `root.translation * node.matrix *
template_local` and match the baked geometry to under a millimetre — one on a real model,
  one synthetic with a rotated instance at national-grid coordinates.

  Non-instanced occurrences keep the existing self-contained `world - scene_center` vertex
  bake (no node transform), so a consumer that ignores node transforms still sees them
  correctly placed. The flat remainder is additionally content-hash deduped (byte-identical
  baked meshes share one mesh placed by a node translation), so the output never regresses
  below the prior per-occurrence baseline on models without representation-level repeats.

  Measured GLB size: C20-Institute 4.0 -> 1.3 MB (-68%), AC20-Smiley 13.0 -> 2.4 MB (-82%),
  schependomlaan 15.5 -> 7.6 MB (-51%); models with no repeats are unchanged. Output is
  byte-deterministic. The viewer's from-meshes GLB path is unaffected (it carries no
  instancing side-channel and falls back to the flat content-hash dedup).

- Updated dependencies [e6bd2dd]
- Updated dependencies [24e1648]
- Updated dependencies [f9f0784]
- Updated dependencies [7c45192]
- Updated dependencies [6eb46f1]
- Updated dependencies [775e479]
- Updated dependencies [4f76955]
- Updated dependencies [909c1b0]
- Updated dependencies [3f25a72]
  - @ifc-lite/geometry@2.13.0
  - @ifc-lite/export@2.3.0

## 0.4.0

### Minor Changes

- [#1242](https://github.com/LTplus-AG/ifc-lite/pull/1242) [`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722) Thanks [@louistrue](https://github.com/louistrue)! - Add Rust-backed domain-format exporters. The new `ifc-lite-export` crate is the
  source of truth for Wavefront OBJ, glTF/GLB, CSV, JSON and JSON-LD (plus a
  native-only ara3d BOS/Parquet path). They are exposed via wasm
  (`exportObj`/`exportGlb`/`exportCsv`/`exportJson`/`exportJsonld`) and
  reachable from TypeScript through `GeometryProcessor.export*` and
  `IfcLiteBridge.export*`. Geometry exporters fold per-mesh RTC origin correctly (glTF
  emits it as a node translation, keeping f32 vertex precision at georef scale).

  STEP export also supports schema conversion (`IFC2X3`/`IFC4`/`IFC4X3`/`IFC5` entity-type
  renames + attribute trimming) and a mutation bridge — `exportStep` takes a `mutations_json`
  payload (`MutablePropertyView` attribute edits + property-set synthesis: new
  `IfcPropertySingleValue`/`IfcPropertySet`/`IfcRelDefinesByProperties` entities). New Rust exporters:
  **IFC5/IFCX** (`exportIfcx` — USD-style node graph: spatial hierarchy + classes + known
  IFC5 properties) and **Merged** (`exportMerged` — combine several models into one STEP,
  id-offset + project unification).

  The CLI `export` command gains `--format obj|gltf|glb|jsonld|step|ifcx` (Rust-backed;
  `--type`/`--storey`/`--where`/`--limit` act as the isolation set — for `step` the forward
  `#`-reference closure is added so a filtered export never dangles a reference; `--schema`
  converts entity types). The MCP `export_glb` tool is unstubbed, `export_ifcx` is unstubbed,
  and a new `export_obj` tool is added (all honour an optional `type` filter).

  Also makes the wasm geometry engine usable under Node: `IfcLiteBridge.init()` now reads
  the `.wasm` bytes itself when running in Node (whose `fetch()` cannot load `file://`),
  strictly Node-gated so the browser/worker path is unchanged. This additionally fixes
  headless `clash`/geometry commands that previously failed to initialize wasm in Node.

  The viewer's GLB export now assembles the binary in Rust over the meshes it already
  holds (`GeometryProcessor.exportGlbFromMeshes`, wasm `exportGlbFromMeshes`) instead of the
  TypeScript GLTFExporter — no re-meshing, and the per-element RTC origin rides a glTF node
  translation so georef-scale models keep vertex precision.

  **BREAKING (`@ifc-lite/export`):** `GLTFExporter`, `JSONLDExporter`, and `CSVExporter`
  (+ their option types) are removed — glTF/GLB, JSON-LD, and CSV are now produced in Rust. Use
  `GeometryProcessor.exportGlb` / `exportGlbFromMeshes`, `exportJsonld`, and
  `exportCsv(bytes, mode, …)` (mode ∈ `entities`|`properties`|`quantities`|`spatial`). All in-repo
  callers (viewer GLB / command-palette / mobile / location-map / main-toolbar CSV exports, LOD1
  generator) are migrated; the Rust CSV gained the spatial-hierarchy mode to match.

### Patch Changes

- Updated dependencies [[`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722), [`0a0a922`](https://github.com/LTplus-AG/ifc-lite/commit/0a0a922adba1dabc56e97cc5ce0c553ab7356b3e)]:
  - @ifc-lite/geometry@2.9.0
  - @ifc-lite/export@2.0.0
  - @ifc-lite/sdk@1.20.1

## 0.3.3

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112)]:
  - @ifc-lite/create@1.16.2
  - @ifc-lite/export@1.19.6
  - @ifc-lite/parser@3.2.0
  - @ifc-lite/geometry@2.6.1
  - @ifc-lite/clash@1.1.3
  - @ifc-lite/sdk@1.18.3
  - @ifc-lite/data@2.0.3
  - @ifc-lite/ids@1.15.10

## 0.3.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc), [`8d5bd67`](https://github.com/LTplus-AG/ifc-lite/commit/8d5bd6701dc9962c2de5e42a7462008b2b8c2885)]:
  - @ifc-lite/bcf@1.15.6
  - @ifc-lite/clash@1.1.2
  - @ifc-lite/create@1.16.1
  - @ifc-lite/data@2.0.2
  - @ifc-lite/encoding@1.14.7
  - @ifc-lite/export@1.19.5
  - @ifc-lite/geometry@2.4.1
  - @ifc-lite/ids@1.15.6
  - @ifc-lite/mutations@1.15.3
  - @ifc-lite/parser@3.1.1
  - @ifc-lite/query@1.14.10
  - @ifc-lite/sdk@1.18.1
  - @ifc-lite/viewer-core@0.2.6

## 0.3.1

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

- Updated dependencies [[`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525), [`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b)]:
  - @ifc-lite/parser@3.1.0
  - @ifc-lite/geometry@2.3.0
  - @ifc-lite/query@1.14.9
  - @ifc-lite/mutations@1.15.2
  - @ifc-lite/export@1.19.4
  - @ifc-lite/viewer-core@0.2.5
  - @ifc-lite/data@2.0.1
  - @ifc-lite/sdk@1.17.1
  - @ifc-lite/clash@1.1.1
  - @ifc-lite/bcf@1.15.5
  - @ifc-lite/ids@1.15.5

## 0.3.0

### Minor Changes

- [#891](https://github.com/LTplus-AG/ifc-lite/pull/891) [`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8) Thanks [@louistrue](https://github.com/louistrue)! - Add representation-agnostic clash detection.

  `@ifc-lite/clash` is a new package: a source-agnostic clash core (STEP/IFCX
  adapters, BVH broad phase, exact triangle-intersection narrow phase, hard /
  clearance / touch classification) with a pluggable TS reference kernel and a
  Rust/WASM kernel kept in lockstep by a differential test. Results group into a
  _manageable_ set of BCF topics (deterministic topic GUIDs, caps-with-transparency,
  framing viewpoints, A/B coloring, optional snapshots) and round-trip status back.

  Surfaced through the existing tools:

  - `@ifc-lite/clash` — `rulesFromPresets(presets, mode, clearance?, reportTouch?)` builds
    runnable rules from any preset list (the discipline matrix is this over the built-ins),
    so hosts can run a user-curated rule set.
  - `@ifc-lite/viewer` — an interactive clash panel (run detection / discipline matrix /
    presets, A/B highlight + camera framing, configurable settings & custom rules, a
    controllable BCF export with optional rendered snapshots).
  - `@ifc-lite/sdk` — a `clash` namespace (`run`, `matrix`, `group`, presets).
  - `@ifc-lite/cli` — `ifc-lite clash <file>` with `--a/--b`, `--mode`, `--matrix`,
    `--clearance`, `--bcf`.
  - `@ifc-lite/mcp` — `clash_check` (omit selectors for a whole-model self-clash)
    and `clash_matrix`.

  The discipline matrix now threads a `clearance` value onto its rules, so
  `--matrix --mode clearance --clearance N` (and the SDK/MCP equivalents) report
  violations instead of silently dropping the override.

### Patch Changes

- Updated dependencies [[`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8)]:
  - @ifc-lite/clash@1.1.0
  - @ifc-lite/sdk@1.17.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/parser@3.0.0
  - @ifc-lite/export@1.19.3
  - @ifc-lite/data@2.0.0
  - @ifc-lite/create@1.15.1
  - @ifc-lite/ids@1.15.4
  - @ifc-lite/query@1.14.8
  - @ifc-lite/sdk@1.16.1
  - @ifc-lite/viewer-core@0.2.4
  - @ifc-lite/mutations@1.15.1

## 0.2.0

### Minor Changes

- [#615](https://github.com/louistrue/ifc-lite/pull/615) [`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d) Thanks [@louistrue](https://github.com/louistrue)! - Add `@ifc-lite/mcp` — Model Context Protocol server for ifc-lite, exposing
  the BIM runtime to any MCP-aware LLM agent (Claude Desktop, Cursor,
  ChatGPT, Goose, Windsurf, Zed, custom). v0.1 ships with stdio + Streamable
  HTTP transports, scope-gated tool surface across discovery / query /
  geometry / validation (IDS + audit) / mutation / BCF / bSDD / diff /
  export / viewer, an `ifc-lite://` resource scheme, eleven pre-baked
  prompt templates, and an `ifc-lite mcp` CLI subcommand.

  The 3D viewer is a first-class workflow:
  • `viewer_open` boots the WebGL viewer in-process and swaps streaming
  adapters into the headless backend so every `bim.viewer.*` /
  `bim.visibility.*` call drives the live scene.
  • `viewer_colorize`, `viewer_isolate`, `viewer_fly_to`,
  `viewer_color_by_property`, `viewer_set_section` make agent-driven
  visualization a single tool call.
  • User picks in the browser flow back to MCP via SSE and surface as
  `notifications/resources/updated` on `ifc-lite://viewer/selection`.
  `viewer_get_selection` reads the latest pick; `viewer_wait_for_selection`
  blocks until the next click.
  • `viewer_ask` emits agent-friendly wording so the agent can request
  user permission before opening a browser tab.
  • CLI flags `--viewer`, `--viewer-port`, and `--open` automate startup.

### Patch Changes

- Updated dependencies [[`7a7cf79`](https://github.com/louistrue/ifc-lite/commit/7a7cf79c181004f9974bd303181aeeaa97d6869d)]:
  - @ifc-lite/ids@1.14.11
