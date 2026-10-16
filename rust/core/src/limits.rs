// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounds on walks over file-supplied entity references, plus the
//! large-coordinate threshold every crate gates the RTC re-base on
//! ([`LARGE_COORD_THRESHOLD_METERS`]).
//!
//! A cap bounds one path's LENGTH only. A walk that can revisit also needs a
//! cycle guard, and one that fans out over a DAG also needs a work budget; the
//! three are not interchangeable and choosing wrongly fails silently in both
//! directions. The rule for picking, and the scope rule for the visited set,
//! are in AGENTS.md under "Bounding walks over file-supplied references" —
//! there rather than here, because whoever needs it is adding a NEW walk
//! somewhere else and will not open this file.

/// Maximum `IfcMappedItem` → `IfcRepresentationMap` → `MappedRepresentation.Items`
/// nesting any walk in this workspace will follow.
///
/// Shared because three crates walk the SAME chain and their bounds must agree:
/// `ifc_lite_processing::element`, `ifc_lite_geometry::router::processing` and
/// `ifc-lite-wasm`'s styling colour resolver.
///
/// Disagreement fails SILENTLY, which is why it is worth making structural. A
/// mid-review revision of #2864 held 16 against the router's 32: an element
/// whose chain was 17 to 32 links long would have rendered its geometry and
/// quietly lost its authored colour. That was caught before merge and never
/// shipped — the point is that nothing except a reviewer's attention was
/// stopping it.
///
/// `ifc_lite_processing::symbolic::item_walk::MAX_ITEM_DEPTH` also walks this
/// chain and asserts equality with this constant, but deliberately keeps its
/// own name: it charges `depth + 1` for `IfcGeometricSet` elements and
/// `IfcCompositeCurve` segments as well, so an equal number does not mean equal
/// reach. It is never more permissive than this one.
///
/// A walk over this chain also needs a cycle guard; the cap alone is not
/// sufficient (see the module docs above for which kind).
pub const MAX_MAPPED_ITEM_DEPTH: u32 = 32;

/// Maximum `IfcLocalPlacement.PlacementRelTo` chain any walk in this workspace
/// will follow. A chain longer than this composes only its first
/// `MAX_PLACEMENT_DEPTH + 1` placements and the rest is dropped — silently, on
/// every site that uses it.
///
/// Shared because two walks follow the SAME attribute of the SAME entity and
/// their bounds must agree: `ifc_lite_geometry::router::transforms` (the mesh
/// path) and `ifc_lite_geometry::profile_extractor` (the 2D drawing path).
/// They disagreed — 32 against 100 — and because both exceed-branches return
/// the IDENTITY rather than an error, an element on a 33-to-101-link chain was
/// drawn in two different places by the two paths with nothing reported. #2873
///
/// ## Why 100 and not 32
///
/// The 32 carried the rationale "keep low for WASM — each frame uses ~2KB+ of
/// stack". The wasm bundles are linked with `-zstack-size=8388608`
/// (`.cargo/config.toml` and both extra bundles in `scripts/build-wasm.sh`), so
/// the budget is 8 MiB and the cap's own worst case is ~0.1% of it; native
/// hosts give the geometry pool 256 MiB (`rust/ffi`, `rust/python`). Measured
/// rather than assumed: see the frame figures in #2873. `PlacementRelTo` is a
/// single reference, so this walk has fan-out 1 and costs O(depth) — the
/// breadth blow-up that makes a depth cap the wrong instrument elsewhere (see
/// AGENTS.md) does not apply here.
///
/// The two candidates are not symmetric. Equalising UP lets the mesh path
/// compose chains it currently flattens; equalising DOWN would make the 2D path
/// start flattening chains it composes correctly today, silently. Across the
/// 111 fixtures in `tests/models` that contain placements the deepest chain is
/// 7 links, so neither value binds on any file in the corpus and the choice is
/// decided entirely by which failure is worse on a file that does exceed it.
///
/// This bounds one path's LENGTH only. A walk over a chain that can revisit
/// also needs a cycle guard; see the module docs above.
pub const MAX_PLACEMENT_DEPTH: usize = 100;

/// The large-coordinate threshold (metres): a world coordinate whose magnitude
/// exceeds this needs RTC re-basing before it is cast to f32, or the model
/// renders with vertex jitter.
///
/// Shared because every crate that decides "is this model far from the
/// origin" must draw the line in the same place: a copy that drifts fails
/// silently (one side re-bases, the other does not, and the two frames differ
/// by the whole offset). It lives in `ifc_lite_core` because core's own
/// placement-bounds scan needs it and cannot import from above;
/// `ifc_lite_geometry` re-exports it under the same name.
///
/// Prefer [`coord_is_large`] to comparing against this directly, so the
/// comparison (strictly greater, any axis, absolute value) also has one home.
///
/// ## Why 1 km and not 10 km (#4934)
///
/// The line is precision-derived, not distance-derived: it is the point past
/// which the f32 store the mesh path casts into loses more than a BIM
/// tolerance. f32 has a 24-bit mantissa, so its ULP near `x` is
/// `2^(exponent(x) - 23)`; at 1 km that is ~0.061 mm, and at the old 10 km
/// line it is ~0.5-1 mm — comparable to the flush-face tolerances authoring
/// tools actually hit, so two faces meant to be coincident round to
/// *different* f32 lattice nodes and z-fight (#4934's report: 6.3 km survey
/// coordinates, ~0.26 mm ULP, visible speckle over every join). 1 km keeps
/// worst-case quantization at a fraction of a millimetre while matching the
/// existing `NEAR_ORIGIN` band in `rust/geometry/src/router/rtc_offset.rs`,
/// so a model just inside the line and the detector's own "already near the
/// origin" judgment agree.
pub const LARGE_COORD_THRESHOLD_METERS: f64 = 1000.0;

/// True when any component of `point` (metres) lies strictly beyond
/// [`LARGE_COORD_THRESHOLD_METERS`] from the origin.
#[inline]
pub fn coord_is_large(point: (f64, f64, f64)) -> bool {
    point.0.abs() > LARGE_COORD_THRESHOLD_METERS
        || point.1.abs() > LARGE_COORD_THRESHOLD_METERS
        || point.2.abs() > LARGE_COORD_THRESHOLD_METERS
}

/// What an RTC detector concluded about a model's coordinates. The anchor and
/// the decision travel together because the decision is not a property of the
/// anchor: the placement-bounds scan decides on the bbox CORNERS and answers
/// with the bbox CENTRE, which can be inside the threshold (8.5 km centre, 15 km
/// corner) or even the origin, while the coordinates still need re-basing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RtcVerdict {
    /// Every coordinate judged is inside the threshold: nothing to subtract.
    Small,
    /// Some coordinate is past the threshold: subtract `anchor` before the f32
    /// cast, whatever the anchor's own magnitude.
    Large { anchor: (f64, f64, f64) },
}

impl RtcVerdict {
    /// For a detector whose anchor IS its evidence (the job sampler's median).
    #[inline]
    pub fn of_anchor(anchor: (f64, f64, f64)) -> Self {
        if coord_is_large(anchor) {
            Self::Large { anchor }
        } else {
            Self::Small
        }
    }

    /// The translation to subtract: the anchor when large, zero when small.
    #[inline]
    pub fn offset(self) -> (f64, f64, f64) {
        match self {
            Self::Small => (0.0, 0.0, 0.0),
            Self::Large { anchor } => anchor,
        }
    }
}

/// How deep an `IfcComplexProperty`'s `HasProperties` walk descends. A member
/// past it is not read; its value says so with
/// [`complex_property_depth_marker`].
///
/// The `IfcComplexProperty` walk has three copies that must write the same
/// value for the same file: the server's data model
/// (`apps/server/src/services/data_model/property_value.rs`), the Rust STEP
/// exporter's property base (`ifc_lite_export` `step_log/base.rs`) and the
/// browser's `resolveComplexPropertyValue`
/// (`packages/parser/src/property-complex-value.ts`). The two Rust copies take
/// every bound, marker and charge from here; the TypeScript twin mirrors
/// [`ComplexPropertyBudget`] method for method, and one shared vector
/// (`packages/parser/test/fixtures/complex-property-budget-7675.json`) pins
/// all three (#7675).
pub const MAX_COMPLEX_PROPERTY_DEPTH: usize = 8;

/// Nested members one top-level complex property may read across all its
/// levels. The depth cap bounds a path's LENGTH only: a member listing itself
/// `k` times is `k^8` reads. Output accumulates (the same member down two
/// branches is two real parts), so a visited set would drop real members; a
/// work budget is the right bound (AGENTS.md "Bounding walks").
pub const MAX_COMPLEX_PROPERTY_MEMBERS: usize = 1024;

/// The floor of a model's complex-property output budget
/// ([`complex_property_output_budget`]), so a small file can still carry
/// ordinary complex properties in full.
pub const COMPLEX_PROPERTY_OUTPUT_BYTES: usize = 1 << 20;

/// Output bytes a model's complex properties may cost per input byte, above
/// the [`COMPLEX_PROPERTY_OUTPUT_BYTES`] floor. An honest member costs the
/// walk about its own record's length (its name and value, once as a part,
/// once as a `values`/`members` entry, once more in the joined level, plus
/// [`COMPLEX_PROPERTY_MEMBER_BYTES`]), and its record is longer than that, so
/// 4 leaves room for a member shared by a few properties. What it binds is
/// reuse: one complex property listed by many sets, or one long member listed
/// by many complex properties, which built 685 MB from 10.7 KB (#7675).
pub const COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE: usize = 4;

/// What a read member costs before its text: its `members` / `values` entry.
/// Without it a member with a name but no value would be free, and one walk
/// could retain a member object per visit for every property in the model.
pub const COMPLEX_PROPERTY_MEMBER_BYTES: usize = 16;

/// The output budget of ONE model's complex properties: `input_bytes` times
/// [`COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE`], at least
/// [`COMPLEX_PROPERTY_OUTPUT_BYTES`].
///
/// Scope, identical in every copy: one budget per model (the server's
/// extraction, the exporter's `BaseSets`, the browser's `IfcDataStore`),
/// spent on every `IfcComplexProperty` listed by an `IfcPropertySet`, in file
/// order of the sets and then `HasProperties` order, each listing resolved
/// once. A value is therefore the same whichever entity asks for it first,
/// and no number of entities sharing a set multiplies the output.
pub fn complex_property_output_budget(input_bytes: usize) -> usize {
    input_bytes
        .saturating_mul(COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE)
        .max(COMPLEX_PROPERTY_OUTPUT_BYTES)
}

/// Appended to a complex property cut by [`MAX_COMPLEX_PROPERTY_DEPTH`].
pub fn complex_property_depth_marker() -> String {
    format!("(truncated: nesting deeper than {MAX_COMPLEX_PROPERTY_DEPTH} levels)")
}

/// The value of a level cut by [`ComplexPropertyBudget`]: its parts so far,
/// then this marker. The usage name is not repeated, so a reference to a
/// complex property past the budget costs the marker and nothing else. A walk
/// that keeps a member list (`values`, the browser's `members`) ends a cut
/// level's list with this marker too, so a member past the cut reads as
/// truncated rather than absent.
pub const COMPLEX_PROPERTY_BUDGET_MARKER: &str = "(truncated: nested properties over the walk budget)";

/// The walk state every `IfcComplexProperty` walker charges: member visits for
/// the current top-level property, output bytes for the whole model
/// ([`complex_property_output_budget`]), and how many levels it cut.
///
/// Check order, identical in every copy, and every charge is made HERE so the
/// copies cannot drift: [`Self::admit_member`] before reading a member;
/// [`Self::member_part`] once the member is read (charges its entry, and its
/// part when it has a display); [`Self::level_value`] once the level's members
/// are done (charges the joined value, and only a value that has parts).
#[derive(Debug, Clone)]
pub struct ComplexPropertyBudget {
    visits: usize,
    bytes_left: usize,
    cuts: usize,
}

impl ComplexPropertyBudget {
    /// A scope that may build `output_bytes` of text.
    pub fn new(output_bytes: usize) -> Self {
        Self { visits: 0, bytes_left: output_bytes, cuts: 0 }
    }

    /// The budget of one model whose source is `input_bytes` long.
    pub fn for_input(input_bytes: usize) -> Self {
        Self::new(complex_property_output_budget(input_bytes))
    }

    /// Start a top-level property: its member visits start at zero, the byte
    /// budget carries on.
    pub fn start_property(&mut self) {
        self.visits = 0;
    }

    /// Whether one more member may be read, counting it if so.
    pub fn admit_member(&mut self) -> bool {
        if self.visits >= MAX_COMPLEX_PROPERTY_MEMBERS || self.bytes_left == 0 {
            return false;
        }
        self.visits += 1;
        true
    }

    /// A member that was read, under `name` with `display` (empty when it has
    /// no value): charge its entry, and return the `"Name: value"` part (bare
    /// `value` without a name), charged too, or `None` when there is no
    /// display to show.
    pub fn member_part(&mut self, name: &str, display: &str) -> Option<String> {
        self.charge(COMPLEX_PROPERTY_MEMBER_BYTES + name.len() + display.len());
        if display.is_empty() {
            return None;
        }
        let part = if name.is_empty() { display.to_string() } else { format!("{name}: {display}") };
        self.charge(part.len());
        Some(part)
    }

    /// A level's value from its parts, `cut` when [`Self::admit_member`]
    /// refused one of its members: the parts joined with `", "` (then the
    /// budget marker when cut), the bare marker when cut with no parts, or
    /// `None` (the caller's bare `UsageName`) when nothing resolved. Only a
    /// value with parts is charged; the bare marker is bounded by the members
    /// admitted to reach it.
    pub fn level_value(&mut self, parts: &[String], cut: bool) -> Option<String> {
        if cut {
            self.cuts += 1;
        }
        if parts.is_empty() {
            return cut.then(|| COMPLEX_PROPERTY_BUDGET_MARKER.to_string());
        }
        let joined = parts.join(", ");
        let value = if cut { format!("{joined} {COMPLEX_PROPERTY_BUDGET_MARKER}") } else { joined };
        self.charge(value.len());
        Some(value)
    }

    /// Levels this budget has cut so far (D3: counted, and logged by the
    /// walk's owner, never silent).
    pub fn cuts(&self) -> usize {
        self.cuts
    }

    fn charge(&mut self, bytes: usize) {
        self.bytes_left = self.bytes_left.saturating_sub(bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #4611, lowered by #4934. The documented contract: 1 km, strictly
    /// greater, any axis, sign ignored. Pinned here because every former copy
    /// compared the same way and a predicate that flipped to `>=` or dropped
    /// an axis would move the needs-shift decision for every consumer at
    /// once.
    #[test]
    fn large_coord_threshold_is_the_documented_1_km() {
        assert_eq!(LARGE_COORD_THRESHOLD_METERS, 1_000.0);
        assert!(!coord_is_large((1_000.0, 0.0, 0.0)));
        assert!(!coord_is_large((-1_000.0, -1_000.0, -1_000.0)));
        assert!(coord_is_large((1_000.5, 0.0, 0.0)));
        assert!(coord_is_large((0.0, -1_000.5, 0.0)));
        assert!(coord_is_large((0.0, 0.0, 1_000.5)));
    }

    /// The documented contract. This pins the VALUE; the constant being shared
    /// is what pins agreement between the three walks, and that is now
    /// structural rather than asserted.
    #[test]
    fn mapped_item_depth_is_the_documented_32() {
        assert_eq!(MAX_MAPPED_ITEM_DEPTH, 32);
    }

    /// The documented contract, pinned separately from the two sites that
    /// import it — those assert they ARE this constant, which cannot also pin
    /// its value.
    #[test]
    fn placement_depth_is_the_documented_100() {
        assert_eq!(MAX_PLACEMENT_DEPTH, 100);
    }

    /// #7675: the TypeScript twin spells these literally, so their values
    /// are pinned here as well as by the shared vector.
    #[test]
    fn complex_property_budget_is_the_documented_policy() {
        assert_eq!((MAX_COMPLEX_PROPERTY_DEPTH, MAX_COMPLEX_PROPERTY_MEMBERS), (8, 1024));
        assert_eq!(COMPLEX_PROPERTY_OUTPUT_BYTES, 1 << 20);
        assert_eq!((COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE, COMPLEX_PROPERTY_MEMBER_BYTES), (4, 16));
        assert_eq!(complex_property_output_budget(10), 1 << 20, "the floor");
        assert_eq!(complex_property_output_budget(1 << 20), 4 << 20, "per input byte");
        assert_eq!(complex_property_output_budget(usize::MAX), usize::MAX, "saturates");

        let mut budget = ComplexPropertyBudget::new(10);
        assert!((0..MAX_COMPLEX_PROPERTY_MEMBERS).all(|_| budget.admit_member()));
        assert!(!budget.admit_member(), "visit 1025 of one property");
        budget.start_property();
        assert!(budget.admit_member(), "visits restart per property");
        assert_eq!(budget.member_part("", ""), None, "no display, no part");
        assert!(!budget.admit_member(), "the entry alone spent the 10 bytes, across properties");
    }

    /// The charge positions every walk shares: an entry per read member, its
    /// part, and the joined level, but never a bare marker (#7675 review: the
    /// exporter charged it, so it cut a different property than TS).
    #[test]
    fn complex_property_budget_charges_parts_and_levels_not_bare_markers() {
        let mut budget = ComplexPropertyBudget::new(1000);
        let part = budget.member_part("P", "v").expect("a display is a part");
        assert_eq!(part, "P: v");
        assert_eq!(budget.bytes_left, 1000 - (COMPLEX_PROPERTY_MEMBER_BYTES + 2) - 4);
        let before = budget.bytes_left;
        assert_eq!(budget.level_value(&[], true).as_deref(), Some(COMPLEX_PROPERTY_BUDGET_MARKER));
        assert_eq!(budget.bytes_left, before, "a bare marker is not charged");
        assert_eq!(budget.level_value(&[], false), None, "nothing resolved: the caller's usage name");
        let value = budget.level_value(&[part.clone(), part], true).expect("parts");
        assert_eq!(value, format!("P: v, P: v {COMPLEX_PROPERTY_BUDGET_MARKER}"));
        assert_eq!(budget.bytes_left, before - value.len());
        assert_eq!(budget.cuts(), 2, "both cut levels are counted");
    }
}
