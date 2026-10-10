# @ifc-lite/rules

## 0.7.0

### Minor Changes

- [#6935](https://github.com/LTplus-AG/ifc-lite/pull/6935) [`83c9f35`](https://github.com/LTplus-AG/ifc-lite/commit/83c9f3516acfe895c98cffd13f0f4410bc44b30b) Thanks [@louistrue](https://github.com/louistrue)! - Export `writeIdsXml`, the IDS 1.0 writer behind `ruleSetToIds`, and extend it ([#6915](https://github.com/LTplus-AG/ifc-lite/issues/6915)): property `dataType`, `partOf` facets (upper-case XSD relation token, related entity required) and requirement `instructions` are now written. Constraint parts it has no XML for (`xs:length` / `minLength` / `maxLength` / digit bounds, conjunctive restriction facets, unparseable bounds) are refused with an error instead of being written as a weaker check. Line breaks and tabs in attribute values (such as multi-line `instructions`) are written as character references so they read back unchanged, and a control character XML 1.0 cannot carry is refused with the element or attribute it is in. Every pass/fail case of the vendored buildingSMART IDS corpus that it writes (301 of 307) reads back with the same specifications and gives the same verdict.

- [#7189](https://github.com/LTplus-AG/ifc-lite/pull/7189) [`6a6714b`](https://github.com/LTplus-AG/ifc-lite/commit/6a6714b4e95f25ef43013be354a2ff62674ff07a) Thanks [@louistrue](https://github.com/louistrue)! - Add a durable captured entity population contract with full source identity and authored creation provenance. Resolve every member before native evaluation; Lists intersect the captured population with their source criteria and manual and automatic Lens evaluations restrict their complete native populations. Providers unable to resolve a saved scope refuse rather than evaluating every entity.

### Patch Changes

- [#7411](https://github.com/LTplus-AG/ifc-lite/pull/7411) [`25a8f4c`](https://github.com/LTplus-AG/ifc-lite/commit/25a8f4c7f4dd7633cf5b082ab77525c054022dcd) Thanks [@louistrue](https://github.com/louistrue)! - IDS restriction bounds (`xs:minInclusive`, `xs:maxInclusive`, `xs:minExclusive`, `xs:maxExclusive`) are now read and compared by the restriction's `@base` instead of with `parseFloat` ([#7399](https://github.com/LTplus-AG/ifc-lite/issues/7399)). A date range such as `[2024-01-01, 2024-03-31]` no longer collapses to `[2024, 2024]` and passes `2024-12-31`, and a malformed bound such as `"6,5"` under `xs:double` is no longer read as `6`.
  
  - Numeric bases accept a bound only when its whole text is in the base's lexical space (`xs:integer` and its derivations take no fraction). Values are compared only when their whole text is numeric, so `"5 m"` or `"2024-01-01"` no longer meet a numeric bound by their prefix.
  - `xs:date`, `xs:dateTime` and `xs:time` bounds compare as points on the time line, normalised to UTC, with XSD's ±14:00 rule for a value without a time zone. `xs:duration` bounds use XSD's partial order. Where XSD leaves a pair unordered, the value is not accepted. These bounds are exposed on the new `IDSBoundsConstraint.temporalBounds` field as their lexical text; the numeric `min*`/`max*` fields stay unset for them.
  - A bound outside its base's lexical space fails the restriction closed, and the audit reports it as `E_RESTRICTION_FACET_UNPARSEABLE`, naming the base. Length and digit-count facets are read as whole non-negative integers too. The audit also flags inverted date, time and duration bounds.
  - `@ifc-lite/rules`: `writeIdsXml` writes date, time and duration bounds back as written, and `idsToRuleSet` refuses them with a named reason.

- [#6938](https://github.com/LTplus-AG/ifc-lite/pull/6938) [`b13a060`](https://github.com/LTplus-AG/ifc-lite/commit/b13a0603dbdca1b660db0626b3ffaed6b57a1da5) Thanks [@louistrue](https://github.com/louistrue)! - A `property` or `quantity` filter rule with `valueUnit: 'si'` (or `inherit`) now reads unsaved in-session edits through the model's mutation view in search and filters, the same overlay plain property rules read, instead of the file as loaded. The edited value keeps its unit, so it is still converted to SI. Validation still reads the model as loaded.

- [#7158](https://github.com/LTplus-AG/ifc-lite/pull/7158) [`295a243`](https://github.com/LTplus-AG/ifc-lite/commit/295a2439e533af87a838ee2f252d87da19755890) Thanks [@louistrue](https://github.com/louistrue)! - Read classifications through live definition, reference, association and defining-type edits. Optional mutation views on the existing classification readers preserve model isolation, native export attribute precedence, revision freshness and unresolved source data. Rules now use those effective inputs and do not certify an explicit system as absent when a classification chain is unresolved.
- Updated dependencies [[`8f8fe3b`](https://github.com/LTplus-AG/ifc-lite/commit/8f8fe3b126f25201ebfd338f355eb3787e7ad908), [`6a6714b`](https://github.com/LTplus-AG/ifc-lite/commit/6a6714b4e95f25ef43013be354a2ff62674ff07a), [`ee2b091`](https://github.com/LTplus-AG/ifc-lite/commit/ee2b0918c7b82be6c36f49f70dee346e0fe85aad), [`eec7de9`](https://github.com/LTplus-AG/ifc-lite/commit/eec7de970a21a12ef4d09eaed382f45f7210772a), [`25a8f4c`](https://github.com/LTplus-AG/ifc-lite/commit/25a8f4c7f4dd7633cf5b082ab77525c054022dcd), [`7f55425`](https://github.com/LTplus-AG/ifc-lite/commit/7f554255ca96f812c9d65cf2507d46980fe604c6), [`272ebd8`](https://github.com/LTplus-AG/ifc-lite/commit/272ebd8615d038dc20dd8aec4e3bb88d1acf9fa7), [`8b81320`](https://github.com/LTplus-AG/ifc-lite/commit/8b813203997c0b3b21cc724c4f820ad83b9b4cf3), [`5047fcf`](https://github.com/LTplus-AG/ifc-lite/commit/5047fcfb5d5e18b062dbcd77f95523036bac55b9), [`07318f2`](https://github.com/LTplus-AG/ifc-lite/commit/07318f213ad9362528b694e60cf6c058d5adf722), [`b92dd05`](https://github.com/LTplus-AG/ifc-lite/commit/b92dd05495094a47c4a68eb1137a3a1906fc65cc), [`be7fb60`](https://github.com/LTplus-AG/ifc-lite/commit/be7fb6006ce8be46436a69d6fa611d11043f03ed), [`fd1f8f5`](https://github.com/LTplus-AG/ifc-lite/commit/fd1f8f52fabbde0ecee4d6a5c15635293ff1a15e), [`2499fdb`](https://github.com/LTplus-AG/ifc-lite/commit/2499fdb249eeffea22fa01c2f0fb12defe812e4a), [`fcad301`](https://github.com/LTplus-AG/ifc-lite/commit/fcad3010976b42d5de194d8018486c4d178d0ddf), [`73070c2`](https://github.com/LTplus-AG/ifc-lite/commit/73070c2d67c2a0507e6bc5492c090f2df3736881), [`2e2f65a`](https://github.com/LTplus-AG/ifc-lite/commit/2e2f65a66e1375ef6cc52b8a310526de1a36e1a0), [`cba05ef`](https://github.com/LTplus-AG/ifc-lite/commit/cba05ef735316ee8415610d520a76ea4873f2b3d), [`5047fcf`](https://github.com/LTplus-AG/ifc-lite/commit/5047fcfb5d5e18b062dbcd77f95523036bac55b9), [`1bb0fe3`](https://github.com/LTplus-AG/ifc-lite/commit/1bb0fe34c8fc46acef6e51f3792f274e1e5be1b9), [`99aabe5`](https://github.com/LTplus-AG/ifc-lite/commit/99aabe5204988f807b0447c7ffda05d1176b187a), [`295a243`](https://github.com/LTplus-AG/ifc-lite/commit/295a2439e533af87a838ee2f252d87da19755890), [`b92dd05`](https://github.com/LTplus-AG/ifc-lite/commit/b92dd05495094a47c4a68eb1137a3a1906fc65cc), [`6b11848`](https://github.com/LTplus-AG/ifc-lite/commit/6b118483a8f3b7c32744071a620cb7055ec87f77)]:
  - @ifc-lite/mutations@3.2.0
  - @ifc-lite/parser@9.3.0
  - @ifc-lite/ids@3.3.0
  - @ifc-lite/data@6.2.0

## 0.6.0

### Minor Changes

- [#6463](https://github.com/LTplus-AG/ifc-lite/pull/6463) [`64c343b`](https://github.com/LTplus-AG/ifc-lite/commit/64c343bfea7de91b2a44a895f6302f3b1a7f70a7) Thanks [@louistrue](https://github.com/louistrue)! - Carry an information-validation rule's `severity` on its validation result ([#6372](https://github.com/LTplus-AG/ifc-lite/issues/6372)). `SpecificationSummary` gains an optional `severity: 'error' | 'warning'` (absent means `'error'`; IDS never sets it), and `runRuleSet` fills it from each rule, so a report consumer can tell warning failures from failures without the rule file. `ifc-lite check` now reads the severity off the report for its `--fail-on` exit code, with unchanged results.

### Patch Changes

- [#6494](https://github.com/LTplus-AG/ifc-lite/pull/6494) [`4a9e7ad`](https://github.com/LTplus-AG/ifc-lite/commit/4a9e7ad337bafc495aa02be9e46a6ef130b9a075) Thanks [@louistrue](https://github.com/louistrue)! - IDS report block: fixed pass percentage and two layouts ([#6470](https://github.com/LTplus-AG/ifc-lite/issues/6470)). A pass rate was floored, so 70 of 7,972 entities passing read `0%` (and 9,999 of 10,000 would read `100%`), which said "nothing passes" when something did. `@ifc-lite/ids` now exports `boundedPassRate`, which keeps a partial result between 1% and 99%; the validator, rule engine, IDS panel, HTML export and document block all use it. The documentation page's IDS report block gets a Layout setting: Compact (one row per check and requirement, a coloured percent bar and only the attribute or property name) and Long (the full requirement text, wrapped rather than cut off, in both the preview and the PDF). Existing saved documents keep their current layout until you pick one; newly added blocks start Compact.
- Updated dependencies [[`93098dc`](https://github.com/LTplus-AG/ifc-lite/commit/93098dcb7f4125326db5d602977c5b3f9e9083cb), [`7780cb0`](https://github.com/LTplus-AG/ifc-lite/commit/7780cb05878c574ebd2a9f631ca6757233e845d3), [`4a9e7ad`](https://github.com/LTplus-AG/ifc-lite/commit/4a9e7ad337bafc495aa02be9e46a6ef130b9a075), [`e01487f`](https://github.com/LTplus-AG/ifc-lite/commit/e01487ff2f40fa758b73b3ec9a6abba9f9ff646b), [`e8ced94`](https://github.com/LTplus-AG/ifc-lite/commit/e8ced940d5cd6c9789f1221c5aeb7cdae883da3b), [`64c343b`](https://github.com/LTplus-AG/ifc-lite/commit/64c343bfea7de91b2a44a895f6302f3b1a7f70a7), [`2c6be4a`](https://github.com/LTplus-AG/ifc-lite/commit/2c6be4a52f513f174d8eae9bea4e77c7f00edea4), [`ec983d3`](https://github.com/LTplus-AG/ifc-lite/commit/ec983d378bfccc2b65fb636a76e321a2c9482aa4)]:
  - @ifc-lite/mutations@3.1.0
  - @ifc-lite/parser@9.2.0
  - @ifc-lite/ids@3.2.0

## 0.5.0

### Minor Changes

- [#6054](https://github.com/LTplus-AG/ifc-lite/pull/6054) [`05a2221`](https://github.com/LTplus-AG/ifc-lite/commit/05a222113355eea2e89d81acab74c62a5e77aa3f) Thanks [@louistrue](https://github.com/louistrue)! - Property rules and rule-set property subjects take a `memberPath` that reads one member of an `IfcComplexProperty` by name, one entry per nesting level (`['Frame', 'Width']`). It works the same in search, applicability and validation, and a member keeps its own unit, so `valueUnit: 'si'` and unit checks see it. A property that is not complex, or has no such member, reads as absent. Without `memberPath` a complex property still reads as its members' joined text. A server-parsed model carries no member breakdown, so there a `memberPath` rule reads as absent. The IDS export refuses a rule with `memberPath`, because no IDS facet can address a member. The parser now exposes a complex property's members as `members` on each extracted property. The rule chips and the validation subject picker have a member field.

- [#6251](https://github.com/LTplus-AG/ifc-lite/pull/6251) [`e45167d`](https://github.com/LTplus-AG/ifc-lite/commit/e45167dc7c70e1f24c5386da8e7d51834e352db3) Thanks [@louistrue](https://github.com/louistrue)! - Saved list filters migrate losslessly into Rules groups ([#6190](https://github.com/LTplus-AG/ifc-lite/issues/6190)). `migrateLegacyListDefinition` and `migrateLegacyListConditions` now turn every Lists predicate without a canonical Rules form into a `listCondition` rule instead of an unreadable row. That covers zones, spatial levels, quantity and material presence, model file name, Lists attributes, inherited and regex-named properties, and world coordinates. It applies both to v1 `conditions` and to provider-only rows saved by earlier builds. Flat conditions are ANDed into every group, and an OR group is split so `(a OR b) AND c` becomes `(a AND c) OR (b AND c)`. `unreadableConditions` now holds only data that cannot be evaluated: malformed members, unknown operators or sources, and group rules this build cannot read. A saved group with such a rule no longer makes the whole list disappear. The rule shows as a removable row instead.
  
  The viewer removes the Lists-only compatibility editor and its provider-only filter path. Every filter is edited in the shared Rules editor. A list with an unreadable row shows it with a Remove button and will not run until it is removed. Document table lists still reject malformed embedded groups at load.
  
  `@ifc-lite/rules` exports `LIST_CONDITION_SOURCES` and `LIST_CONDITION_OPERATORS`, the sources and operators a `listCondition` rule may hold, which the migration validates against.

- [#6249](https://github.com/LTplus-AG/ifc-lite/pull/6249) [`6ea079d`](https://github.com/LTplus-AG/ifc-lite/commit/6ea079d943f6bc95fb8316a100bef1f3eac7d472) Thanks [@louistrue](https://github.com/louistrue)! - Add a `listCondition` filter rule ([#6190](https://github.com/LTplus-AG/ifc-lite/issues/6190)). It carries a saved Lists value predicate (zone assignment and the zone volume modes, exact spatial levels, quantity and material presence, model file name, Lists attributes, inherited properties) inside a Rules `FilterGroup`, so it can combine with other rules under AND or OR. The Lists engine evaluates it. Each evaluated model supplies `EvaluatorModel.listConditions`, and `@ifc-lite/lists` exports `listConditionMatcher(provider)` to build one. A run whose rules hold a `listCondition` throws before reading any element when a model has no matcher, instead of matching nothing. Rule-set files reject the kind. The viewer's list runner attaches the matcher to every model it runs.

- [#6146](https://github.com/LTplus-AG/ifc-lite/pull/6146) [`236b076`](https://github.com/LTplus-AG/ifc-lite/commit/236b076ca7ee967691380335b4637a5be3c61562) Thanks [@louistrue](https://github.com/louistrue)! - Add total Lens, Lists, and Bulk filter operator adapters with semantic parity and inverse mappings.

- [#6172](https://github.com/LTplus-AG/ifc-lite/pull/6172) [`5eff834`](https://github.com/LTplus-AG/ifc-lite/commit/5eff8349cc35129549327273d938bc49e405bf53) Thanks [@louistrue](https://github.com/louistrue)! - Decode saved List conditions into canonical filter groups without dropping unsupported rows.

- [#6180](https://github.com/LTplus-AG/ifc-lite/pull/6180) [`0943da2`](https://github.com/LTplus-AG/ifc-lite/commit/0943da2a068efd24847cdb1282a4c55f766563e4) Thanks [@louistrue](https://github.com/louistrue)! - Remove `BulkQueryEngine` property predicates and their legacy typed-operator adapters. Use `@ifc-lite/rules` `FilterGroup[]` with `evaluateFilterGroupsFederated` to obtain model-scoped Express IDs, then pass those IDs in `BulkQueryEngine` `select.expressIds`. The Bulk engine constructor no longer accepts a PropertyTable fourth argument; shift later arguments left. The viewer Bulk editor now uses the Rules filter builder and evaluator.

### Patch Changes

- [#6054](https://github.com/LTplus-AG/ifc-lite/pull/6054) [`05a2221`](https://github.com/LTplus-AG/ifc-lite/commit/05a222113355eea2e89d81acab74c62a5e77aa3f) Thanks [@louistrue](https://github.com/louistrue)! - An `IfcPropertyReferenceValue` now reads as the `Name` of the object it references (a material, person, document, classification reference, …). If the object has no `Name`, it reads as its `Identification`, and failing that as `#<id>`. The parser used to take the `UsageName` slot for the reference, so every reference property read as empty. That was a bug, and rules and the property panel now see the referenced name. It also applies to references nested inside a complex property. IDS property checks on a reference property now compare against that name as well. The server's data model (`apps/server`) had the same slot bug and now reads references the same way, and so does the Rust mutation-log STEP writer's property base.

- [#6166](https://github.com/LTplus-AG/ifc-lite/pull/6166) [`36fcb46`](https://github.com/LTplus-AG/ifc-lite/commit/36fcb4614d66a4d2fc57ae0efdcb7c8edba4d3d1) Thanks [@louistrue](https://github.com/louistrue)! - Share the guarded IFC name matcher between Lists and Rules to prepare unified list filters.
- Updated dependencies [[`8901816`](https://github.com/LTplus-AG/ifc-lite/commit/8901816fa9171b1af0a9af5036105db0fa72cb24), [`f8303f2`](https://github.com/LTplus-AG/ifc-lite/commit/f8303f2ef22706718b616a20b4c04d22c86d5e4d), [`48e64d4`](https://github.com/LTplus-AG/ifc-lite/commit/48e64d44d418c913860c21e457d9053690ebd66c), [`05a2221`](https://github.com/LTplus-AG/ifc-lite/commit/05a222113355eea2e89d81acab74c62a5e77aa3f), [`28ae5b0`](https://github.com/LTplus-AG/ifc-lite/commit/28ae5b0bf1ce37fd592651113f3e765caa980291), [`84cd157`](https://github.com/LTplus-AG/ifc-lite/commit/84cd157d5afe30572481bd3c2b96a57c92dbbe19), [`64fc00a`](https://github.com/LTplus-AG/ifc-lite/commit/64fc00a700124a9a2ee73a778110704fe49ca36a), [`333e3fe`](https://github.com/LTplus-AG/ifc-lite/commit/333e3fe665ab284c7bcd8219916156f3d57d16c5), [`d0d79ed`](https://github.com/LTplus-AG/ifc-lite/commit/d0d79ed15415c7391640ad0660ad17f8d5ebbb5b), [`71b74cf`](https://github.com/LTplus-AG/ifc-lite/commit/71b74cfdbe9f60a8df3ebb728b264dbac2416fd5), [`17bbdf2`](https://github.com/LTplus-AG/ifc-lite/commit/17bbdf29a624072119c22cc1a50538f9edef5ad5), [`05a2221`](https://github.com/LTplus-AG/ifc-lite/commit/05a222113355eea2e89d81acab74c62a5e77aa3f), [`eb09636`](https://github.com/LTplus-AG/ifc-lite/commit/eb096369e13edcbb933c989ab87372d5062e975b), [`9828849`](https://github.com/LTplus-AG/ifc-lite/commit/9828849515862f0649f31a6433a5870e77249709), [`36fcb46`](https://github.com/LTplus-AG/ifc-lite/commit/36fcb4614d66a4d2fc57ae0efdcb7c8edba4d3d1), [`59b0668`](https://github.com/LTplus-AG/ifc-lite/commit/59b06685f2a0604c0ff305b63d831a81ecaff199), [`efc652c`](https://github.com/LTplus-AG/ifc-lite/commit/efc652c475f71b0d884d5c746b3156516618d1e3), [`0943da2`](https://github.com/LTplus-AG/ifc-lite/commit/0943da2a068efd24847cdb1282a4c55f766563e4)]:
  - @ifc-lite/data@6.1.0
  - @ifc-lite/parser@9.1.0
  - @ifc-lite/mutations@3.0.0
  - @ifc-lite/ids@3.1.0
  - @ifc-lite/encoding@2.3.0
  - @ifc-lite/regex-guard@0.3.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`66f3d7e`](https://github.com/LTplus-AG/ifc-lite/commit/66f3d7eb085e77a27e4a0bae096daa70b43620c9)]:
  - @ifc-lite/mutations@2.8.0

## 0.4.0

### Minor Changes

- [#5545](https://github.com/LTplus-AG/ifc-lite/pull/5545) [`5c02af8`](https://github.com/LTplus-AG/ifc-lite/commit/5c02af8b7fda4d2fe53f79d3f00b9d192fc664d9) Thanks [@louistrue](https://github.com/louistrue)! - **Behaviour change:** element rules now read list, enumerated and table property values member by member, in search, applicability and validation, and so in everything built on the same filter evaluator (appearance query scopes, clash set filters, chart filters). The `unit` requirement's reported value lists each member with its unit. In validation, `eq` and `ne` choose number or text comparison per member, so one text cell in a table no longer forces every number cell to a text comparison. A positive operator passes when ANY member matches. A negated operator (`ne`, `notContains`, `notMatches`) passes only when NO member has the value.
  
  Before, these rules compared the joined display string, so results change for existing list-valued properties. Against the list `Colors = (Red, Blue)`:
  - `Colors = Blue` used to fail and now passes.
  - `Colors = "Red, Blue"` used to pass and now fails.
  - `Colors != Red` used to pass and now fails.
  
  Each bound of a range is checked against the members on its own, so on a table `>= 15 AND <= 5` passes when some cell is ≥ 15 and another is ≤ 5. In search, negated operators also stop passing on a single non-matching property set when a regex set name matches several sets. That is the NONE rule validation already applied.
  
  The set checks (`unique`, `aggregate`, `compare`) still read each property as one whole value (a list's joined text, a table's `Table (N rows)` summary), so their results do not change.
  
  Bounded values and complex properties keep their display value. Lens colouring, the CLI's `--where` and bulk-edit queries are not rules and keep their own matching. Models whose properties come from a server-parsed property table carry no structure marker, so they keep the joined value.
  
  `@ifc-lite/parser` marks each extracted property with a `structure` (`enumerated`, `bounded`, `list`, `table`, `reference`, `complex`) when it is not a single value, and exports the `ExtractedProperty` type. `@ifc-lite/data`'s `Property` declares the same field, and `MutablePropertyView` keeps it on base properties. The filter value suggestions offer list members. `propertyCandidates` and `readSubjectWhole` are exported.

### Patch Changes

- [#5675](https://github.com/LTplus-AG/ifc-lite/pull/5675) [`7215c2a`](https://github.com/LTplus-AG/ifc-lite/commit/7215c2a9344ede37c90680e1eb2a6c2b70c0ee3d) Thanks [@louistrue](https://github.com/louistrue)! - STEP re-export no longer turns a source `FILE_NAME` author or organization of `$` (or `($)`) into `()`, which is not a valid `LIST [1:?]` and failed IfcOpenShell validation. The exporter now writes its `('')` default for those ([#5470](https://github.com/LTplus-AG/ifc-lite/issues/5470)).
  
  BREAKING: `IfcSourceHeader.author` and `.organization` (re-exported by `@ifc-lite/parser`, and returned by `parseSourceHeader`) are now optional. They are absent when the source wrote `$`, a list of only unset entries, or no `FILE_NAME` record. They are `[]` only for a literal `()`, which still round-trips as `()`. Code that reads them must handle `undefined`, e.g. `header.author ?? []`.
- Updated dependencies [[`ccc491e`](https://github.com/LTplus-AG/ifc-lite/commit/ccc491efac18ce496af47c91b1ef4fc04ebecca5), [`7215c2a`](https://github.com/LTplus-AG/ifc-lite/commit/7215c2a9344ede37c90680e1eb2a6c2b70c0ee3d), [`a2e5d2d`](https://github.com/LTplus-AG/ifc-lite/commit/a2e5d2d9aa578efeb6d3becdc94335650b89f67d), [`5c02af8`](https://github.com/LTplus-AG/ifc-lite/commit/5c02af8b7fda4d2fe53f79d3f00b9d192fc664d9)]:
  - @ifc-lite/data@6.0.0
  - @ifc-lite/parser@9.0.0
  - @ifc-lite/ids@3.0.3
  - @ifc-lite/mutations@2.7.1
  - @ifc-lite/lists@2.3.3

## 0.3.2

### Patch Changes

- Updated dependencies [[`00d6837`](https://github.com/LTplus-AG/ifc-lite/commit/00d68371ac6ab87fafa4bc5f0add2468a7e8a398)]:
  - @ifc-lite/data@5.3.0
  - @ifc-lite/ids@3.0.2
  - @ifc-lite/lists@2.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [[`0f5d174`](https://github.com/LTplus-AG/ifc-lite/commit/0f5d174d2fb726536d1a3a30c7e5415603db72c0), [`579b759`](https://github.com/LTplus-AG/ifc-lite/commit/579b7590bfe79cad5689cc89ab8082f95b5d6ea3)]:
  - @ifc-lite/data@5.2.0
  - @ifc-lite/parser@8.2.0
  - @ifc-lite/ids@3.0.1
  - @ifc-lite/lists@2.3.1

## 0.3.0

### Minor Changes

- [#5326](https://github.com/LTplus-AG/ifc-lite/pull/5326) [`29688df`](https://github.com/LTplus-AG/ifc-lite/commit/29688df238998baea77b3fe55afe113b40c13eae) Thanks [@louistrue](https://github.com/louistrue)! - A new `group` filter rule matches membership in an `IfcGroup` through `IfcRelAssignsToGroup`, e.g. "every AHU is assigned to a system". Presence (`isSet` / `isNotSet`) means assigned to any such group, named or not. The name ops match the group's Name. An optional `groupClass` narrows the match to groups of one IFC class, subclasses included (`IfcSystem` also covers `IfcDistributionSystem`). The rule works in search, in rule-set applicability, and in `element` requirements. `group` is also a subject for `unique` and `aggregate … by group`. The viewer's rule builders offer it as "Group".

- [#5425](https://github.com/LTplus-AG/ifc-lite/pull/5425) [`b9206c9`](https://github.com/LTplus-AG/ifc-lite/commit/b9206c94dceef0041dcf37e4cfe44cf09f4b4d7b) Thanks [@louistrue](https://github.com/louistrue)! - `idsToRuleSet` now imports a property facet that carries a `dataType` instead of refusing it. The rules don't check the data type, and each dropped check is listed in the new `droppedChecks` result field. The Data validation panel shows them under "Imported without these checks".

- [#5292](https://github.com/LTplus-AG/ifc-lite/pull/5292) [`70ad6a7`](https://github.com/LTplus-AG/ifc-lite/commit/70ad6a7c77b73d6a04a7d842a64ce4a014451e68) Thanks [@louistrue](https://github.com/louistrue)! - `idsToRuleSet` imports the simple specifications of an IDS document as rules, so an incoming deliverable can be extended with checks IDS cannot express. It never approximates. A specification whose facets have no exact rule equivalent (partOf, optional or prohibited facets, a property dataType, a pattern on an entity or attribute name, length restrictions, classification codes) is refused with every reason listed.

- [#5440](https://github.com/LTplus-AG/ifc-lite/pull/5440) [`79716f9`](https://github.com/LTplus-AG/ifc-lite/commit/79716f9828e4f57bedeaef66292233806b15edf7) Thanks [@louistrue](https://github.com/louistrue)! - Property and quantity rules, rule-set subjects, and list conditions take an `inherit` option. It works the same in search, applicability, validation and lists. With `'aggregation'`, an element with no value of its own, or on its type, takes the value of its nearest `IfcRelAggregates` ancestor, and its own value still wins. With `'type'`, a quantity also reads its type's quantity sets; properties already read the type. Leaving `inherit` unset keeps today's behaviour. `ListDataProvider` gains an optional `getAggregateParents`. The rule chips, the validation subject picker and list condition rows offer the option.

- [#5447](https://github.com/LTplus-AG/ifc-lite/pull/5447) [`94bd946`](https://github.com/LTplus-AG/ifc-lite/commit/94bd946d7a4e9ab98c5e9a950fa6e8a8e39b5316) Thanks [@louistrue](https://github.com/louistrue)! - A new `modelFact` rule and subject checks facts about an element's model rather than the element itself. Facts cover georeferencing (`georef.crs`, `georef.eastings`, …), project units (`units.length`, …) and STEP header fields (`header.author`, `header.originatingSystem`, `header.schema`, …). Every value operator works on them in search, applicability and validation. "The project is georeferenced and in millimetres" becomes an `IfcProject` rule with two model-fact conditions. The requirement-text spelling is `model.<fact>`. `MODEL_FACTS` lists the facts. The IDS export refuses model facts, because IDS has no model-level facet. The viewer's rule builders offer it as "Model fact".

- [#5291](https://github.com/LTplus-AG/ifc-lite/pull/5291) [`7e8d225`](https://github.com/LTplus-AG/ifc-lite/commit/7e8d225273d3f20d727dac879e31ac4e6ce165bb) Thanks [@louistrue](https://github.com/louistrue)! - `ruleSetToIds` exports the rules of a rule set that IDS 1.0 can express as IDS XML. It never approximates: each rule without an exact IDS equivalent is refused with every reason listed. `@ifc-lite/ids` now exports `translateXsdRegex`, the XSD-to-JavaScript regex translator its checker uses.

- [#5263](https://github.com/LTplus-AG/ifc-lite/pull/5263) [`fc6f49c`](https://github.com/LTplus-AG/ifc-lite/commit/fc6f49c79485640073b924df86a0973c691b7a5f) Thanks [@louistrue](https://github.com/louistrue)! - Fix a failing rule reporting `passRate: 100` next to `status: 'fail'` ([#5177](https://github.com/LTplus-AG/ifc-lite/issues/5177)). An `aggregate` rule now counts every applicable element that belongs to a failing group (plus any element excluded for an absent or non-numeric subject) as failed, each element once, so `failedCount`, `passedCount` and `passRate` match the verdict. A failure that no applicable element carries, such as an unmet or exceeded `cardinality` or an empty `universe` group, now reports `passRate: 0` instead of 100. This is the rule `@ifc-lite/ids` already applies ([#5212](https://github.com/LTplus-AG/ifc-lite/issues/5212)). The bump is `minor` because anything that reads these numbers will now see different values.

- [#5432](https://github.com/LTplus-AG/ifc-lite/pull/5432) [`6314cbe`](https://github.com/LTplus-AG/ifc-lite/commit/6314cbed245efb39552487307be55b6884fd0b97) Thanks [@louistrue](https://github.com/louistrue)! - Property and quantity rules can compare in SI units: `valueUnit: 'si'`, the "SI" toggle on the chip. Each value is converted with its own unit before the comparison: an explicit `Unit`, else the project unit for its measure type. This works in search, applicability and validation. `idsToRuleSet` sets it on every imported numeric check, so an imported IDS gives the same verdicts on a millimetre model as the IDS checker does. `ruleSetToIds` takes the loaded `models` and writes model-unit numeric checks to the IDS in SI. A rule whose unit can't be settled (no models, or models that disagree) is refused with the reason. The SI-units caveat note is gone. `readSubject` now also reports `valueSiScales`. `TypePropertyInfo` now declares the `unit` / `unitSiScale` its property rows already carry.

- [#5306](https://github.com/LTplus-AG/ifc-lite/pull/5306) [`4175a1e`](https://github.com/LTplus-AG/ifc-lite/commit/4175a1e0e8b055de2a5c58288a87b84c3c85c610) Thanks [@louistrue](https://github.com/louistrue)! - Rule sets can now assert the unit a value is recorded in, e.g. "Width is recorded in mm". The new `unit` requirement kind (`{ kind: 'unit', subject, unit: 'mm' }`) takes a property or quantity subject. An element passes when every value of that subject is recorded in the unit. The unit is the value's explicit unit, or the project unit for its measure type when it has none. IDS 1.0 cannot express this check. `readSubject` reports those units as `valueUnits`. A quantity's explicit `Unit` now also sets the unit label shown for it, where before the project unit was always shown. The parser's quantity records carry that explicit unit's symbol as `explicitUnit`. The Data validation editor offers the new kind as "Unit".

### Patch Changes

- [#5468](https://github.com/LTplus-AG/ifc-lite/pull/5468) [`610d7f2`](https://github.com/LTplus-AG/ifc-lite/commit/610d7f29708bb4febf7dd9a8d716a8e5e0b4dba4) Thanks [@louistrue](https://github.com/louistrue)! - Report effective entity counts and exact classes for edited rule-set models ([#5249](https://github.com/LTplus-AG/ifc-lite/issues/5249))

- [#5283](https://github.com/LTplus-AG/ifc-lite/pull/5283) [`fbda35b`](https://github.com/LTplus-AG/ifc-lite/commit/fbda35b5bbf5475fe99d85301aff728624058f8d) Thanks [@louistrue](https://github.com/louistrue)! - The text requirement parser (`parseRequirementText`) now rejects the same shapes the JSON rule-set parser rejects ([#5182](https://github.com/LTplus-AG/ifc-lite/issues/5182)). Those shapes are an aggregate with no subject and a function other than `count` (`sum() > 300`), a numeric aggregate over a multi-valued subject (`sum(material) > 1`), and a `compare` with a multi-valued side (`material = Name`). Before, the text parser accepted them, and the rule then failed at evaluation time instead of being refused while it was being written. Both parsers now call one shared check.

- [#5282](https://github.com/LTplus-AG/ifc-lite/pull/5282) [`07ed0dd`](https://github.com/LTplus-AG/ifc-lite/commit/07ed0ddaf4e527f1fff3704cc0d36e700fcde1a7) Thanks [@louistrue](https://github.com/louistrue)! - Allow the effective-entity iterator to enumerate a caller's source table domain, and make federated search filters include live deletions, creations, and class changes without scanning unrelated STEP records.
- Updated dependencies [[`35b8b23`](https://github.com/LTplus-AG/ifc-lite/commit/35b8b238821138d6c5bc94d3ad51abf832677a88), [`83284a9`](https://github.com/LTplus-AG/ifc-lite/commit/83284a947d9adb9e1ece28f9d5ee7166722be1e5), [`992f553`](https://github.com/LTplus-AG/ifc-lite/commit/992f55304ca0ec8ed5be3b4eabab429c68808a7e), [`45ddd91`](https://github.com/LTplus-AG/ifc-lite/commit/45ddd91d1cee1c261ca5f1b1d0087fb2e070690f), [`e66c849`](https://github.com/LTplus-AG/ifc-lite/commit/e66c849b6a79de9691a1e70ee3b2b593c5327fa1), [`51cb84d`](https://github.com/LTplus-AG/ifc-lite/commit/51cb84d29c5d6add21d94ffd9947f7c6884f5b39), [`52d30de`](https://github.com/LTplus-AG/ifc-lite/commit/52d30de0ae3fc8ef6322191bd1831483b93d485f), [`a250a92`](https://github.com/LTplus-AG/ifc-lite/commit/a250a928b1c8c64ac6153136772fe6c71398eee9), [`617da29`](https://github.com/LTplus-AG/ifc-lite/commit/617da29bc17326105dd1143385c967210e529a43), [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590), [`60f70f9`](https://github.com/LTplus-AG/ifc-lite/commit/60f70f93c9cdf9948f1a7325efb1e157a09d3a60), [`bd15b3f`](https://github.com/LTplus-AG/ifc-lite/commit/bd15b3f607f43ab47c8f4d530ed95231f802e15c), [`eebb00e`](https://github.com/LTplus-AG/ifc-lite/commit/eebb00e52719e0254d1626f791740ce7fe7489a9), [`d6f65a0`](https://github.com/LTplus-AG/ifc-lite/commit/d6f65a009b72bef2f11c65e2b577b4d621abd0eb), [`4041f2f`](https://github.com/LTplus-AG/ifc-lite/commit/4041f2f75ae136a400e11de5c546bb136e97e8ef), [`a341dc9`](https://github.com/LTplus-AG/ifc-lite/commit/a341dc9512531a353c12d264b806a527d8de63f6), [`52d30de`](https://github.com/LTplus-AG/ifc-lite/commit/52d30de0ae3fc8ef6322191bd1831483b93d485f), [`79716f9`](https://github.com/LTplus-AG/ifc-lite/commit/79716f9828e4f57bedeaef66292233806b15edf7), [`5665917`](https://github.com/LTplus-AG/ifc-lite/commit/566591746eead289fcc5aa60258ef96b30366456), [`253cc3e`](https://github.com/LTplus-AG/ifc-lite/commit/253cc3e96ff001b3514f182a61b1be70f6a89fa5), [`253cc3e`](https://github.com/LTplus-AG/ifc-lite/commit/253cc3e96ff001b3514f182a61b1be70f6a89fa5), [`2dd677d`](https://github.com/LTplus-AG/ifc-lite/commit/2dd677d7307d87f3b433256bd00647a2a3ee06df), [`0d9cbc0`](https://github.com/LTplus-AG/ifc-lite/commit/0d9cbc0072baa634923623c6772500d57a63f412), [`71ace41`](https://github.com/LTplus-AG/ifc-lite/commit/71ace41b0ccfde286fe7fc1074011a91c9c8d5b1), [`7e8d225`](https://github.com/LTplus-AG/ifc-lite/commit/7e8d225273d3f20d727dac879e31ac4e6ce165bb), [`6314cbe`](https://github.com/LTplus-AG/ifc-lite/commit/6314cbed245efb39552487307be55b6884fd0b97), [`07ed0dd`](https://github.com/LTplus-AG/ifc-lite/commit/07ed0ddaf4e527f1fff3704cc0d36e700fcde1a7), [`0d9cbc0`](https://github.com/LTplus-AG/ifc-lite/commit/0d9cbc0072baa634923623c6772500d57a63f412), [`80c6a38`](https://github.com/LTplus-AG/ifc-lite/commit/80c6a38a3efc8783965e94d309bcc2f984cef71d), [`4175a1e`](https://github.com/LTplus-AG/ifc-lite/commit/4175a1e0e8b055de2a5c58288a87b84c3c85c610), [`18650b0`](https://github.com/LTplus-AG/ifc-lite/commit/18650b0c67973833f675c6b8128ab55250a47efd)]:
  - @ifc-lite/mutations@2.7.0
  - @ifc-lite/data@5.1.0
  - @ifc-lite/parser@8.1.0
  - @ifc-lite/ids@3.0.0
  - @ifc-lite/lists@2.3.0

## 0.2.0

### Minor Changes

- [#5169](https://github.com/LTplus-AG/ifc-lite/pull/5169) [`06a336d`](https://github.com/LTplus-AG/ifc-lite/commit/06a336d512fc4470cb7372b33a5f8eea2aa1c070) Thanks [@louistrue](https://github.com/louistrue)! - New package: the filter-rule vocabulary, the Path-B rule evaluator, and the `.rules.json` information-validation engine (`runRuleSet`), extracted from the viewer's Advanced Filter / Data Validation panel ([#5138](https://github.com/LTplus-AG/ifc-lite/issues/5138) PR 7a) so `packages/cli` can run the identical evaluator against the same rule sets. No React, no store, no DOM.
  
  `@ifc-lite/viewer` is a private, unpublished app and gets no changeset entry — its import paths for this code moved from `lib/search`/`lib/validation` to `@ifc-lite/rules`, but that is an internal refactor with no published-API surface of its own.

### Patch Changes

- Updated dependencies [[`f87bed2`](https://github.com/LTplus-AG/ifc-lite/commit/f87bed29a52610b66b3d0ee510406ce087a66621), [`bef4149`](https://github.com/LTplus-AG/ifc-lite/commit/bef41495ccdcf1dbc8e5024f633c74b44ccef137), [`04ef10f`](https://github.com/LTplus-AG/ifc-lite/commit/04ef10fef50f8e53e96430741afc27a69ebff906)]:
  - @ifc-lite/mutations@2.6.0
  - @ifc-lite/ids@2.0.0
