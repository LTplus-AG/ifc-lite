// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Occurrences of one `IfcRepresentationMap` produce byte-identical buffers
//! (#4103), so the dedup that already exists can group them.
//!
//! `mesh_weld`'s vertex key carries the raw f32 BIT PATTERN of the position, so
//! what it merges depends on the magnitude of the coordinates it is handed: one
//! f32 ULP is ~6e-8 m at 0.5 m and ~1.5e-5 m at 128 m. While the weld ran after
//! the placement was baked in, the same source geometry therefore welded
//! differently at every placement, and `instancing::collate_refs` refuses a
//! group whose members disagree on vertex count. On the reporting model that
//! meant ten armchairs sharing one `IfcRepresentationMap` shipped as ten full
//! meshes, with vertex counts spread over 0.9%, and a cached Parquet artifact
//! came out three times the size of its own IFC.
//!
//! ## What the fixture is built to discriminate
//!
//! An INLINE minimal IFC, so the test needs no external model. One
//! `IfcRepresentationMap` holds two coplanar unit quads whose x coordinates
//! differ by [`QUAD_X_OFFSET`] = 1e-6 m, and EACH quad is authored as two
//! TRIANGULAR faces sharing a diagonal. Three products map it at x = 0, 64 and
//! 128 through an identity `MappingTarget`, so the occurrences differ only by
//! their placement.
//!
//! That gives three distinguishable vertex counts, which is the point:
//!
//! | what the pipeline does | vertices per occurrence |
//! |---|---|
//! | no weld at all | 12 (4 triangular faces x 3, no cross-face sharing) |
//! | weld after the bake (the defect) | 8 at x=0, 4 at x=128 |
//! | weld the source, in the object frame | 8 everywhere |
//!
//! So 8 at every placement fails for a pipeline that welds nothing (12), and
//! fails for one that welds baked world coordinates (4 at x=128). A fixture
//! whose quads shared no duplicate corners would report 8 in the first two rows
//! as well, and could not tell "the weld moved" from "the weld was deleted".
//!
//! The 1e-6 offset is above `drop_thin_triangles`'s reach: that keys on triangle
//! aspect, not on vertex spacing, and every triangle here is half a unit square.
//!
//! ## Frame
//!
//! This pins the NATIVE / server frame, where `MeshData.positions` are absolute
//! world coordinates, which is where the defect was reported. Under the viewer's
//! local frame the positions are relative to a per-element origin and stay
//! element-small, so the x=128 collapse never happens and the defect does not
//! reproduce. The tests force the frame off rather than inheriting whatever
//! `IFC_LITE_LOCAL_FRAME` happens to be set to, so they measure the same thing
//! in every environment.

use ifc_lite_geometry::{collate_refs, local_frame_set_enabled_override, InstanceMeshRef};
use ifc_lite_processing::{process_geometry, MeshData};
use std::sync::Mutex;

/// The x offset between the two coplanar quads, in metres. Chosen to sit
/// BETWEEN the f32 resolution at the map's own coordinates and the f32
/// resolution at the farthest placement, which is the whole point of the
/// fixture: the two quads are separable in the object frame and not in the
/// world frame.
const QUAD_X_OFFSET: f64 = 1e-6;

/// Placement x coordinates, in metres. 0 keeps the quads separable even after
/// baking; 128 does not, since one ULP there is 1.5e-5 m, fifteen times the
/// offset.
const PLACEMENT_X: [f64; 3] = [0.0, 64.0, 128.0];

/// Four triangular faces, each contributing its own 3 vertices.
const RAW_VERTICES: usize = 12;
/// Two quads, each welded from 6 face vertices down to its 4 distinct corners.
const WELDED_VERTICES: usize = 8;
/// Two quads, two triangles each.
const TRIANGLES: usize = 4;

/// Build the fixture. Each quad is two triangular `IfcFace`s sharing the
/// diagonal `(1,0) - (0,1)`, so its two diagonal endpoints are authored twice
/// with the same position and the same +Z normal: exactly the per-face
/// duplication the source weld exists to collapse.
fn fixture() -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut next_id = 100u32;
    let mut emit = |body: String, lines: &mut Vec<String>| {
        let id = next_id;
        next_id += 1;
        lines.push(format!("#{id}={body};"));
        id
    };

    let mut triangle = |corners: [(f64, f64); 3], dx: f64, lines: &mut Vec<String>| {
        let points: Vec<u32> = corners
            .iter()
            .map(|(x, y)| emit(format!("IFCCARTESIANPOINT(({:?},{y:?},0.))", x + dx), lines))
            .collect();
        let refs: Vec<String> = points.iter().map(|p| format!("#{p}")).collect();
        let loop_id = emit(format!("IFCPOLYLOOP(({}))", refs.join(",")), lines);
        let bound = emit(format!("IFCFACEOUTERBOUND(#{loop_id},.T.)"), lines);
        emit(format!("IFCFACE((#{bound}))"), lines)
    };

    let mut faces: Vec<u32> = Vec::new();
    for dx in [0.0, QUAD_X_OFFSET] {
        faces.push(triangle([(0., 0.), (1., 0.), (0., 1.)], dx, &mut lines));
        faces.push(triangle([(1., 0.), (1., 1.), (0., 1.)], dx, &mut lines));
    }
    let face_refs: Vec<String> = faces.iter().map(|f| format!("#{f}")).collect();
    let shell = emit(
        format!("IFCOPENSHELL(({}))", face_refs.join(",")),
        &mut lines,
    );
    let surface = emit(format!("IFCSHELLBASEDSURFACEMODEL((#{shell}))"), &mut lines);
    let map_rep = emit(
        format!("IFCSHAPEREPRESENTATION(#6,'Body','SurfaceModel',(#{surface}))"),
        &mut lines,
    );
    let map_origin = emit("IFCAXIS2PLACEMENT3D(#3,$,$)".to_string(), &mut lines);
    let rep_map = emit(
        format!("IFCREPRESENTATIONMAP(#{map_origin},#{map_rep})"),
        &mut lines,
    );
    // Identity MappingTarget: every occurrence differs ONLY by its placement.
    let target = emit(
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#3,1.,$)".to_string(),
        &mut lines,
    );

    for (k, x) in PLACEMENT_X.iter().enumerate() {
        let point = emit(format!("IFCCARTESIANPOINT(({x:?},0.,0.))"), &mut lines);
        let axis = emit(format!("IFCAXIS2PLACEMENT3D(#{point},$,$)"), &mut lines);
        let placement = emit(format!("IFCLOCALPLACEMENT($,#{axis})"), &mut lines);
        let item = emit(format!("IFCMAPPEDITEM(#{rep_map},#{target})"), &mut lines);
        let shape = emit(
            format!("IFCSHAPEREPRESENTATION(#6,'Body','MappedRepresentation',(#{item}))"),
            &mut lines,
        );
        let definition = emit(
            format!("IFCPRODUCTDEFINITIONSHAPE($,$,(#{shape}))"),
            &mut lines,
        );
        emit(
            format!(
                "IFCFURNISHINGELEMENT('2Ab{k}cdefghijklmnopqrst',$,'seat{k}',$,$,#{placement},#{definition},$)"
            ),
            &mut lines,
        );
    }

    format!("{HEADER}{}\nENDSEC;\nEND-ISO-10303-21;\n", lines.join("\n"))
}

const HEADER: &str = r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-01-01T00:00:00',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);
#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);
#7=IFCPROJECT('11tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);
"##;

/// Run the fixture with the local frame forced OFF (see the module doc), and
/// restore the ambient setting so a shared test process is unaffected.
///
/// `local_frame_set_enabled_override` writes a process-global atomic, and the
/// two tests in this file run on separate threads of one process, so the
/// set/run/restore has to be serialized: without the lock one test's restore
/// lands mid-`process_geometry` in the other, which under `IFC_LITE_LOCAL_FRAME=1`
/// silently hands it the ambient frame and breaks the module doc's promise that
/// these measure the same thing in every environment.
fn meshes_in_native_frame() -> Vec<MeshData> {
    static FRAME_OVERRIDE: Mutex<()> = Mutex::new(());
    let _guard = FRAME_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner());
    local_frame_set_enabled_override(Some(false));
    let result = process_geometry(fixture().as_bytes());
    local_frame_set_enabled_override(None);
    result.meshes
}


#[test]
fn occurrences_of_one_representation_map_share_one_buffer_shape() {
    let meshes = meshes_in_native_frame();
    assert_eq!(
        meshes.len(),
        PLACEMENT_X.len(),
        "expected one mesh per mapped occurrence"
    );

    // The defect's signature is identical triangle counts with differing vertex
    // counts: the weld never touches the index count, only the vertex array.
    let triangles: Vec<usize> = meshes.iter().map(|m| m.indices.len() / 3).collect();
    assert_eq!(
        triangles,
        vec![TRIANGLES; PLACEMENT_X.len()],
        "two quads triangulate to {TRIANGLES} triangles at every placement"
    );

    let vertices: Vec<usize> = meshes.iter().map(|m| m.positions.len() / 3).collect();
    assert_eq!(
        vertices,
        vec![WELDED_VERTICES; PLACEMENT_X.len()],
        "every occurrence of one IfcRepresentationMap must weld identically, \
         whatever its placement. {RAW_VERTICES} means nothing welded at all; \
         fewer than {WELDED_VERTICES} at the far placement means the weld ran on \
         baked world coordinates and merged the two quads (got {vertices:?})"
    );

    // Shape identity, not merely equal counts: every occurrence carries the same
    // index and normal buffers as the template.
    //
    // There is deliberately NO position-delta assertion here. Any tolerance loose
    // enough for f32 world storage at 128 m (one ULP is 1.5e-5 m there) is far
    // looser than the 1e-6 m that separates the two quads, so it could not tell
    // them apart and would only restate the vertex count. The sharp form is the
    // coincident-pair assertion below, which is exact.
    let template = &meshes[0];
    for (k, mesh) in meshes.iter().enumerate() {
        assert_eq!(
            mesh.indices, template.indices,
            "occurrence {k} must share the template's index buffer"
        );
        assert_eq!(
            mesh.normals, template.normals,
            "occurrence {k} must share the template's normals"
        );
    }

    // The sharp form: at the FARTHEST placement the two quads' corners land on
    // the same f32 world coordinates, and they are still separate vertices. That
    // is only true of a mesh welded in the object frame. A weld run on these
    // baked positions would have merged them, which is exactly how the ten
    // occurrences in #4103 ended up with different vertex counts.
    let far = meshes.last().expect("three occurrences");
    let mut coincident = 0usize;
    for a in 0..WELDED_VERTICES {
        for b in (a + 1)..WELDED_VERTICES {
            let same_position = (0..3).all(|k| far.positions[a * 3 + k] == far.positions[b * 3 + k]);
            let same_normal = (0..3).all(|k| far.normals[a * 3 + k] == far.normals[b * 3 + k]);
            if same_position && same_normal {
                coincident += 1;
            }
        }
    }
    assert_eq!(
        coincident, 4,
        "at x={} the two quads' four corner pairs must share f32 world positions \
         AND normals and still be separate vertices; {coincident} such pairs \
         survived, so the weld is still keying on baked coordinates",
        PLACEMENT_X[PLACEMENT_X.len() - 1],
    );
}

#[test]
fn the_shared_map_collates_into_one_template() {
    let meshes = meshes_in_native_frame();
    let refs: Vec<InstanceMeshRef> = meshes
        .iter()
        .map(|m| InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance.as_ref(),
            entity_id: m.express_id,
            color: m.color,
            item_id: None,
        })
        .collect();
    // The same call `apps/server/src/services/parquet_instancing.rs` makes:
    // group anything that repeats at all (`min_group` 2), no RTC rebase.
    let collated = collate_refs(&refs, 2, [0.0, 0.0, 0.0]);

    assert_eq!(
        collated.templates.len(),
        1,
        "three occurrences of one representation map are one template"
    );
    assert_eq!(
        collated.templates[0].occurrences.len(),
        PLACEMENT_X.len(),
        "every occurrence must be instanced against that template"
    );
    assert!(
        collated.flat_indices.is_empty(),
        "no occurrence should fall back to the flat path: {:?}",
        collated.flat_indices
    );
    // The count that made the defect invisible: a group whose members disagree
    // on vertex count is refused WHOLE, so this was 1 before the fix.
    assert_eq!(
        collated.verification_rejections, 0,
        "the group must survive the #3666 reconstruction check"
    );
}
