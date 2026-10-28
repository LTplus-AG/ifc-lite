// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The C4-0 comparison axes (#7782). Each axis turns one observed difference
//! into a [`Drift`] keyed by `(fixture, axis, element)`; the gate in
//! `batch_parity_tests.rs` then demands that set equal its enumerated
//! `EXPECTED_DIFF` table exactly.
//!
//! What is compared, and the only normalizations applied:
//!
//! * Geometry is compared in the frame each pipeline reports. When the native
//!   `ProcessingResult::frame` equals the browser wire's `StreamMeta::frame`,
//!   positions, normals, origins and the placement chain are compared as exact
//!   bits. When they differ, both sides are mapped to IFC world by their OWN
//!   frame (`MeshFrame::world_mapper` / `direction_mapper`, the one restore
//!   every exporter uses) and compared within [`WORLD_TOLERANCE_M`] /
//!   [`NORMAL_TOLERANCE`]. Only native `SiteLocal` against a browser
//!   translation-only frame is sanctioned: the browser pre-pass meshes in world
//!   axes and passes no site tier by design (`stream_meta::resolve_stream_meta`).
//!   Every other frame mismatch is a `Frame` drift as well.
//! * Colours compare all f32 bits. RGBA8 wire quantization is an explicit
//!   value-bound expected difference, never silently rounded away.
//! * Type-product geometry: native plans `TypeGeometryMode::SuppressInstanced`,
//!   the viewer `EmitTagged`. A browser class-2 mesh is removed before the
//!   other axes run only when its element is a type-product job on the wire
//!   AND native drew nothing for it. Its FULL payload still produces a
//!   value-bound `TypeGeometry` exception; unexpected class-2 meshes stay in
//!   every comparison. The library mode cannot hide payload changes.
//!
//! Not compared, with the reason: `global_id` / `name` / `properties` (the viewer takes element metadata from the parser worker,
//! `metadata: None` in `produce_batch`); finishes (native `MeshData` carries
//! none); `instance` (both legs are unarmed and must leave it `None`, which
//! the exact digest still checks); operational timings and point-cache tallies.

use ifc_lite_geometry::GeometryDiagnostics;
use ifc_lite_processing::{MeshData, MeshFrame};
use std::collections::{BTreeMap, BTreeSet};

/// World-space position tolerance (metres) for the normalized frame path.
/// Both sides store f32 offsets from different origins, so a vertex carries
/// one f32 rounding of its local coordinate on each side.
pub(super) const WORLD_TOLERANCE_M: f64 = 1e-5;
/// Component tolerance for unit normals restored to world axes.
pub(super) const NORMAL_TOLERANCE: f64 = 1e-5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(super) enum Axis {
    Placement,
    Layers,
    /// The two pipelines picked frames the normalization does not sanction.
    Frame,
    /// An element draws on one pipeline only.
    ElementSet,
    /// Actual discovery identities/multiplicities differ.
    JobSet,
    /// Type-product geometry outside the sanctioned class-2 difference.
    TypeGeometry,
    /// An element's meshes differ (geometry, ids, classes, texture payload).
    MeshHash,
    /// An element's `(geometry item, RGBA8 colour)` multiset differs.
    Color,
    /// The `GeometryDiagnostics` contract differs (CSG, openings, unsupported).
    Diagnostics,
    /// Native refusal counters versus the browser's `PipelineDiagnostics`.
    RefusalCounters,
    PlannedJobs,
    UnitRefusal,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Drift {
    pub fixture: &'static str,
    pub axis: Axis,
    pub element: Option<u32>,
    /// Human-readable evidence for the report; not part of the gate's key.
    pub detail: String,
}

impl Drift {
    pub fn key(&self) -> (&'static str, Axis, Option<u32>) {
        (self.fixture, self.axis, self.element)
    }
}

// Reuse the processing entry-point evidence hasher; only typed writes live here.
use super::entry_trace::Fnv;
use std::hash::Hasher;
impl Fnv {
    fn bytes(&mut self, bytes: &[u8]) {
        self.write(bytes);
    }
    fn u8(&mut self, v: u8) {
        self.bytes(&[v]);
    }
    fn u32(&mut self, v: u32) {
        self.bytes(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.bytes(&v.to_le_bytes());
    }
    fn size(&mut self, n: usize) {
        self.u64(n as u64);
    }
    fn opt_u32(&mut self, v: Option<u32>) {
        match v {
            Some(v) => {
                self.u8(1);
                self.u32(v);
            }
            None => self.u8(0),
        }
    }
    fn str(&mut self, s: Option<&str>) {
        match s {
            Some(s) => {
                self.u8(1);
                self.size(s.len());
                self.bytes(s.as_bytes());
            }
            None => self.u8(0),
        }
    }
    fn f32s(&mut self, v: &[f32]) {
        self.size(v.len());
        v.iter().for_each(|x| self.u32(x.to_bits()));
    }
    fn f64s(&mut self, v: &[f64]) {
        self.size(v.len());
        v.iter().for_each(|x| self.u64(x.to_bits()));
    }
    fn u32s(&mut self, v: &[u32]) {
        self.size(v.len());
        v.iter().for_each(|x| self.u32(*x));
    }
}

/// Everything about a mesh that no frame can move: identity, classes,
/// topology, UVs and the decoded texture.
fn structure(h: &mut Fnv, m: &MeshData) {
    h.str(Some(m.ifc_type.as_str()));
    h.u8(m.geometry_class);
    h.opt_u32(m.geometry_item_id);
    h.opt_u32(m.material_id);
    h.str(m.material_name.as_deref());
    h.str(m.presentation_layer.as_deref());
    // Bind appearance and captured placement to THIS mesh, not independent
    // multisets that could hide swaps between two same-item submeshes.
    h.f32s(&m.color);
    match m.local_to_world {
        Some(matrix) => {
            h.u8(1);
            h.f64s(&matrix);
        }
        None => h.u8(0),
    }
    h.size(m.positions.len());
    h.size(m.normals.len());
    h.u32s(&m.indices);
    match &m.uvs {
        Some(uvs) => {
            h.u8(1);
            h.f32s(uvs);
        }
        None => h.u8(0),
    }
    match &m.texture {
        Some(t) => {
            h.u8(1);
            h.u32(t.texture_id);
            h.u32(t.width);
            h.u32(t.height);
            h.str(t.url.as_deref());
            h.u8(u8::from(t.repeat_s) | (u8::from(t.repeat_t) << 1));
            match &t.rgba {
                Some(rgba) => {
                    h.u8(1);
                    h.size(rgba.len());
                    h.bytes(rgba);
                }
                None => h.u8(0),
            }
        }
        None => h.u8(0),
    }
    match &m.local_bounds {
        Some(b) => {
            h.u8(1);
            h.f32s(b);
        }
        None => h.u8(0),
    }
    // Both legs are unarmed: an instance record on either is itself a drift.
    match &m.instance {
        Some(i) => {
            h.u8(1);
            h.bytes(&i.rep_identity.to_le_bytes());
            h.u8(u8::from(i.instanceable));
            h.f64s(&i.transform);
            h.f64s(&i.local_transform.unwrap_or([f64::NAN; 16]));
            h.f64s(&i.canonical_transform.unwrap_or([f64::NAN; 16]));
        }
        None => h.u8(0),
    }
}

fn structure_digest(m: &MeshData) -> u64 {
    let mut h = Fnv::new();
    structure(&mut h, m);
    h.finish()
}

/// The exact-frame digest: structure plus every coordinate bit.
pub(super) fn exact_digest(m: &MeshData) -> u64 {
    let mut h = Fnv::new();
    structure(&mut h, m);
    h.f32s(&m.positions);
    h.f32s(&m.normals);
    h.f64s(&m.origin);
    h.finish()
}

fn by_element<'a>(meshes: impl Iterator<Item = &'a MeshData>) -> BTreeMap<u32, Vec<&'a MeshData>> {
    let mut map: BTreeMap<u32, Vec<&MeshData>> = BTreeMap::new();
    for m in meshes {
        map.entry(m.express_id).or_default().push(m);
    }
    map
}

fn drawn(meshes: &[&MeshData]) -> bool {
    meshes.iter().any(|m| !m.indices.is_empty())
}

/// The sanctioned `SuppressInstanced`/`EmitTagged` split: drop each browser
/// class-2 mesh whose element is a type-product job and drew nothing
/// natively; report every other class-2 mesh, on either side.
pub(super) fn apply_type_geometry_rule<'a>(
    fixture: &'static str,
    browser: Vec<&'a MeshData>,
    native: &[&MeshData],
    type_jobs: &BTreeSet<u32>,
    drifts: &mut Vec<Drift>,
) -> Vec<&'a MeshData> {
    let native_ids: BTreeSet<u32> = native.iter().map(|m| m.express_id).collect();
    for id in native
        .iter()
        .filter(|m| m.geometry_class == 2)
        .map(|m| m.express_id)
        .collect::<BTreeSet<_>>()
    {
        drifts.push(Drift {
            fixture,
            axis: Axis::TypeGeometry,
            element: Some(id),
            detail: "native emitted instanced type geometry (class 2) under SuppressInstanced"
                .into(),
        });
    }
    let mut reported = BTreeSet::new();
    browser
        .into_iter()
        .filter(|m| {
            if m.geometry_class != 2 {
                return true;
            }
            let sanctioned = type_jobs.contains(&m.express_id) && !native_ids.contains(&m.express_id);
            if sanctioned && reported.insert(m.express_id) {
                drifts.push(Drift {
                    fixture, axis: Axis::TypeGeometry, element: Some(m.express_id),
                    detail: "EmitTagged emits an instantiated type-library map; native SuppressInstanced omits it".into(),
                });
            }
            if !sanctioned && reported.insert(m.express_id) {
                drifts.push(Drift {
                    fixture,
                    axis: Axis::TypeGeometry,
                    element: Some(m.express_id),
                    detail: format!(
                        "browser class-2 mesh outside the sanctioned rule (type-product job: {}, native drew it: {})",
                        type_jobs.contains(&m.express_id),
                        native_ids.contains(&m.express_id)
                    ),
                });
            }
            !sanctioned
        })
        .collect()
}

/// Required type-map coverage is checked BEFORE the mode sanction. Classes
/// come from actual producer meshes, identities from actual discovery.
pub(super) fn type_coverage(
    fixture: &'static str,
    native: &[&MeshData],
    browser: &[&MeshData],
    native_jobs: &BTreeMap<u32, usize>,
    browser_jobs: &BTreeMap<u32, usize>,
    drifts: &mut Vec<Drift>,
) {
    if fixture == super::short(super::TYPE_MODES) {
        for (id, nc, bc) in [(100, Some(1), Some(1)), (101, None, Some(2))] {
            let has = |meshes: &[&MeshData], class| {
                meshes.iter().any(|m| {
                    m.express_id == id && Some(m.geometry_class) == class && !m.indices.is_empty()
                })
            };
            let native_ok = match nc {
                Some(_) => native_jobs.get(&id) == Some(&1) && has(native, nc),
                None => {
                    !native_jobs.contains_key(&id) && !native.iter().any(|m| m.express_id == id)
                }
            };
            if !native_ok || browser_jobs.get(&id) != Some(&1) || !has(browser, bc) {
                drifts.push(Drift { fixture, axis: Axis::TypeGeometry, element: Some(id),
                    detail: format!("required native job/class {nc:?}, browser job/class {bc:?} missing or wrong") });
            }
        }
    }
    if fixture == super::short(super::BARE_TYPE_MAP) {
        assert_eq!(
            native_jobs.get(&43),
            Some(&1),
            "native discovers bare map #43"
        );
        assert!(
            native
                .iter()
                .any(|m| m.express_id == 43 && m.geometry_class == 1 && !m.indices.is_empty()),
            "native draws bare map #43 as class 1"
        );
    }
    let ids: BTreeSet<_> = native_jobs
        .keys()
        .chain(browser_jobs.keys())
        .copied()
        .collect();
    for id in ids {
        let n = native_jobs.get(&id).copied().unwrap_or(0);
        let b = browser_jobs.get(&id).copied().unwrap_or(0);
        // Only a PRESENT, correctly tagged browser type output sanctions the
        // extra discovery job. Losing #101 fails the invariant above.
        let tagged = browser
            .iter()
            .any(|m| m.express_id == id && m.geometry_class == 2 && !m.indices.is_empty());
        if n != b && !(n == 0 && b > 0 && tagged) {
            drifts.push(Drift {
                fixture,
                axis: Axis::JobSet,
                element: Some(id),
                detail: format!("production discovery multiplicity native={n}, browser={b}"),
            });
        }
    }
}

/// `Frame`: whether geometry must be compared through the world restore
/// (`true`) rather than as exact bits.
pub(super) fn frame_rule(
    fixture: &'static str,
    native: MeshFrame,
    browser: MeshFrame,
    drifts: &mut Vec<Drift>,
) -> bool {
    if native == browser {
        return false;
    }
    let sanctioned = matches!(native, MeshFrame::SiteLocal { .. })
        && !matches!(browser, MeshFrame::SiteLocal { .. });
    if !sanctioned {
        drifts.push(Drift {
            fixture,
            axis: Axis::Frame,
            element: None,
            detail: format!("native {native:?} vs browser {browser:?}"),
        });
    }
    true
}

fn world_points(m: &MeshData, frame: MeshFrame) -> Vec<[f64; 3]> {
    let to_world = frame.world_mapper();
    m.positions
        .chunks_exact(3)
        .map(|p| {
            to_world([
                f64::from(p[0]) + m.origin[0],
                f64::from(p[1]) + m.origin[1],
                f64::from(p[2]) + m.origin[2],
            ])
        })
        .collect()
}

fn world_normals(m: &MeshData, frame: MeshFrame) -> Vec<[f64; 3]> {
    let to_world = frame.direction_mapper();
    m.normals
        .chunks_exact(3)
        .map(|n| to_world([f64::from(n[0]), f64::from(n[1]), f64::from(n[2])]))
        .collect()
}

/// Global element emission is parallel/chunked; only per-element submesh order
/// is contractual (including transparent draw order). Never sort these meshes.
fn ordered<'a>(meshes: &[&'a MeshData], frame: MeshFrame) -> Vec<(&'a MeshData, Vec<[f64; 3]>)> {
    meshes.iter().map(|m| (*m, world_points(m, frame))).collect()
}

fn close(a: &[[f64; 3]], b: &[[f64; 3]], tol: f64) -> Option<f64> {
    if a.len() != b.len() || a.iter().chain(b).flatten().any(|v| !v.is_finite()) {
        return Some(f64::INFINITY);
    }
    let worst = a
        .iter()
        .zip(b)
        .flat_map(|(p, q)| (0..3).map(move |k| (p[k] - q[k]).abs()))
        .fold(0.0f64, f64::max);
    (worst > tol).then_some(worst)
}

/// `MeshHash` for one element present on both sides.
fn mesh_difference(
    native: &[&MeshData],
    browser: &[&MeshData],
    normalized: Option<(MeshFrame, MeshFrame)>,
) -> Option<String> {
    // Validate before chunks_exact, sorting or hashing: identical corrupt
    // buffers are never evidence of parity, including in the exact branch.
    if native.iter().chain(browser).any(|m| {
        m.positions.len() % 3 != 0
            || m.normals.len() != m.positions.len()
            || m.positions.iter().chain(&m.normals).any(|v| !v.is_finite())
            || m.origin.iter().any(|v| !v.is_finite())
            || m.local_bounds.iter().flatten().any(|v| !v.is_finite())
            || m.local_to_world.iter().flatten().any(|v| !v.is_finite())
    }) {
        return Some("non-finite or malformed xyz position/normal input".into());
    }
    let Some((native_frame, browser_frame)) = normalized else {
        let a: Vec<u64> = native.iter().map(|m| exact_digest(m)).collect();
        let b: Vec<u64> = browser.iter().map(|m| exact_digest(m)).collect();
        return (a != b).then(|| describe(native, browser));
    };
    let finite_frame = |frame: MeshFrame| match frame {
        MeshFrame::SiteLocal { placement } => placement.iter().all(|v| v.is_finite()),
        MeshFrame::ModelRtc { anchor: (x, y, z) } => [x, y, z].iter().all(|v| v.is_finite()),
        MeshFrame::RawIfc => true,
    };
    if !finite_frame(native_frame) || !finite_frame(browser_frame) {
        return Some("non-finite frame transform".into());
    }
    if native.len() != browser.len() {
        return Some(describe(native, browser));
    }
    for ((n, n_pts), (b, b_pts)) in ordered(native, native_frame)
        .into_iter()
        .zip(ordered(browser, browser_frame))
    {
        if structure_digest(n) != structure_digest(b) {
            return Some(describe(native, browser));
        }
        if let Some(worst) = close(&n_pts, &b_pts, WORLD_TOLERANCE_M) {
            return Some(format!(
                "world positions differ by {worst:e} m (> {WORLD_TOLERANCE_M:e})"
            ));
        }
        if let Some(worst) = close(
            &world_normals(n, native_frame),
            &world_normals(b, browser_frame),
            NORMAL_TOLERANCE,
        ) {
            return Some(format!(
                "world normals differ by {worst:e} (> {NORMAL_TOLERANCE:e})"
            ));
        }
    }
    None
}

fn describe(native: &[&MeshData], browser: &[&MeshData]) -> String {
    let side = |meshes: &[&MeshData]| -> String {
        meshes
            .iter()
            .map(|m| {
                format!(
                    "class {} item {:?} material {:?} {}v/{}t",
                    m.geometry_class,
                    m.geometry_item_id,
                    m.material_id,
                    m.positions.len() / 3,
                    m.indices.len() / 3
                )
            })
            .collect::<Vec<_>>()
            .join("; ")
    };
    format!("native [{}] vs browser [{}]", side(native), side(browser))
}

fn colors(meshes: &[&MeshData]) -> Vec<(Option<u32>, [u32; 4])> {
    let mut v: Vec<_> = meshes
        .iter()
        .map(|m| (m.geometry_item_id, m.color.map(f32::to_bits)))
        .collect();
    v.sort_unstable();
    v
}

/// `ElementSet`, `MeshHash` and `Color` over the post-rule mesh sets.
pub(super) fn compare_meshes(
    fixture: &'static str,
    native: &[&MeshData],
    browser: &[&MeshData],
    normalized: Option<(MeshFrame, MeshFrame)>,
    drifts: &mut Vec<Drift>,
) {
    let native = by_element(native.iter().copied());
    let browser = by_element(browser.iter().copied());
    let ids: BTreeSet<u32> = native.keys().chain(browser.keys()).copied().collect();
    for id in ids {
        let n = native.get(&id).map(Vec::as_slice).unwrap_or_default();
        let b = browser.get(&id).map(Vec::as_slice).unwrap_or_default();
        // These captured row-major transforms describe the original world
        // placement, not the baked vertex frame (processor/site_local.rs).
        // Compare their presence and bits even on the world-normalized path;
        // native intentionally drops them after a rotating site bake today.
        let placements = |meshes: &[&MeshData]| {
            let mut values: Vec<_> = meshes
                .iter()
                .map(|m| m.local_to_world.map(|v| v.map(f64::to_bits)))
                .collect();
            values.sort();
            values
        };
        if placements(n) != placements(b) {
            drifts.push(Drift {
                fixture,
                axis: Axis::Placement,
                element: Some(id),
                detail: format!("native {:?} vs browser {:?}", placements(n), placements(b)),
            });
        }
        let layers = |meshes: &[&MeshData]| {
            let mut values: Vec<_> = meshes
                .iter()
                .map(|m| {
                    (
                        m.geometry_class,
                        m.material_id,
                        m.presentation_layer.clone(),
                    )
                })
                .collect();
            values.sort();
            values
        };
        if layers(n) != layers(b) {
            drifts.push(Drift {
                fixture,
                axis: Axis::Layers,
                element: Some(id),
                detail: format!("native {:?} vs browser {:?}", layers(n), layers(b)),
            });
        }
        if drawn(n) != drawn(b) {
            drifts.push(Drift {
                fixture,
                axis: Axis::ElementSet,
                element: Some(id),
                detail: format!("drawn natively: {}, in the browser: {}", drawn(n), drawn(b)),
            });
            continue;
        }
        if let Some(detail) = mesh_difference(n, b, normalized) {
            drifts.push(Drift {
                fixture,
                axis: Axis::MeshHash,
                element: Some(id),
                detail,
            });
        }
        let (nc, bc) = (colors(n), colors(b));
        if nc != bc {
            drifts.push(Drift {
                fixture,
                axis: Axis::Color,
                element: Some(id),
                detail: format!("native {nc:?} vs browser {bc:?}"),
            });
        }
    }
}

/// `Diagnostics`: compare the complete serialized contract. Native absence
/// means the explicit full default schema, never `is_empty()` (which omits
/// deferrals, individual classification buckets and detail vectors).
pub(super) fn compare_diagnostics(
    fixture: &'static str,
    native: Option<&GeometryDiagnostics>,
    browser: &GeometryDiagnostics,
    drifts: &mut Vec<Drift>,
) {
    let empty = GeometryDiagnostics::default();
    let n = serde_json::to_value(native.unwrap_or(&empty)).expect("GeometryDiagnostics serializes");
    let b = serde_json::to_value(browser).expect("GeometryDiagnostics serializes");
    if n != b {
        drifts.push(Drift {
            fixture,
            axis: Axis::Diagnostics,
            element: None,
            detail: format!("native {n} vs browser {b}"),
        });
    }
}

/// `RefusalCounters`: native `ProcessingStats` against the keys the browser's
/// `getPipelineDiagnostics` would carry. An absent browser key is NOT zero:
/// it means the browser cannot report the counter at all.
pub(super) fn compare_refusals(
    fixture: &'static str,
    native: (u64, u64),
    browser_pipeline: Option<&serde_json::Value>,
    drifts: &mut Vec<Drift>,
) {
    let read = |key: &str| {
        browser_pipeline
            .and_then(|p| p.get(key))
            .and_then(serde_json::Value::as_u64)
    };
    let browser = (read("refusedInputElements"), read("refusedPrepassRecords"));
    if browser != (Some(native.0), Some(native.1)) {
        drifts.push(Drift {
            fixture,
            axis: Axis::RefusalCounters,
            element: None,
            detail: format!(
                "native={native:?}, pipeline_present={}, refusedInputElements={:?}, refusedPrepassRecords={:?}",
                browser_pipeline.is_some(),
                browser_pipeline.and_then(|p| p.get("refusedInputElements")),
                browser_pipeline.and_then(|p| p.get("refusedPrepassRecords"))
            ),
        });
    }
}

#[cfg(test)]
mod tests {
    //! The comparators must be able to fail: each test builds the smallest
    //! input that has to produce a drift and checks the axis it lands on.
    use super::*;

    fn tri(id: u32, class: u8) -> MeshData {
        let mut m = MeshData::new(
            id,
            "IfcWall".into(),
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2],
            [0.5, 0.4, 0.3, 1.0],
        );
        m.geometry_class = class;
        m.geometry_item_id = Some(id + 1);
        m
    }

    #[test]
    fn submesh_reordering_fails_in_exact_and_world_frames_7782() {
        let a = tri(7, 0);
        let mut b = tri(7, 0);
        b.color[3] = 0.5;
        for frames in [None, Some((MeshFrame::RawIfc, MeshFrame::RawIfc))] {
            assert!(mesh_difference(&[&a, &b], &[&a, &b], frames).is_none());
            assert!(mesh_difference(&[&a, &b], &[&b, &a], frames).is_some());
        }
    }

    #[test]
    fn one_flipped_position_bit_is_a_mesh_hash_drift_and_nothing_else() {
        let a = tri(7, 0);
        let mut b = tri(7, 0);
        b.positions[4] = f32::from_bits(b.positions[4].to_bits() ^ 1);
        let mut drifts = Vec::new();
        compare_meshes("t", &[&a], &[&b], None, &mut drifts);
        assert_eq!(
            drifts.iter().map(Drift::key).collect::<Vec<_>>(),
            [("t", Axis::MeshHash, Some(7))]
        );
    }

    #[test]
    fn colour_quantization_is_observed_as_full_payload_drift_7782() {
        let native = tri(7, 0);
        let mut browser = tri(7, 0);
        // What the RGBA8 style wire decodes 0.5 / 0.4 / 0.3 to.
        browser.color = ifc_lite_processing::style::Rgba::from_rgba8(
            ifc_lite_processing::style::Rgba(native.color).to_rgba8(),
        )
        .0;
        assert_ne!(
            browser.color, native.color,
            "the codec does move these components"
        );
        let mut drifts = Vec::new();
        compare_meshes("t", &[&native], &[&browser], None, &mut drifts);
        assert_eq!(
            drifts.iter().map(|d| d.axis).collect::<Vec<_>>(),
            [Axis::MeshHash, Axis::Color]
        );
        drifts.clear();
        browser.color[0] += 2.0 / 255.0;
        compare_meshes("t", &[&native], &[&browser], None, &mut drifts);
        assert_eq!(
            drifts.iter().map(Drift::key).collect::<Vec<_>>(),
            [("t", Axis::MeshHash, Some(7)), ("t", Axis::Color, Some(7))]
        );
    }

    #[test]
    fn only_a_type_job_native_did_not_draw_may_drop_its_class_two_mesh() {
        let (type_map, product) = (tri(100, 2), tri(31, 2));
        let type_jobs: BTreeSet<u32> = [100].into();
        let mut drifts = Vec::new();
        let kept =
            apply_type_geometry_rule("t", vec![&type_map, &product], &[], &type_jobs, &mut drifts);
        assert_eq!(kept.iter().map(|m| m.express_id).collect::<Vec<_>>(), [31]);
        assert_eq!(
            drifts.iter().map(Drift::key).collect::<Vec<_>>(),
            [
                ("t", Axis::TypeGeometry, Some(100)),
                ("t", Axis::TypeGeometry, Some(31))
            ]
        );
        // Native drawing the type itself withdraws the sanction.
        let native = tri(100, 1);
        let mut drifts = Vec::new();
        let kept =
            apply_type_geometry_rule("t", vec![&type_map], &[&native], &type_jobs, &mut drifts);
        assert_eq!(kept.len(), 1);
        assert_eq!(
            drifts.iter().map(Drift::key).collect::<Vec<_>>(),
            [("t", Axis::TypeGeometry, Some(100))]
        );
    }

    #[test]
    fn a_site_local_native_frame_is_compared_in_world_coordinates() {
        // Site at (10, 20, 0) turned 90 degrees about Z, column-major.
        let placement = [
            0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 10.0, 20.0, 0.0, 1.0,
        ];
        let site = MeshFrame::SiteLocal { placement };
        let browser = tri(7, 0);
        // The same triangle baked into the site frame: Rᵀ·(P − t).
        let mut native = tri(7, 0);
        native.origin = [-20.0, 10.0, 0.0];
        native.positions = vec![0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0, 0.0];
        native.normals = browser.normals.clone();
        let mut drifts = Vec::new();
        let normalized = frame_rule("t", site, MeshFrame::RawIfc, &mut drifts);
        assert!(
            normalized && drifts.is_empty(),
            "the site tier is the one sanctioned frame difference"
        );
        compare_meshes(
            "t",
            &[&native],
            &[&browser],
            Some((site, MeshFrame::RawIfc)),
            &mut drifts,
        );
        assert!(drifts.is_empty(), "{drifts:?}");
        // The exact path would have called these different.
        compare_meshes("t", &[&native], &[&browser], None, &mut drifts);
        assert_eq!(
            drifts.iter().map(Drift::key).collect::<Vec<_>>(),
            [("t", Axis::MeshHash, Some(7))]
        );
        // Any other frame mismatch is itself reported.
        let mut drifts = Vec::new();
        frame_rule(
            "t",
            MeshFrame::ModelRtc {
                anchor: (1.0, 0.0, 0.0),
            },
            MeshFrame::RawIfc,
            &mut drifts,
        );
        assert_eq!(
            drifts.iter().map(Drift::key).collect::<Vec<_>>(),
            [("t", Axis::Frame, None)]
        );
    }

    #[test]
    fn normalized_comparison_rejects_nonfinite_and_malformed_xyz_7782() {
        let frame = Some((MeshFrame::RawIfc, MeshFrame::RawIfc));
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            for normals in [false, true] {
                for bad_native in [false, true] {
                    let (mut a, mut b) = (tri(7, 0), tri(7, 0));
                    let bad = if bad_native { &mut a } else { &mut b };
                    if normals {
                        bad.normals[0] = value;
                    } else {
                        bad.positions[0] = value;
                    }
                    assert!(mesh_difference(&[&a], &[&b], frame).is_some());
                    let bad = if bad_native { &a } else { &b };
                    assert!(mesh_difference(&[bad], &[bad], frame).is_some());
                }
            }
        }
        for normals in [false, true] {
            let good = tri(7, 0);
            let mut bad = tri(7, 0);
            if normals {
                bad.normals.pop();
            } else {
                bad.positions.pop();
            }
            assert!(mesh_difference(&[&good], &[&bad], frame).is_some());
            assert!(mesh_difference(&[&bad], &[&bad], frame).is_some());
        }
        assert!(close(&[[0.0; 3]], &[], WORLD_TOLERANCE_M).is_some());
        assert!(close(
            &[[f64::INFINITY; 3]],
            &[[f64::INFINITY; 3]],
            WORLD_TOLERANCE_M
        )
        .is_some());
        assert!(close(&[[f64::NAN; 3]], &[[0.0; 3]], NORMAL_TOLERANCE).is_some());
    }

    #[test]
    fn normalized_comparison_rejects_nonfinite_transforms_7782() {
        let mesh = tri(7, 0);
        for bad in [f64::NAN, f64::INFINITY] {
            let mut placement = [0.0; 16];
            for i in [0, 5, 10, 15] {
                placement[i] = 1.0;
            }
            // A finite input whose world point or world normal is non-finite.
            for index in [0, 12] {
                let mut matrix = placement;
                matrix[index] = bad;
                let frame = MeshFrame::SiteLocal { placement: matrix };
                for frames in [(frame, MeshFrame::RawIfc), (MeshFrame::RawIfc, frame)] {
                    assert!(mesh_difference(&[&mesh], &[&mesh], Some(frames)).is_some());
                }
            }
        }
    }

    #[test]
    fn finite_inputs_overflowing_after_world_transform_are_rejected_7782() {
        let mut mesh = tri(7, 0);
        mesh.origin[0] = 2.0;
        let mut placement = [0.0; 16];
        for i in [0, 5, 10, 15] {
            placement[i] = 1.0;
        }
        placement[0] = f64::MAX;
        let frame = MeshFrame::SiteLocal { placement };
        assert!(mesh_difference(&[&mesh], &[&mesh], Some((frame, frame))).is_some());
    }

    #[test]
    fn complete_diagnostics_preserve_defer_and_detail_only_drift_7782_r6() {
        let zero = GeometryDiagnostics::default();
        let mut unchanged = Vec::new();
        compare_diagnostics("t", None, &zero, &mut unchanged);
        compare_diagnostics("t", Some(&zero), &zero, &mut unchanged);
        assert!(
            unchanged.is_empty(),
            "explicit full-default absence normalization"
        );

        let original = serde_json::to_value(&zero).unwrap();
        let mut mutations = Vec::new();
        for key in [
            "openingsCut",
            "deferHostNotBox",
            "deferNotThrough",
            "deferOffFace",
            "deferNearEdge",
            "deferNoOpenings",
            "deferTooManyOpenings",
        ] {
            let mut value = original.clone();
            value["rectFast"][key] = 1.into();
            mutations.push(value);
        }
        for key in ["rectangular", "diagonal", "nonRectangular"] {
            let mut value = original.clone();
            value["classification"][key] = 1.into();
            mutations.push(value);
        }
        for (key, value) in [
            ("productsWithFailures", serde_json::json!(1)),
            (
                "failuresByReason",
                serde_json::json!([{"reason": "empty-result", "count": 1}]),
            ),
            (
                "unsupportedItemsByType",
                serde_json::json!([{"reason": "IfcTextLiteral", "count": 1}]),
            ),
            (
                "worstHosts",
                serde_json::json!([{"productId": 42, "ifcType": "IfcWall",
                "openings": 1, "csgFailures": 1, "firstFailureLabel": "empty-result", "triangleCount": 12}]),
            ),
        ] {
            let mut changed = original.clone();
            changed[key] = value;
            mutations.push(changed);
        }
        for value in mutations {
            let changed: GeometryDiagnostics = serde_json::from_value(value).unwrap();
            // All of these used to vanish through the incomplete is_empty predicate.
            assert!(changed.is_empty());
            for native in [None, Some(&zero)] {
                let mut drifts = Vec::new();
                compare_diagnostics("t", native, &changed, &mut drifts);
                assert_eq!(
                    drifts.iter().map(Drift::key).collect::<Vec<_>>(),
                    [("t", Axis::Diagnostics, None)]
                );
            }
            let mut reverse = Vec::new();
            compare_diagnostics("t", Some(&changed), &zero, &mut reverse);
            assert_eq!(reverse.len(), 1, "present native details must survive too");
            let mut identical = Vec::new();
            compare_diagnostics("t", Some(&changed), &changed, &mut identical);
            assert!(
                identical.is_empty(),
                "equal nonzero detail-only objects match"
            );
        }
    }

    #[test]
    fn an_absent_browser_refusal_counter_is_not_zero() {
        let mut drifts = Vec::new();
        let zeros = serde_json::json!({"refusedInputElements": 0, "refusedPrepassRecords": 0});
        compare_refusals("t", (0, 0), Some(&zeros), &mut drifts);
        assert!(drifts.is_empty());
        compare_refusals("t", (0, 0), Some(&serde_json::json!({})), &mut drifts);
        compare_refusals("u", (0, 0), None, &mut drifts);
        assert_eq!(
            drifts.iter().map(Drift::key).collect::<Vec<_>>(),
            [
                ("t", Axis::RefusalCounters, None),
                ("u", Axis::RefusalCounters, None)
            ]
        );
    }
}
