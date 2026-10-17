## F3e design note (coordinator b61983f5)

Work package F3e (#7780, charter #7670): typed attribute slots in core, replacing the magic positional reads (`entity.get(8)`, `get_ref(5)`, `nth_attr(.., 9)`, …). The note is written against `origin/main` at `126320e3e8`, and every count and file:line was measured there. It designs around these open PRs:
- **#7752 (S6a):** touches `rust/core/src/schema_gen.rs`, `decoder.rs` and the server's data_model. F3e-0b starts only after it merges.
- **#7792 (F2a-G1):** touches `geometry/src/router/transforms/linear.rs`. X1 rebases over it.
- **#7789 (F1b):** touches `geometry/tests/issue_859_linear_placement.rs` and `processing/tests/issue_961_textures.rs`. Rebase only.
- **#7794 (B6b):** touches `processors/brep/*`. R-geo-b waits for it.
- **Not yet open:** F3c (#7776, sequenced after F4-1), F4 (#7778, `StepRecord`), F3a (#7775, the IFCPROJECT locator), and C6-4 (#7783 §4).

**Findings closed:** CORE-19 (by F3e-0a/0b plus the G gate) and EXPORT-DATA-18 (by R-export-a).

**Follow-ups go in this note** (§9). Per the user's directive, no new issues are filed.

### TL;DR of the decisions

1. **One source of slot truth: core's EXPRESS registry, emitted by the existing `@ifc-lite/codegen` Rust emitter (D43).** There is no new generator. `rust-schema-queries.ts` gains a per-schema `attribute_flags()` table (kind, aggregate, optional), plus one new emitter module in the same package. In the canonical run, which already parses all five schemas, that module writes `rust/core/src/generated/slots.rs`.
2. **Two slot types, chosen by the generator, so the type system enforces the schema rule:**
   - `Slot<K>` is a `const` whose position is the same in every bundled schema that declares the entity: 6,602 of 7,055 (entity, attribute) pairs. A further 152 are "trailing": the slot sits past the end of the older schemas' records, so reading it there yields `None` either way.
   - `SchemaSlot<K>` is used where the position **moves** or names something else in some schema: 301 pairs on 81 entities.
   - A `SchemaSlot` has no `index()`. It can only be read after it is resolved against a `SchemaVersion`, so a moving slot can never be read with a constant.
3. **Spelling:** `use ifc_lite_core::slot; entity.ref_at(slot::IfcProject::UNITS_IN_CONTEXT)`.
   - There is one zero-sized `pub struct` per entity, with inherited attributes **flattened** in, so `slot::IfcWall::OBJECT_PLACEMENT` exists.
   - Each const carries the value kind `K ∈ {Ref, RefList, List, Real, Int, Text, Enum, Logical, Binary, Select}`, derived from the EXPRESS type.
   - There is no macro, and no runtime lookup on hot paths.
4. **Typed accessors share F4's names on both readers.** `DecodedEntity` and `StepRecord` each get `attr`, `ref_at`, `ref_list_at`, `real_at`, `int_at`, `string_at`, `enum_at`, `logical_at` and `list_at`.
   - Each takes `impl Into<SlotIx<K>>`, and `Slot<K>` converts only into a matching kind (`Select` converts into any kind).
   - A computed `usize` is still accepted, for generic walkers.
   - A bare integer literal does not infer `usize` through the `Into` bound, so new literal reads should fail to compile. F3e-0b verifies this, and the G gate covers it if it does not.
   - F3c (`Typed`, `as_logical`, see-through `as_float`) is what gives `real_at` and `logical_at` a single meaning, hence the F3c dependency.
5. **The runtime by-name lookup is C6's contract (§6), and it is F3e's first PR.**
   - F3e-0a adds `SchemaVersion::attribute(entity, name) -> Option<AttrSlot { index, kind, aggregate, optional }>`. It is ASCII-case-insensitive, returns explicit `None`, and covers all five bundled schemas.
   - If C6-4 gets there first, C6-4 lands F3e-0a exactly as specified here. Either way there is one table and one lookup, and C6's `data_model::slots` is only a memo over it.
6. **Schema policy (D44 shape).** Core returns `None` for an unknown schema or an undeclared entity, and every caller states its own default.
   - `EntityDecoder::slot(SchemaSlot)` keeps today's documented decoder default: an unknown or undeclared `FILE_SCHEMA` reads as IFC4X3, and an entity the declared schema does not know reads as `None`.
   - Six coexisting policies are reconciled (§3, D1).
7. **Perf contract (F4's):** no phase of the native instruction ratchet may get worse than base + 0.05%.
   - Stable slots compile to the same immediate as the literal.
   - `SchemaSlot` resolution is one cached-schema branch plus a `[u8; 5]` index, and is used only on cold paths (textures, grid/linear placement, alignment, root `PredefinedType`).
   - Compile time and wasm size are measured in F3e-0b. Budgets: core build +5%, wasm +40 KB.
8. **Guard: G-F3e, a positional-read ratchet.** It is a Rust test that counts literal-index attribute reads per production file against an exact-count allowlist, using G2's semantics: a new read fails, and a removed read fails as stale until its row is lowered. The baseline is **1,329 reads in 178 files**.
9. **Migration:** 2 core PRs (F3e-0a/0b), 1 G, **1 X** (IFC4X1/4X2 linear placement and the alignment axis), and 9 byte-identical R PRs, split per crate and by hot-file owner. Router and server sites migrate inside C2 and C6, not in F3e PRs.
10. **Stop line:** F3e-0a, F3e-0b, G-F3e, X1, R-core and R-export-a. Every other R PR is optional, because the gate bounds the debt and no third copy can appear.

---

### 1. API

#### 1.1 What is generated (one generator, D43)

| Output | Emitted by | Content | Size |
|---|---|---|---|
| `generated/{ifc2x3,ifc4,ifc4x1,ifc4x2}/schema.rs` and canonical `schema.rs` | `packages/codegen/src/rust-schema-queries.ts` (existing) | **New:** `attribute_flags(&self) -> &'static [u8]`, parallel to `attribute_names()`. One byte per attribute: kind in 4 bits, `AGGREGATE` = LIST/SET/ARRAY, `OPTIONAL`. Names are not duplicated, so `attribute_names()` is unchanged. **Deleted:** `IfcType::attribute_index` (CORE-19's name collision; supersede means delete). | about +7 KB of rodata per schema |
| `generated/slots.rs` (**new**) | `packages/codegen/src/rust-slot-emitter.ts` (new module, same package, called from `generator.ts` in the canonical run, which already receives the four supplemental schemas, `generator.ts:75-99`) | `pub struct IfcProject;` and `impl IfcProject { pub const TYPE: IfcType = …; pub const UNITS_IN_CONTEXT: Slot<RefList> = …; … }` for all **1,001** entities, with flattened inherited attributes (7,055 consts); `SchemaSlot` consts for the 301 moving pairs | about 9–10k lines, generated, so the module-size rule does not apply |
| `packages/codegen/schemas/attribute-renames.json` (**new data file**, not a generator) | hand-maintained and validated by the emitter | same-position renames: Description↔Specification on the IfcProperty family and IfcComplexProperty; ItemReference/Id/DocumentId → Identification; UrlReference → URLReference; TextureType → Mode; NumberOfRiser → NumberOfRisers; RelatedSpace → RelatingSpace; ModelorDraughting → ModelOrDraughting; IfcClassification Location → Specification | about 15 rows |

**Generator rules:**
- **Naming.** A slot is named by its **canonical IFC4X3** attribute name, in SCREAMING_SNAKE (`URLReference` → `URL_REFERENCE`). An entity declared only in an older schema uses that schema's names. A name collision fails generation.
- **Classification:**
  - **stable:** the same position in every schema that declares the entity, after aliasing;
  - **trailing:** the same position where present, and past the end of the record in every schema where absent;
  - **moving:** everything else.
  - A stable or trailing slot becomes `Slot`, and a moving slot becomes `SchemaSlot`.
- **Aliases.** An alias row whose two names sit at **different** positions fails generation. That keeps a rename from ever covering a move.
- **Semantic replacements are not aliases.** CompositionType→PredefinedType (IfcBuildingElementProxy), InteriorOrExteriorSpace→PredefinedType (IfcSpace), ShapeType→PredefinedType, BarRole→PredefinedType and OperationType→PredefinedType all name a different enum. They stay moving, and the slot is `None` in IFC2X3.
- **Kind** is resolved through defined types and selects, recursively:
  - entity, or a select of entities only → `Ref`;
  - an aggregate of those → `RefList`;
  - any other aggregate → `List`;
  - REAL/NUMBER → `Real`, INTEGER → `Int`, STRING → `Text`, ENUMERATION → `Enum`, BOOLEAN/LOGICAL → `Logical`, BINARY → `Binary` (F4 D17);
  - a mixed select (for example `IfcValue`) → `Select`.
- **Freshness.** `scripts/check-codegen-sync.mjs` already regenerates these files, so the freshness gate covers them. Its test (`check-codegen-sync.test.mjs:170`) gains the canonical slots file.

#### 1.2 Core types (hand-written, `rust/core/src/slot.rs`, about 250 lines)

```rust
pub struct Slot<K> { index: u8, #[cfg(debug_assertions)] owner: IfcType, _k: PhantomData<K> }
impl<K> Slot<K> { pub const fn index(self) -> usize; }
pub struct SchemaSlot<K> { by_schema: [u8; 5] /* u8::MAX = absent */, owner: IfcType, _k: PhantomData<K> }
impl<K> SchemaSlot<K> {
    pub const fn at(self, schema: SchemaVersion) -> Option<Slot<K>>;   // explicit pin, e.g. `.at(SchemaVersion::Ifc4)`
}
pub struct SlotIx<K>(usize, PhantomData<K>);
impl<K> From<Slot<K>> for SlotIx<K>; impl<K> From<Slot<Select>> for SlotIx<K>; impl<K> From<usize> for SlotIx<K>;

impl DecodedEntity {   // the same names as F4's StepRecord
    pub fn attr<K>(&self, s: impl Into<SlotIx<K>>) -> Option<&AttributeValue>;
    pub fn ref_at(&self, s: impl Into<SlotIx<Ref>>) -> Option<u32>;
    pub fn ref_list_at(&self, s: impl Into<SlotIx<RefList>>) -> Option<Vec<u32>>;   // == get_refs semantics today
    pub fn real_at(&self, s: impl Into<SlotIx<Real>>) -> Option<f64>;            // as_float, sees through Typed (F3c)
    pub fn int_at / string_at / enum_at / logical_at / list_at (…);
}
impl EntityDecoder<'_> {
    pub fn slot<K>(&mut self, s: SchemaSlot<K>) -> Option<Slot<K>>;   // cached FILE_SCHEMA; unknown or undeclared label -> IFC4X3
    pub fn attribute_index(&mut self, entity: &str, name: &str) -> Option<usize>; // kept; re-implemented on SchemaVersion::attribute
}
impl SchemaVersion {
    pub fn attribute(self, entity: &str, name: &str) -> Option<AttrSlot>;   // C6 contract (§6)
    pub fn attributes(self, entity: &str) -> Option<impl ExactSizeIterator<Item = AttrSlot>>;
}
```

- **The `owner` check.** In debug and test builds, every typed accessor runs `debug_assert!(self.ifc_type.is_subtype_of(slot.owner))`. The whole test suite therefore checks that each migrated slot belongs to the record it reads. In release builds the field does not exist.
- **`StepRecord` (F4).** The F4-3 accessors take `impl Into<SlotIx<K>>` rather than `usize`. If F4-3 lands first, F3e-0b changes their parameter types; if F3e-0b lands first, F4-3 adopts these signatures. The `usize` conversion keeps every existing call compiling, so neither order breaks anything.
- **The old accessors stay.** `get`, `get_ref`, `get_float`, `get_string`, `get_list` and `get_refs` remain (§5 stop line). `get(usize)` is the escape hatch for computed indices.

#### 1.3 Subtypes and schema families

- **Subtypes.** EXPRESS appends subtype attributes after the supertype's. A supertype slot is therefore valid on every subtype, and the generator emits it on each subtype too, so the caller writes the record's own type.
- **Cross-schema hierarchy differences** do not matter, because classification is per (entity, name). An example is IfcProject's parent: IfcObject in IFC2X3, IfcContext in IFC4. Another is IfcAsymmetricIShapeProfileDef's parent.
- **Derived inherited attributes** (`*`, for example `IfcGeometricRepresentationSubContext.Precision`) keep their slot. The value is `AttributeValue::Derived`, exactly as today.
- **Five families.** IFC2X3_TC1, IFC4_ADD2_TC1, IFC4X1, IFC4X2 and IFC4X3 (`IFC4X3_DEV_923b0514`), matching `SchemaVersion`. IFC5/IFCX are not STEP, so they are out of scope.

#### 1.4 Cost

| Path | Before | After |
|---|---|---|
| stable read in a hot loop (`get_ref(3)`) | `attributes.get(3)` and a match | identical code: the const folds to the immediate, and `Into` is inlined. Verified by callgrind in every R PR |
| moving read (`IfcGridPlacement`, textures, `IfcLinearPlacement`, `IfcAlignment.Axis`) | `attribute_index`: header read (cached) + `from_str` + a linear name scan per call | `decoder.slot(S)`: cached schema + an array index. Cheaper than today |
| by name (C6, cold) | `attribute_names(..).position(..)` | `SchemaVersion::attribute`: the same scan with case-folding; C6 memoises the result per type |
| compile | — | about 9k consts; budget +5% on `cargo build -p ifc-lite-core`, measured in F3e-0b |
| wasm | — | flags of about 35 KB over 5 schemas, and unused consts are not emitted; budget +40 KB, reported in F3e-0b |

---

### 2. Measurement

**The scan.** The scanner is `/tmp/f3e-scripts/{layouts,scan}.py` (a throwaway; the G gate is the durable form). It ran over non-test production `.rs` under `rust/` and `apps/`, excluding `generated/`. It counted literal-index calls of `get`, `get_ref`, `get_refs`, `get_float`, `get_string` and `get_list`, plus `attributes[N]` and `nth_attr*(.., N)`.

| Crate | Literal reads (raw) | Files | After dropping list/slice receivers (heuristic) |
|---|---|---|---|
| geometry | 678 | 82 | 378 |
| processing | 298 | 45 | 238 |
| export | 161 | 26 | 128 |
| apps/server | 84 | 8 | 81 |
| core | 81 | 9 | 65 |
| wasm-bindings | 26 | 7 | 18 |
| landxml | 1 (XML, a false positive; the gate exempts the crate) | 1 | 0 |
| **total** | **1,329** | **178** | **908** (+302 in tests) |

- **Comparison with CORE-19.** CORE-19's "~1,400" is get + get_ref + get_float including tests (1,411). The like-for-like numbers today are 1,329 production reads, and 1,631 including tests.
- **Attributed reads by accessor:** get 478, get_ref 173, get_float 87, get_string 72, get_refs 47, get_list 33, `attributes[]` 10, nth_attr 8.
- **Biggest files:** `geometry/router/voids/probe.rs` 43, `geometry/alignment.rs` 34, `server/data_model/materials.rs` 33, `core/units.rs` 29, `export/step_map_transform_preflight.rs` 27, `geometry/profiles/{steel_shapes,mod}.rs` 26 each.

**By entity family.** The entity is the nearest Ifc type named within 25 lines, so these numbers are approximate. 153 reads were unattributed.

| Family | Reads | Mainly in |
|---|---|---|
| representations (ProductDefinitionShape, ShapeRepresentation, MappedItem, RepresentationMap) | 107 | processing 45, geometry 37, export 18 |
| placements, points, operators | 104 | geometry 78, processing 22 |
| curves and alignment | 97 | geometry 76, processing 17 |
| root/product/other | 96 | geometry 30, export 27, server 23 |
| presentation and texture | 80 | processing 69 |
| solids, surfaces, topology | 56 | geometry 44 |
| psets and qsets | 53 | server 22, export 20 |
| units | 48 | core 35, export 13 |
| materials | 36 | server 30 |
| relationships | 32 | export 15, processing 9 |
| project, spatial, georef | 31 | core 13, export 11 |
| profiles | 15+ (undercounted) | geometry |

**Schema dependence.** Across the bundled registries there are 1,001 entities and 7,055 (entity, attribute) pairs: 6,602 stable, 152 trailing and 301 moving (81 entities). Checked against the read sites:

| Class | Sites | Verdict |
|---|---|---|
| **Live: a wrong value in user output** | server root attributes via the generated IFC4 table (`attr_indices.rs:4907` IfcSpace `predefined_type: 9` …) | On IFC2X3 files, IfcSpace reports InteriorOrExteriorSpace as PredefinedType. IfcBuildingElementProxy reports CompositionType (8), IfcTransportElement OperationType (8), IfcReinforcingBar BarRole (12), and IfcRamp/IfcRoof/IfcStair ShapeType (8). The TS columnar parser does the same. This is SERVER-28's bug half, **owned by C6-opt-b (D43)**. F3e supplies the `SchemaSlot` that resolves to `None` there. |
| **Live: type-guarded loss** | `IfcLinearPlacement` at IFC4X3 positions: `geometry/router/transforms/linear.rs:102,200`, `processing/analytic_export/placement.rs:63-64`, `export/step_map_transform_preflight.rs:296` | On IFC4X1 and IFC4X2 files, slot 1 is Distance or PlacementMeasuredAlong, and slot 2 is Orientation or Distance. The type checks reject both, so an authored `CartesianPosition` (4X1 slot 3, 4X2 slot 4) is never read and the product falls back. **X1.** |
| **Live: position guess** | `geometry/alignment_axis.rs:25` probes `[7, 8, 6]` for `IfcAlignment.Axis` | Axis is 7 in 4X1/4X2 and absent in 4X3, where 7 is PredefinedType. Slot 8 is PredefinedType in 4X1/4X2. It works by type-filtering refs. **X1.** |
| **Latent: not reachable in a conforming file** | `geometry/processors/texture/mod.rs:114,138-140,153,199`; `processing/appearance/texture_budget.rs:39,43`; `evaluated_allocation.rs:22` (`IfcImageTexture => [3]`) | In IFC2X3 every IfcSurfaceTexture slot after 1 is one lower. These readers are reached only through `IfcIndexedTriangleTextureMap`, which is IFC4+, so an IFC2X3 file never gets here. **R** with an explicit `.at(SchemaVersion::Ifc4)` pin and a comment; no behaviour change. |
| **Benign: fails to None** | `server/data_model/documents.rs:33,57` (IfcDocumentInformation slot 3 is DocumentReferences in IFC2X3, so `get_string` is None); IfcMaterial.Category and IfcMaterialLayer.Category; IfcPropertyBoundedValue.SetPointValue; `IfcCartesianPointList2D.TagList` (trailing) | R |
| **Handled already** | `IfcGridPlacement` through `EntityDecoder::attribute_index` (`geometry/router/transforms/grid_frame.rs:36,75`, `processing/analytic_export/placement.rs:42,52,98`) | R: becomes `decoder.slot(slot::IfcGridPlacement::PLACEMENT_LOCATION)`. The module doc at `core/decoder/schema_layout.rs:10` says "gained PlacementRelTo in IFC4X1", but the registry has it from **IFC4X2**. Fixed in F3e-0a. |

**Geometry-resource entities are stable.** Apart from IfcGridPlacement, IfcLinearPlacement, IfcAlignment and the textures, every geometry entity the router reads is stable across all five schemas. That covers placements, points, curves, solids, profiles, representations, styles and units; the profile-def differences are trailing only (IFC2X3 `CentreOfGravity*`). So the hot paths get `const` slots and pay nothing.

---

### 3. Drift reconciliation list

| # | Drift | Sites | Canonical choice | Class / PR |
|---|---|---|---|---|
| D1 | **Six schema policies for "position of attribute X":** (a) literal integers, implying IFC4/4X3 positions, everywhere; (b) the canonical IFC4X3 layout whatever the file declares (`IfcType::attribute_index`: `server/property_value.rs:26`, export `step_log/base.rs:256`); (c) the file schema, falling back to IFC4X3 when unknown (`EntityDecoder::attribute_index`); (d) the file schema, fail closed (`export/rebar_attributes.rs:28`, `model_props.rs:106`, `schema_convert.rs:171`); (e) IFC4_ADD2_TC1 for every file (`server/generated/attr_indices.rs`, TS columnar); (f) a union across schemas (`server/generated/relationship_slots.rs`); plus file-then-canonical (`step_log/generate.rs:142`) | 1 + 3 + 6 + 3 + 2 + 2 | Core gives `Slot` (schema-independent by construction), `SchemaSlot` (must be resolved), and `SchemaVersion::attribute` (explicit `None`). The policy is stated at each call site. (b) becomes `SchemaVersion::Ifc4x3.attribute(..)` byte-identically; (e) and (f) are deleted by C6-4 | R (F3e-0a, C6-4); bug half → C6-opt-b |
| D2 | **Case rule:** case-insensitive (`schema_layout.rs:53`) vs case-sensitive (`IfcType::attribute_index`, `rebar_attributes.rs:30` `==`) | 3 | ASCII-case-insensitive (C6 contract). Every caller passes a literal PascalCase name, so there is no output change | R |
| D3 | **IfcProject.UnitsInContext (8), 7 copies** | `core/units.rs:50,257,356,448`, `core/project_units/mod.rs:69`, `export/landxml_terrain_georef.rs:145`, `export/step_log/units.rs:132` (string slots) | `slot::IfcProject::UNITS_IN_CONTEXT`. **F3a's single locator owns the call**: if F3a lands after F3e-0b it uses the slot, otherwise R-core converts the survivors | R |
| D4 | **IfcLinearPlacement at 4X3 positions in 3 crates** | §2 | `SchemaSlot` for RELATIVE_PLACEMENT and CARTESIAN_POSITION through `decoder.slot`. 4X1/4X2 `CartesianPosition` is honoured; `RelativePlacement` is `None` there, so it falls back exactly as now | **X1** |
| D5 | **IfcAlignment.Axis probe `[7,8,6]`** | `geometry/alignment_axis.rs:25` (shared by wasm `alignment_lines.rs`) | `decoder.slot(slot::IfcAlignment::AXIS)`, then the off-schema publisher tolerance at **8**, kept as one named const with a test, then `REPRESENTATION`. 4X3 files stop probing slot 7 (PredefinedType) | **X1** |
| D6 | **Texture readers at IFC4 positions; IFC2X3 is one lower** | §2 | `SchemaSlot::at(SchemaVersion::Ifc4)` pin, with a comment that texture maps exist only in IFC4+ | R (R-geo-b, R-proc-a) |
| D7 | **Server vs export root attributes on IFC2X3** | server: `predefined_type` = InteriorOrExteriorSpace (IFC4 table); export `model_props::render_attributes`: per source schema, which emits `InteriorOrExteriorSpace` under its own name | Not F3e's: C6 row 16 / D43 keep the server's IFC4 positions until C6-opt-b. Recorded so that no F3e R PR "fixes" it by accident | C6-opt-b (X + TS twin) |
| D8 | **Same slot, many copies, one mechanism each** | IfcProductDefinitionShape.Representations(2) ×14 (geometry 7, processing 5, export 2); IfcCartesianPoint.Coordinates(0) ×13; IfcMappedItem.MappingSource(0) ×12 (4 crates); IfcSIUnit.Prefix(2) ×11 (core 7, export 4); IfcAxis2Placement3D.Location(0) ×11; IfcShapeRepresentation.Items(3) ×10; IfcRelDefinesByType.RelatingType(5) ×6 (3 crates); IfcPropertyBoundedValue Upper/Lower ×5 each (3 crates) | the same `slot::` const everywhere. Positions agree today; no value drift was found | R per crate |
| D9 | **Unknown-type fallback rows** | `server/data_model/metadata.rs:19` `UNKNOWN_TYPE_FALLBACK` (0,2,3,4,**7**,–) | unchanged in F3e (C6-4 replaces it with `RootSlots` over F3e-0a). Note: slot 7 is LongName, not Tag, on spatial elements | C6-4 |
| D10 | **Docs claim the IFC2X3/4/4X3 families only** | `docs/api/rust.md:199` vs `SchemaVersion::from_file_schema` (also 4X1, 4X2) | docs fixed in F3e-0a | docs |

---

### 4. Migration order

| PR | Class | Crate(s) | What | Est. size | Depends on | Conflicts / ownership |
|---|---|---|---|---|---|---|
| **F3e-0a** | R + break #11 append | codegen, core, server (1 site), docs | `attribute_flags()` in the 5 registries; `SchemaVersion::{attribute, attributes}`; `AttrSlot`; delete `IfcType::attribute_index` (callers: `server/property_value.rs:26` → `SchemaVersion::Ifc4x3.attribute`, plus core and export tests); `EntityDecoder::attribute_index` re-implemented on it; schema_layout doc fix (D3 of §2); exhaustive tests (every flag equals the EXPRESS declaration; every name lookup equals `attribute_names` position) | ~600 hand + regenerated flags | — (not F3c) | `schema_gen.rs`/decoder: after #7752. **This is C6-4's prerequisite: whichever lane gets there first lands it as written** |
| **F3e-0b** | R (additive) | codegen, core | `rust-slot-emitter.ts` → `generated/slots.rs`; `attribute-renames.json`; `slot.rs` (`Slot`, `SchemaSlot`, `SlotIx`, kinds); typed accessors on `DecodedEntity`; `EntityDecoder::slot`; `StepRecord` signatures if F4-3 is in; generator tests (stable/trailing/moving classification re-derived independently in Rust from `attribute_names` per schema; alias same-position check; literal-inference compile-fail doctest); compile-time and wasm-size report | ~900 hand + ~10k generated | F3e-0a, **F3c** (accessor semantics), #7752 | F4-3 (`parser/record.rs`): the second to land adapts |
| **G-F3e** | G | processing tests, CI-free (`cargo test`) | `rust/processing/tests/positional_read_ratchet.rs` + `positional_read_allowlist.txt` (§5) | ~250 + 178 rows | F3e-0b (so the error text can name the replacement) | machinery cap: the only machinery lane in its wave |
| **X1** | X | geometry, processing, export | IFC4X1/4X2 `IfcLinearPlacement` + `IfcAlignment.Axis` through `SchemaSlot` (D4, D5). Regression tests first: synthetic IFC4X2 and IFC4X1 files with `CartesianPosition`, which today are unplaced or refused and afterwards placed; an IFC4X3 alignment with a ref-shaped value in slot 7 that is no longer probed. Expected corpus fingerprint delta: empty (no 4X1/4X2 files in the corpus); the lane proves it. No TS twin (geometry is Rust/wasm) | ~250 + fixtures | F3e-0b, #7792 merged, F3b X1/X2 (placement walk) merged or rebased | `router/transforms/linear.rs` is F3b's file in wave 3: X1 lands after F3b-X2 |
| **R-core** | R | core | `units.rs`, `project_units`, `georef*`, `decoder/precision.rs`, `schema_layout.rs` (81 reads, 9 files) | ~300 | F3e-0b; **after F3a's units PRs** (D3) | F4 owns `parser/*`, `fast_parse*`, the decoder fast accessors and `model_bounds.rs`: not touched here; F4 lanes write slots once G-F3e is in |
| **R-export-a** | R | export | DecodedEntity sites: `model*.rs`, `csv.rs`, `ifc5.rs`, `relationships.rs`, `constructions.rs`, `rebar_*`, `quantity_analysis*`, `landxml_terrain_*`, `step_map_*` (EXPORT-DATA-18); goldens byte-identical | ~500 | F3e-0b | land **before C6-7/C6-8** so C6 moves slot code verbatim; if C6-8 is first, the slot-ification rides in `data_model` instead and this PR shrinks |
| R-export-b | R | export | string-level sites on `StepRecord::attr(slot)`: `merged/spatial.rs:114`, `step_log/units.rs:132`, refilter/readers | ~150 | F4 M-export-a | F4 owns `step_log/*`, `merged/*` until then |
| R-proc-a | R | processing | `appearance/*`, `style/*`, `element/*` (presentation/texture 69 + D6 pins) | ~400 | F3e-0b | C6-15 (`appearance/{authored,page_material}`): whichever is second rebases |
| R-proc-b | R | processing | `symbolic/*`, `analytic_export/*` (except X1's lines), `prepass.rs`, `processor/*` except `mod.rs`/`batch.rs` | ~450 | F3b P-PRs | `processor/mod.rs`, `batch.rs` → C4 (wave 5) does those itself |
| R-geo-a | R | geometry | `profiles/{steel_shapes,shapes,mod,placement}.rs` | ~300 | F3b X3a (`profiles/placement.rs`) | `profiles/curves*` → C1a writes slots (gate-enforced), not this PR |
| R-geo-b | R | geometry | `processors/*` (advanced_face, swept, brep, tessellated, texture (D6), helpers, extrusion_params, sectioned_positions) | ~500 | #7794 merged | — |
| R-geo-c | R | geometry | `alignment*.rs`, `curve_source.rs`, `transform*.rs`, `analytic/*` | ~400 | X1, F3b | C1d (alignment math): the second to land rebases |
| R-wasm | R | wasm-bindings | 26 reads, 7 files, internal only (D12) | ~120 | F3e-0b | C4 `gpu_meshes` |
| (in C2) | R | geometry | `router/*`, including `voids/probe.rs` (43) and `rtc_offset*` | — | — | **C2 owns these hot files (D39).** C2 lanes write slots in new and moved code; leftovers go into C2-11 |
| (in C6) | R | processing::data_model | the server's 84 reads move with C6-6a/b/c and are slot-ified in C6-8's clean-up, or in one `R-data-model` (~250) right after C6-6c | — | — | C6 owns `data_model/*` |

**Order:**
1. F3e-0a (wave 2–3; it unblocks C6-4).
2. F3e-0b once F3c is in.
3. G-F3e.
4. X1.
5. R-export-a and R-core.
6. The rest in parallel as Sonnet lanes, highest bug risk first. Bug risk means files with moving slots or by-name policy: R-proc-a (textures), then R-geo-c (alignment), then R-geo-b, R-proc-b, R-geo-a, R-wasm, R-export-b.

Every R PR shows: fingerprint byte-identical over the §1.2 corpus, insta unchanged, export goldens unchanged, `mesh_determinism` green, a callgrind phase table (≤ base + 0.05%), and the allowlist rows lowered.

**Totals:** 13 F3e PRs (2 core, 1 G, 1 X, 9 R), with about 1,329 → under 400 reads remaining at the stop line (router and data_model wait for C2 and C6).

---

### 5. Guard: G-F3e, the positional-read ratchet

- **Home:** `rust/processing/tests/positional_read_ratchet.rs`, next to G4. It reuses `common::source_walk::production_sources`, so the exemptions are the same: `generated/`, `tests/`, `benches/`, `examples/`, `fuzz/`, `*_tests.rs`, and `#[cfg(test)]` items. The landxml crate is exempt (XML, no STEP). It runs inside `cargo test --workspace`, which is already a required check, so no workflow edit is needed.
- **What counts:** a literal integer as the index argument of the attribute accessors: `get`, `get_ref`, `get_refs`, `get_float`, `get_string`, `get_list`, every F4/F3e `*_at`, `attr`, `is_present`, plus `attributes[N]`, `attributes.get(N)` and `nth_attr*(.., N)`.
  - `.get(N)` on a plain slice is counted too, and the existing 1,329 already include such reads.
  - A new slice read should use `first()`, a pattern, or the line marker `// not-an-attribute`. The ratchet counts markers separately and prints them, so review sees every one.
- **Allowlist:** `rust/processing/tests/positional_read_allowlist.txt`, one row per file, `<count> <path>`, seeded with 178 rows and 1,329 reads.
  - **Exact count, as in G2:** a new read fails ("use `slot::<Entity>::<ATTR>`"), and a lowered count fails as stale until the row is lowered or deleted. The debt therefore only shrinks.
  - A moved file carries its row; the ratchet fails on a path that no longer exists.
- **Anti-vacuity, as in G4:** a floor on files walked and on matches found at seed. A missing root is a hard error, and skipping is refused under CI.
- **G evidence:** at the F3e-0b parent, adding `entity.get_ref(3)` to `geometry/src/profiles/shapes.rs` fails. Converting one site in that file without lowering the row fails as stale. The seeded tree passes.
- **Progress metric (§1.5):** the allowlist total is added to the per-wave numbers.

---

### 6. The contract with C6 (C6 note §4–§5), restated as F3e's API

| C6 needs | F3e provides | PR |
|---|---|---|
| per-(SchemaVersion, entity) name → slot, ASCII-case-insensitive, amortised O(1), every IFC2X3/4/4X1/4X2/4X3 entity | `SchemaVersion::attribute(entity, name) -> Option<AttrSlot>`; C6 memoises per type (its `FxHashMap`) | F3e-0a |
| `aggregate: bool` per attribute | `AttrSlot::aggregate` (plus `kind`, `optional`) from `attribute_flags()` | F3e-0a |
| explicit `None` for unknown schemas and entities | `SchemaVersion::from_file_schema` → `None`; `attribute` → `None` | F3e-0a |
| F3e adopts `data_model::slots`, no parallel lookup | `data_model::slots` **is a memo over `SchemaVersion::attribute`** from day one, so "re-homing" is a no-op. `RootSlots`/`RelSlots` may later use `slot::` consts where the type is static | C6-4 |

**If F3e stalls after F3e-0a,** C6 has everything it needs, the generated server tables still die in C6-4, and nothing is copied a third time. **If F3e stalls before F3e-0a,** C6-4 lands F3e-0a itself, per this section.

---

### 7. Stop line

- **Required:** F3e-0a, F3e-0b, G-F3e, X1, R-core, R-export-a.
  - CORE-19 is marked `fixed` when F3e-0a, F3e-0b and G-F3e have merged: the typed layer exists, the colliding API is gone, and the debt is bounded.
  - EXPORT-DATA-18 is marked `fixed` at R-export-a.
- **Optional (D8 style):** R-export-b, R-proc-a/b, R-geo-a/b/c, R-wasm, R-data-model, and **removing** `DecodedEntity::{get_ref, get_float, get_string, get_list, get_refs}(usize)` once their gate count reaches 0. Removal is a Rust major and folds into C10 (D6).
- **Safe at any stall:** one table (the EXPRESS registry) feeds `attribute_names`, `attribute_flags`, `slots.rs` and `SchemaVersion::attribute`. Unmigrated files keep their allowlist rows and their literal reads, which agree with the slots by construction (§2: no position drift found on stable slots), so a stall leaves debt but no third copy.
- **Out of scope:**
  - `export/generated/{ifc2x3,ifc4}_required_slots.rs` and `step_log_tables.rs`: TS-fed parity tables (D5). Their Rust half could later be derived from `attribute_flags().optional` (§9).
  - The TS registries and TS columnar root slots: C6-opt-b.

---

### 8. Docs touched

- `docs/api/rust.md`:
  - remove `IfcType::attribute_index` (:175);
  - add `slot::`, `Slot`/`SchemaSlot`, the typed accessors, `SchemaVersion::attribute`;
  - correct the bundled family list (:199, adding 4X1/4X2).
- `rust/AGENTS.md`: the rule "read attributes through `slot::<Entity>::<ATTR>`; moving slots through `decoder.slot`; never a literal index (G-F3e)", plus where the allowlist lives.
- `packages/codegen/README.md` and `INTEGRATION.md`: the new Rust outputs (`attribute_flags`, `generated/slots.rs`, `attribute-renames.json`).
- `rust/core/src/decoder/schema_layout.rs` module doc (IFC4X2, not 4X1); the `generated/schema_registry.rs` header (hand-written selector over generated registries).
- The ratchet's own module doc. `rust-major-offset.json`: append the F3e-0a break (`IfcType::attribute_index` removed) to break #11.

---

### 9. Follow-ups recorded here (no new issues, per the user's directive)

1. **C6-opt-b:** the server and TS PredefinedType on IFC2X3 (D7) should use `SchemaSlot` resolution plus the TS twin. The data is listed in §2.
2. **L-export:** derive the Rust half of `generate-ifc{2x3,4}-required-slots.mjs` from `attribute_flags().optional`, and keep a parity test against the TS table. Only if D5 parity holds.
3. **C10:** delete the untyped `get_*` accessors once the gate counts for them reach 0.
4. **Later wave:** decide whether the IfcAlignment `8` publisher tolerance (D5) has any real-world file behind it. If none appears in a later wave's corpus, drop it in an X PR.

---

### 10. The three most likely failure modes

1. **A wrong slot chosen during a "mechanical" R conversion.** The literal was an index into a different record than the lane assumed: a select-typed receiver (Axis2Placement 2D vs 3D), a list member, or a subtype.
   - Guard: `Slot` carries `owner` in debug builds and every typed accessor asserts `is_subtype_of(owner)`, so the whole test suite becomes a check.
   - R PRs must also show the fingerprint, insta and goldens byte-identical, and the reviewer gets a per-site table: old literal, slot, `index()` equal.
2. **Generator misclassification or a bad alias.** A moving slot emitted as stable, or an alias that hides a semantic change, would silently misread older-schema files.
   - Guards: F3e-0b re-derives the classification independently in Rust from `attribute_names` for all 5 schemas and asserts equality. Aliases must be same-position, or generation fails. Semantic replacements are listed as non-aliases in the data file's header.
   - The IFC4 edition question (ADD2_TC1 here vs the TS registry) is C6-4's exhaustive equality test; a mismatch stops for the maintainer.
3. **Perf or merge friction.** Someone resolves `SchemaSlot` or calls `SchemaVersion::attribute` inside a per-entity hot loop. Or the exact-count ratchet and the hot-file owners (C2, C4, C6, F3a, F4) collide on the same files.
   - Guards: callgrind phase tables in every R PR (F4's ±0.05% contract), and a review rule that `decoder.slot` is hoisted out of loops.
   - Migration is sliced by the ownership table (§4), and router/data_model sites migrate inside C2 and C6. The ratchet's stale-row failure is fixed by lowering one row: that is the intended coupling, and it only ever pushes the count down.

---

### Decisions to record

- **D49 (F3e):** slots come from core's EXPRESS registry through the existing codegen Rust emitter (`rust-schema-queries.ts` plus a `rust-slot-emitter.ts` module in the same generator). There is no new generator, and `IfcType::attribute_index` is deleted.
- **D50 (F3e):** the slot is named by the canonical IFC4X3 attribute name. Same-position renames go in `attribute-renames.json`, which the generator validates. Different-enum replacements (CompositionType, ShapeType, BarRole, OperationType, InteriorOrExteriorSpace → PredefinedType) are never aliases.
- **D51 (F3e):** `Slot<K>` (a const) for stable and trailing slots; `SchemaSlot<K>` (must be resolved, no `index()`) for moving ones. The generator classifies them, and a Rust test re-derives the classification.
- **D52 (F3e):** the typed accessors use F4's names on both `DecodedEntity` and `StepRecord`, taking `impl Into<SlotIx<K>>`. They are kind-checked, `usize` still works for computed indices, and `owner` is asserted in debug builds.
- **D53 (F3e):** the runtime lookup `SchemaVersion::attribute` (ASCII-case-insensitive, explicit `None`, with aggregate, kind and optional) is F3e-0a and is C6-4's prerequisite. Whichever lane is first lands it as written. `data_model::slots` is a memo over it.
- **D54 (F3e):** decoder resolution keeps today's default: an unknown or undeclared `FILE_SCHEMA` reads as IFC4X3, and an entity undeclared in the declared schema reads as `None`. Texture slots are pinned to IFC4 explicitly, because texture maps are IFC4+.
- **D55 (F3e):** G-F3e is an exact-count per-file positional-read ratchet in `rust/processing/tests`, with G2 semantics. The baseline is 1,329 reads in 178 files.
- **D56 (F3e):** the only F3e X PR is X1, covering IFC4X1/4X2 IfcLinearPlacement and IfcAlignment.Axis. The IFC2X3 PredefinedType bug stays with C6-opt-b, and router and data_model migration stays with C2 and C6.

**Needs the maintainer:**
- (a) Accept X1's user-visible effect: IFC4X1/4X2 linear placements with `CartesianPosition` now place their products, and 4X3 alignments stop probing slot 7.
- (b) Confirm that removing the untyped accessors is C10 material, not campaign-required.
- (c) Confirm or overrule keeping the off-schema `IfcAlignment` slot-8 tolerance.
