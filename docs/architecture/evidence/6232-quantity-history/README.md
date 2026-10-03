# #6232 quantity metadata history repair

The final real-model browser Room cut exposed three substantive Undo differences:
GrossFloorArea and NetFloorArea changed from `IfcQuantityArea` to
`IfcQuantityCount`, and GrossVolume changed from `IfcQuantityVolume` to Count.
Values and persistent product geometry were restored. This evidence concerns the
quantity classes and metadata, independently of synthetic export-generated
Pset/Qto identities.

`viewer-before.log` contains the actual test stdout on the unmodified integrated
base: the Bonsai native-mesh Room cut and source-backed, authored, and legacy
quantity controls failed. The source-backed fixture materializes a canonical
quantity set in the retained real Bonsai IFC bytes before reparsing it; no source
quantity is invented by an assertion. The native control reports the three
exported Area/Volume-to-Count changes. `quantity-unit-before.log` separately shows
an existing supported metre unit (#2) exported as `$`. Build chatter is omitted;
test stdout and assertion differences are preserved.

The repaired controls include a mounted registered Room command through the real
native DCEL and an adapter control meshing actual Bonsai IFC geometry through the
native worker. Both compare exported quantity classes and values through cut,
Undo and Redo. Typed source/authored replay, legacy value-only replay, explicit
unit clearing, omitted-unit inheritance and serialized forward-journal replay
are covered separately. The final setter controls use explicit `null` to clear
a unit; the earlier quantity-history controls omitted the unit to exercise the
original replay failure. Omitted units now preserve existing source and authored
units consistently.

Reproduce from the repository root:

```sh
TEST_PATTERN='mutation-quantity-history|store-adapter-room-native|commands/room-layout' pnpm test --filter=@ifc-lite/viewer --env-mode=loose
pnpm test --filter=@ifc-lite/mutations --filter=@ifc-lite/export
pnpm typecheck
pnpm lint
```

`receipt.json` records the actual results and local log paths. Existing optional
fixture skips in the complete package suites are retained; the selected native
viewer controls have no skips. Quantity export reuses the existing property
unit resolver for its supported unit names. This does not claim broader unit
discovery or a redesign of source `CollectedQuantity.explicitUnit` parsing.
Older history never recorded prior metadata: its Undo restores the value while
retaining currently effective metadata, rather than guessing a prior type.
