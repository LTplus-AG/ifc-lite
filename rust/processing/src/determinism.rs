// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh-output determinism manifest - the pipeline-level companion to the
//! kernel's predicate sign manifest (`ifc_lite_geometry::kernel::manifest`).
//!
//! Runs the full `process_geometry` pipeline over a small synthetic fixture
//! and FNV-1a-hashes the emitted wire bytes: per-mesh
//! (express id, geometry class, position/normal f32 bits, indices, origin f64
//! bits) in emit order, plus the sorted `flat_voids`, `flat_material_colors`
//! and `flat_styles_rgba8` wire arrays. The resulting [`MeshManifest`] is
//! pinned in `rust/processing/tests/manifests/mesh_determinism.json`
//! (asserted on x86_64 AND arm64) and in its wasm32 pair (identical except
//! the documented libm-trig gap). The native test and the `wasm-bindings`
//! wasm-bindgen-test leg both call [`compute_mesh_manifest`], so the fixture
//! and hashing cannot drift between targets.
//! Contract: `docs/architecture/mesh-determinism.md`.
//!
//! Shared library code (not a test util feature) for the same reason the
//! kernel manifest is: the wasm leg lives in a different crate and must run
//! the exact same battery.

use crate::prepass::{
    flat_material_colors, flat_styles_rgba8, flat_voids, resolve_prepass, PrepassSpans,
    ResolveOptions,
};
use crate::processor::{process_geometry_filtered_with_quality, OpeningFilterMode};
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::TessellationQuality;
use serde::{Deserialize, Serialize};

/// Synthetic determinism fixture (house rule: no client data). Exercises the
/// wire surfaces the manifest pins:
/// - `#100` wall voided by opening `#200` and `#600` wall voided by `#700`
///   (`flat_voids` with TWO hosts, so the sorted key order is load-bearing,
///   plus the exact CSG cut),
/// - `#400` proxy with a two-material `IfcMaterialList` appearance chain
///   (transparent + opaque colours) and `#500` with a single material - TWO
///   `flat_material_colors` entries, so that sort order is load-bearing too,
/// - `#500` round column (`IfcCircleProfileDef` - Medium tessellation density),
/// - `#530` geometry-attached `IfcStyledItem` on the column solid `#506`, so
///   `flat_styles_rgba8` carries every precedence layer (geometry style +
///   material colours + per-element fallback) and its sorted id order is
///   load-bearing.
pub const FIXTURE_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('mesh-output determinism manifest fixture'),'2;1');
FILE_NAME('mesh_determinism.ifc','2026-07-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0DeterminismProject00A',$,'Determinism',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#11);
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'WallProfile',#31,4.0,0.3);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,2.5);
#41=IFCAXIS2PLACEMENT3D(#12,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0DeterminismWall0000A',$,'Wall',$,$,#20,#51,$,$);
#110=IFCLOCALPLACEMENT(#20,#111);
#111=IFCAXIS2PLACEMENT3D(#112,#113,#114);
#112=IFCCARTESIANPOINT((0.,-0.5,1.25));
#113=IFCDIRECTION((0.,1.,0.));
#114=IFCDIRECTION((1.,0.,0.));
#127=IFCRECTANGLEPROFILEDEF(.AREA.,'OpeningProfile',#128,1.2,1.5);
#128=IFCAXIS2PLACEMENT2D(#32,#33);
#131=IFCEXTRUDEDAREASOLID(#127,#132,#42,1.0);
#132=IFCAXIS2PLACEMENT3D(#12,$,$);
#140=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#131));
#141=IFCPRODUCTDEFINITIONSHAPE($,$,(#140));
#200=IFCOPENINGELEMENT('0DeterminismOpening0A',$,'Opening',$,$,#110,#141,$,.OPENING.);
#300=IFCRELVOIDSELEMENT('0DeterminismVoids000A',$,$,$,#100,#200);
#400=IFCBUILDINGELEMENTPROXY('0DeterminismProxy000A',$,'MultiMaterial',$,$,#401,#402,$,$);
#401=IFCLOCALPLACEMENT($,#403);
#403=IFCAXIS2PLACEMENT3D(#404,$,$);
#404=IFCCARTESIANPOINT((6.,0.,0.));
#402=IFCPRODUCTDEFINITIONSHAPE($,$,(#405));
#405=IFCSHAPEREPRESENTATION(#13,'Body','Tessellation',(#406));
#406=IFCTRIANGULATEDFACESET(#407,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#407=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#430=IFCSTYLEDITEM($,(#431),$);
#431=IFCSURFACESTYLE('Glazing',.BOTH.,(#432));
#432=IFCSURFACESTYLERENDERING(#433,0.5,$,$,$,$,$,$,.FLAT.);
#433=IFCCOLOURRGB($,0.2,0.4,0.8);
#434=IFCSTYLEDITEM($,(#435),$);
#435=IFCSURFACESTYLE('Frame',.BOTH.,(#436));
#436=IFCSURFACESTYLERENDERING(#437,$,$,$,$,$,$,$,.FLAT.);
#437=IFCCOLOURRGB($,0.7,0.5,0.2);
#440=IFCMATERIAL('Glazing',$,$);
#441=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#442),#440);
#442=IFCSTYLEDREPRESENTATION(#10,'Style','Material',(#430));
#445=IFCMATERIAL('Frame',$,$);
#446=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#447),#445);
#447=IFCSTYLEDREPRESENTATION(#10,'Style','Material',(#434));
#450=IFCMATERIALLIST((#440,#445));
#460=IFCRELASSOCIATESMATERIAL('0DeterminismRelMat00A',$,$,$,(#400),#450);
#500=IFCCOLUMN('0DeterminismColumn00A',$,'Column',$,$,#501,#502,$,$);
#501=IFCLOCALPLACEMENT($,#503);
#503=IFCAXIS2PLACEMENT3D(#504,$,$);
#504=IFCCARTESIANPOINT((10.,0.,0.));
#502=IFCPRODUCTDEFINITIONSHAPE($,$,(#505));
#505=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#506));
#506=IFCEXTRUDEDAREASOLID(#507,#508,#42,3.0);
#507=IFCCIRCLEPROFILEDEF(.AREA.,'ColumnProfile',#31,0.25);
#508=IFCAXIS2PLACEMENT3D(#12,$,$);
#530=IFCSTYLEDITEM(#506,(#531),$);
#531=IFCSURFACESTYLE('Concrete',.BOTH.,(#532));
#532=IFCSURFACESTYLERENDERING(#533,$,$,$,$,$,$,$,.FLAT.);
#533=IFCCOLOURRGB($,0.62,0.6,0.55);
#600=IFCWALL('0DeterminismWall0600A',$,'Wall2',$,$,#601,#651,$,$);
#601=IFCLOCALPLACEMENT($,#602);
#602=IFCAXIS2PLACEMENT3D(#603,$,$);
#603=IFCCARTESIANPOINT((0.,3.,0.));
#630=IFCRECTANGLEPROFILEDEF(.AREA.,'WallProfile2',#31,3.0,0.3);
#640=IFCEXTRUDEDAREASOLID(#630,#41,#42,2.5);
#650=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#640));
#651=IFCPRODUCTDEFINITIONSHAPE($,$,(#650));
#700=IFCOPENINGELEMENT('0DeterminismOpening7A',$,'Opening2',$,$,#710,#741,$,.OPENING.);
#710=IFCLOCALPLACEMENT(#601,#711);
#711=IFCAXIS2PLACEMENT3D(#712,#113,#114);
#712=IFCCARTESIANPOINT((0.5,-0.5,1.0));
#727=IFCRECTANGLEPROFILEDEF(.AREA.,'OpeningProfile2',#128,0.9,1.2);
#731=IFCEXTRUDEDAREASOLID(#727,#132,#42,1.0);
#740=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#731));
#741=IFCPRODUCTDEFINITIONSHAPE($,$,(#740));
#800=IFCRELVOIDSELEMENT('0DeterminismVoids800A',$,$,$,#600,#700);
#820=IFCRELASSOCIATESMATERIAL('0DeterminismRelMat82A',$,$,$,(#500),#445);
ENDSEC;
END-ISO-10303-21;
"#;

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv1a_bytes(h: &mut u64, bytes: &[u8]) {
    for &b in bytes {
        *h ^= b as u64;
        *h = h.wrapping_mul(FNV_PRIME);
    }
}

fn fnv1a_u32s(h: &mut u64, vals: &[u32]) {
    for v in vals {
        fnv1a_bytes(h, &v.to_le_bytes());
    }
}

fn fnv1a_f32_bits(h: &mut u64, vals: &[f32]) {
    for v in vals {
        fnv1a_bytes(h, &v.to_bits().to_le_bytes());
    }
}

fn hex(h: u64) -> String {
    format!("0x{h:016x}")
}

/// Per-mesh manifest entry: enough to identify WHICH mesh diverged and how big
/// it was, without committing the raw vertex data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeshManifestEntry {
    pub express_id: u32,
    pub geometry_class: u8,
    pub vertex_count: usize,
    pub triangle_count: usize,
    /// FNV-1a over (express_id, geometry_class, position f32 bits, normal f32
    /// bits, indices, origin f64 bits), all little-endian.
    pub hash: String,
}

/// The pinned mesh-output determinism fingerprint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeshManifest {
    /// FNV-1a over every per-mesh hash in emit order, then the labelled
    /// `flat_voids`, `flat_material_colors` and `flat_styles_rgba8` wire
    /// arrays.
    pub hash: String,
    pub mesh_count: usize,
    pub vertex_count: usize,
    pub triangle_count: usize,
    /// FNV-1a over the sorted `flat_voids` `(keys, counts, values)` arrays.
    pub voids_hash: String,
    /// Number of void hosts on the wire - must stay >= 2 or the sorted key
    /// order stops being load-bearing (a one-entry array pins no order).
    pub void_host_count: usize,
    /// FNV-1a over the sorted `flat_material_colors` `(ids, counts, rgba8)` arrays.
    pub material_colors_hash: String,
    /// Number of material-coloured elements on the wire - same >= 2 rationale.
    pub material_element_count: usize,
    /// FNV-1a over the sorted `flat_styles_rgba8` `(ids, rgba8)` arrays - the
    /// third flat wire surface, same cross-target contract as the other two.
    pub styles_hash: String,
    /// Number of style entries on the wire (geometry, material and element
    /// ids across the layered precedence) - same >= 2 rationale.
    pub style_entry_count: usize,
    pub meshes: Vec<MeshManifestEntry>,
}

impl MeshManifest {
    pub fn to_json(&self) -> String {
        let mut json = serde_json::to_string_pretty(self)
            .expect("MeshManifest serialization cannot fail");
        json.push('\n');
        json
    }

    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

/// The three flat prepass wire surfaces the manifest pins, computed over the
/// fixture by [`resolve_fixture_wires`].
struct FixtureWires {
    void_keys: Vec<u32>,
    void_counts: Vec<u32>,
    void_values: Vec<u32>,
    mat_ids: Vec<u32>,
    mat_counts: Vec<u32>,
    mat_rgba: Vec<u8>,
    style_ids: Vec<u32>,
    style_rgba: Vec<u8>,
}

/// Scan the fixture's prepass spans, resolve them - the same mechanical
/// span-stash both production scan loops run (see the `crate::prepass` module
/// doc), feeding THE shared resolver - and flatten every wire surface the
/// manifest pins.
fn resolve_fixture_wires(content: &[u8]) -> FixtureWires {
    let entity_index = std::sync::Arc::new(build_entity_index(content));
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index);
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        match type_name {
            "IFCSTYLEDITEM" => spans.styled_items.push((id, start, end)),
            "IFCINDEXEDCOLOURMAP" => spans.indexed_colour_maps.push((id, start, end)),
            "IFCMATERIALDEFINITIONREPRESENTATION" => {
                spans.material_def_reprs.push((id, start, end))
            }
            "IFCRELASSOCIATESMATERIAL" => spans.rel_associates_material.push((id, start, end)),
            "IFCRELVOIDSELEMENT" => spans.void_rels.push((id, start, end)),
            "IFCRELFILLSELEMENT" => spans.fills_rels.push((id, start, end)),
            "IFCRELAGGREGATES" => spans.aggregate_rels.push((id, start, end)),
            _ => {}
        }
    }
    let resolved = resolve_prepass(&spans, &mut decoder, ResolveOptions::default());
    let (void_keys, void_counts, void_values) = flat_voids(&resolved.void_index);
    let (mat_ids, mat_counts, mat_rgba) = flat_material_colors(&resolved.element_material_colors);
    let (style_ids, style_rgba) = flat_styles_rgba8(&resolved, &mut decoder);
    FixtureWires {
        void_keys,
        void_counts,
        void_values,
        mat_ids,
        mat_counts,
        mat_rgba,
        style_ids,
        style_rgba,
    }
}

/// Compute the mesh-output determinism manifest over [`FIXTURE_IFC`] at
/// `TessellationQuality::Medium` (the byte-identity density).
///
/// Pins the LOCAL-FRAME output (per-element f64 `origin` + element-local f32
/// positions - the shipping wasm viewer path) by forcing
/// `local_frame_set_enabled_override(Some(true))` for the REST OF THE PROCESS:
/// wasm already defaults ON, native defaults OFF, and equalizing the flag is
/// what makes the two targets' bytes comparable. The override is deliberately
/// not restored (a concurrent test restoring it mid-compute would race), so
/// only dedicated determinism test binaries should call this.
pub fn compute_mesh_manifest() -> MeshManifest {
    ifc_lite_geometry::local_frame_set_enabled_override(Some(true));

    let result = process_geometry_filtered_with_quality(
        FIXTURE_IFC,
        OpeningFilterMode::Default,
        TessellationQuality::Medium,
    );

    let wires = resolve_fixture_wires(FIXTURE_IFC.as_bytes());

    let mut meshes = Vec::with_capacity(result.meshes.len());
    let mut top = FNV_OFFSET_BASIS;
    let mut vertex_count = 0usize;
    let mut triangle_count = 0usize;
    for mesh in &result.meshes {
        let mut h = FNV_OFFSET_BASIS;
        fnv1a_bytes(&mut h, &mesh.express_id.to_le_bytes());
        fnv1a_bytes(&mut h, &[mesh.geometry_class]);
        fnv1a_f32_bits(&mut h, &mesh.positions);
        fnv1a_f32_bits(&mut h, &mesh.normals);
        fnv1a_u32s(&mut h, &mesh.indices);
        for c in mesh.origin {
            fnv1a_bytes(&mut h, &c.to_bits().to_le_bytes());
        }
        fnv1a_bytes(&mut top, &h.to_le_bytes());
        vertex_count += mesh.positions.len() / 3;
        triangle_count += mesh.indices.len() / 3;
        meshes.push(MeshManifestEntry {
            express_id: mesh.express_id,
            geometry_class: mesh.geometry_class,
            vertex_count: mesh.positions.len() / 3,
            triangle_count: mesh.indices.len() / 3,
            hash: hex(h),
        });
    }

    let mut voids_hash = FNV_OFFSET_BASIS;
    fnv1a_u32s(&mut voids_hash, &wires.void_keys);
    fnv1a_u32s(&mut voids_hash, &wires.void_counts);
    fnv1a_u32s(&mut voids_hash, &wires.void_values);

    let mut mat_hash = FNV_OFFSET_BASIS;
    fnv1a_u32s(&mut mat_hash, &wires.mat_ids);
    fnv1a_u32s(&mut mat_hash, &wires.mat_counts);
    fnv1a_bytes(&mut mat_hash, &wires.mat_rgba);

    let mut styles_hash = FNV_OFFSET_BASIS;
    fnv1a_u32s(&mut styles_hash, &wires.style_ids);
    fnv1a_bytes(&mut styles_hash, &wires.style_rgba);

    fnv1a_bytes(&mut top, b"voids");
    fnv1a_bytes(&mut top, &voids_hash.to_le_bytes());
    fnv1a_bytes(&mut top, b"material_colors");
    fnv1a_bytes(&mut top, &mat_hash.to_le_bytes());
    fnv1a_bytes(&mut top, b"styles");
    fnv1a_bytes(&mut top, &styles_hash.to_le_bytes());

    MeshManifest {
        hash: hex(top),
        mesh_count: result.meshes.len(),
        vertex_count,
        triangle_count,
        voids_hash: hex(voids_hash),
        void_host_count: wires.void_keys.len(),
        material_colors_hash: hex(mat_hash),
        material_element_count: wires.mat_ids.len(),
        styles_hash: hex(styles_hash),
        style_entry_count: wires.style_ids.len(),
        meshes,
    }
}

/// `None` if the manifests match; otherwise a human-readable report that
/// identifies WHICH mesh diverged (index, express id, per-mesh hash), not just
/// the top-level mismatch.
pub fn diff_report(expected: &MeshManifest, actual: &MeshManifest) -> Option<String> {
    if expected == actual {
        return None;
    }
    let mut lines = Vec::new();
    if expected.hash != actual.hash {
        lines.push(format!("hash: expected {} got {}", expected.hash, actual.hash));
    }
    if expected.mesh_count != actual.mesh_count {
        lines.push(format!(
            "mesh_count: expected {} got {}",
            expected.mesh_count, actual.mesh_count
        ));
    }
    if expected.vertex_count != actual.vertex_count {
        lines.push(format!(
            "vertex_count: expected {} got {}",
            expected.vertex_count, actual.vertex_count
        ));
    }
    if expected.triangle_count != actual.triangle_count {
        lines.push(format!(
            "triangle_count: expected {} got {}",
            expected.triangle_count, actual.triangle_count
        ));
    }
    if expected.voids_hash != actual.voids_hash {
        lines.push(format!(
            "voids_hash: expected {} got {}",
            expected.voids_hash, actual.voids_hash
        ));
    }
    if expected.void_host_count != actual.void_host_count {
        lines.push(format!(
            "void_host_count: expected {} got {}",
            expected.void_host_count, actual.void_host_count
        ));
    }
    if expected.material_colors_hash != actual.material_colors_hash {
        lines.push(format!(
            "material_colors_hash: expected {} got {}",
            expected.material_colors_hash, actual.material_colors_hash
        ));
    }
    if expected.material_element_count != actual.material_element_count {
        lines.push(format!(
            "material_element_count: expected {} got {}",
            expected.material_element_count, actual.material_element_count
        ));
    }
    if expected.styles_hash != actual.styles_hash {
        lines.push(format!(
            "styles_hash: expected {} got {}",
            expected.styles_hash, actual.styles_hash
        ));
    }
    if expected.style_entry_count != actual.style_entry_count {
        lines.push(format!(
            "style_entry_count: expected {} got {}",
            expected.style_entry_count, actual.style_entry_count
        ));
    }
    let common = expected.meshes.len().min(actual.meshes.len());
    for i in 0..common {
        let (e, a) = (&expected.meshes[i], &actual.meshes[i]);
        if e != a {
            lines.push(format!(
                "mesh[{i}]: expected #{} class {} v{} t{} {} got #{} class {} v{} t{} {}",
                e.express_id, e.geometry_class, e.vertex_count, e.triangle_count, e.hash,
                a.express_id, a.geometry_class, a.vertex_count, a.triangle_count, a.hash
            ));
        }
    }
    for (i, e) in expected.meshes.iter().enumerate().skip(common) {
        lines.push(format!("mesh[{i}]: expected #{} {} got NOTHING", e.express_id, e.hash));
    }
    for (i, a) in actual.meshes.iter().enumerate().skip(common) {
        lines.push(format!("mesh[{i}]: expected NOTHING got #{} {}", a.express_id, a.hash));
    }
    Some(lines.join("\n"))
}
