// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::SourceHygiene;
use crate::Mesh;

// Analytic triangular prism with a collinear point in each cap boundary. The
// zero-area cap ears join one long edge to two short side-wall edges (#7292).
fn collinear_cap_prism(apex_offset: f32, copied_cap_edge: bool) -> Mesh {
    let bottom = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.5, apex_offset, 0.0], [0.5, 1.0, 0.0]];
    let top = bottom.map(|p| [p[0], p[1], 1.0]);
    let mut mesh = Mesh::new();
    mesh.positions.extend(bottom.into_iter().flatten());
    mesh.positions.extend(top.into_iter().flatten());
    for normal in [[0.0, 0.0, -1.0], [0.0, 0.0, 1.0]] {
        for _ in 0..4 { mesh.normals.extend(normal); }
    }
    mesh.indices.extend([0, 1, 2, 1, 0, 3, 5, 4, 6, 4, 5, 7]);
    for (a, b, normal) in [(0, 2, [0.0, -1.0, 0.0]), (2, 1, [0.0, -1.0, 0.0]),
        (1, 3, [1.0, 0.5, 0.0]), (3, 0, [-1.0, 0.5, 0.0])] {
        let base = mesh.vertex_count() as u32;
        for point in [bottom[a], bottom[b], top[b], top[a]] {
            mesh.positions.extend(point); mesh.normals.extend(normal);
        }
        mesh.indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    if copied_cap_edge {
        // Coordinate-identical edge on different indices: a repair could need
        // another face's attributes, so ExactIndexed must refuse it.
        for slot in [3, 4, 9, 10] {
            let old = mesh.indices[slot] as usize * 3;
            let point = [mesh.positions[old], mesh.positions[old + 1], mesh.positions[old + 2]];
            let normal = [mesh.normals[old], mesh.normals[old + 1], mesh.normals[old + 2]];
            let index = mesh.vertex_count() as u32;
            mesh.positions.extend(point); mesh.normals.extend(normal); mesh.indices[slot] = index;
        }
    }
    mesh
}

fn array_bits(values: &[f32]) -> Vec<u32> { values.iter().map(|v| v.to_bits()).collect() }

#[test]
fn issue_7292_boolean_operand_preserves_exact_collinear_cap_subdivision() {
    let mut mesh = collinear_cap_prism(0.0, false);
    let positions = array_bits(&mesh.positions); let normals = array_bits(&mesh.normals);
    let mut legacy = mesh.clone(); legacy.clean_degenerate();
    assert!(!crate::exact_topology::strict_closed_mesh(&legacy), "legacy removal opens the boundary");
    SourceHygiene::BooleanOperand.apply(&mut mesh);
    assert!(crate::exact_topology::strict_closed_mesh(&mesh), "positive triangles pair every exact edge");
    assert_eq!(array_bits(&mesh.positions), positions, "reuse existing cap indices; no position append/move");
    assert_eq!(array_bits(&mesh.normals), normals, "parallel vertex buffers retain their index domain");
    assert_eq!(mesh.indices.len(), 36, "two zero-area ears removed, two neighbours split");
}

#[test]
fn issue_7292_boolean_operand_nonzero_thin_faces_keep_legacy_cleanup() {
    let mut mesh = collinear_cap_prism(2.0f32.powi(-20), false);
    let mut legacy = mesh.clone(); legacy.clean_degenerate();
    let positions = array_bits(&mesh.positions); let normals = array_bits(&mesh.normals);
    SourceHygiene::BooleanOperand.apply(&mut mesh);
    assert_eq!(mesh.indices, legacy.indices, "positive-area sub-grid faces get no exact-only repair");
    assert_eq!(array_bits(&mesh.positions), positions); assert_eq!(array_bits(&mesh.normals), normals);
}

#[test]
fn issue_7292_boolean_operand_refuses_coordinate_only_other_face_apex() {
    let mut mesh = collinear_cap_prism(0.0, true);
    let mut legacy = mesh.clone(); legacy.clean_degenerate();
    let positions = array_bits(&mesh.positions); let normals = array_bits(&mesh.normals);
    SourceHygiene::BooleanOperand.apply(&mut mesh);
    assert_eq!(mesh.indices, legacy.indices, "different edge indices cannot borrow or append another face's apex");
    assert_eq!(array_bits(&mesh.positions), positions); assert_eq!(array_bits(&mesh.normals), normals);
}

#[test]
fn issue_7292_boolean_operand_open_invalid_and_nonfinite_keep_legacy_cleanup() {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0.0,0.0,0.0, 1.0,0.0,0.0, 0.5,0.0,0.0, 0.0,1.0,0.0, f32::NAN,0.0,0.0];
    mesh.normals = vec![0.0; mesh.positions.len()];
    mesh.indices = vec![0,1,2, 0,2,3, 0,1,999, 0,0,1, 0,1,4];
    let mut legacy = mesh.clone(); legacy.clean_degenerate();
    let positions = array_bits(&mesh.positions); let normals = array_bits(&mesh.normals);
    SourceHygiene::BooleanOperand.apply(&mut mesh);
    assert_eq!(mesh.indices, legacy.indices, "no fabricated closure or malformed-input exception");
    assert_eq!(array_bits(&mesh.positions), positions); assert_eq!(array_bits(&mesh.normals), normals);
    assert!(mesh.positions.iter().any(|v| !v.is_finite()), "legacy leaves nonfinite handling upstream");
}

#[test]
fn issue_7292_index_only_and_preserved_face_order_keep_legacy_indices() {
    let original = collinear_cap_prism(0.0, false);
    let mut legacy = original.clone(); legacy.clean_degenerate();
    let mut textured = original.clone(); SourceHygiene::IndexOnly.apply(&mut textured);
    assert_eq!(textured.indices, legacy.indices, "textured IndexOnly keeps its existing face-index contract");
    let router = super::GeometryRouter::new();
    router.set_preserve_triangle_order(true);
    let mut ordered = original;
    SourceHygiene::BooleanOperand.for_router(&router).apply(&mut ordered);
    assert_eq!(ordered.indices, legacy.indices, "IfcIndexedColourMap's source-face order forbids inserted triangles");
    assert_eq!(array_bits(&ordered.positions), array_bits(&legacy.positions));
    assert_eq!(array_bits(&ordered.normals), array_bits(&legacy.normals));
}

// #7292 / review4302494068: test the real alternate router boundary, not only
// SourceHygiene::apply. The registered analytic producer supplies the same
// closed prism invariant as above; the router must perform the cleanup itself.
struct CapSeamProducer7292;
impl crate::GeometryProcessor for CapSeamProducer7292 {
    fn process(&self, _entity: &ifc_lite_core::DecodedEntity,
        _decoder: &mut ifc_lite_core::EntityDecoder, _schema: &ifc_lite_core::IfcSchema,
        _quality: crate::TessellationQuality) -> crate::Result<Mesh> {
        Ok(collinear_cap_prism(0.0, false))
    }
    fn supported_types(&self) -> Vec<ifc_lite_core::IfcType> {
        vec![ifc_lite_core::IfcType::IfcBlock]
    }
}
const CAP_SEAM_OPENING_7292: &str = "
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#2);
#4=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#10=IFCBLOCK(#2,1.,1.,1.);
#11=IFCSHAPEREPRESENTATION(#4,'Body','CSG',(#10));
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));
#20=IFCOPENINGELEMENT('0000000000000000000001',$,'Opening',$,$,#3,#12,$,.OPENING.);
";

#[test]
fn issue_7292_per_item_opening_applies_boolean_operand_hygiene() {
    let mut decoder = ifc_lite_core::EntityDecoder::new(CAP_SEAM_OPENING_7292);
    let opening = decoder.decode_by_id(20).unwrap();
    let mut router = super::GeometryRouter::new();
    router.register(Box::new(CapSeamProducer7292));
    let ordinary = router.process_element_parts_with_hygiene(
        &opening, &mut decoder, SourceHygiene::BooleanOperand).unwrap();
    assert_eq!(ordinary.len(), 1);
    assert!(crate::exact_topology::strict_closed_mesh(&ordinary[0]),
        "positive control: the common operand boundary repairs this source cap");
    let per_item = router.get_opening_item_meshes_world(&opening, &mut decoder).unwrap();
    assert_eq!(per_item.len(), 1);
    assert!(crate::exact_topology::strict_closed_mesh(&per_item[0]),
        "the item-bounds classification route must not bypass the same cap repair");
    assert_eq!(per_item[0].triangle_count(), ordinary[0].triangle_count());
    assert_eq!(oriented_surface_bits_7292(&per_item[0]), oriented_surface_bits_7292(&ordinary[0]),
        "canonical welding may renumber vertices but must preserve every oriented physical triangle");
    for mesh in [&per_item[0], &ordinary[0]] {
        let volume: f64 = mesh.indices.chunks_exact(3).map(|tri| {
            let [a,b,c] = [tri[0],tri[1],tri[2]].map(|index| {
                let i = index as usize * 3;
                [mesh.positions[i] as f64, mesh.positions[i+1] as f64, mesh.positions[i+2] as f64]
            });
            crate::math::v3::dot(a, crate::math::v3::cross(b,c)) / 6.0
        }).sum();
        assert!((volume.abs() - 0.5).abs() < 1e-12,
            "unit-height prism with triangular base area 1/2 retains its analytic volume");
    }
}

fn oriented_surface_bits_7292(mesh: &Mesh) -> Vec<[[u32; 3]; 3]> {
    let mut triangles: Vec<_> = mesh.indices.chunks_exact(3).map(|tri| {
        let p = [tri[0],tri[1],tri[2]].map(|index| {
            let i = index as usize * 3;
            [mesh.positions[i].to_bits(),mesh.positions[i+1].to_bits(),mesh.positions[i+2].to_bits()]
        });
        [p, [p[1],p[2],p[0]], [p[2],p[0],p[1]]].into_iter().min().unwrap()
    }).collect();
    triangles.sort_unstable();
    triangles
}

#[test]
fn issue_7292_per_item_opening_honors_preserved_face_order() {
    let mut decoder = ifc_lite_core::EntityDecoder::new(CAP_SEAM_OPENING_7292);
    let opening = decoder.decode_by_id(20).unwrap();
    let mut router = super::GeometryRouter::new();
    router.register(Box::new(CapSeamProducer7292));
    router.set_preserve_triangle_order(true);
    let per_item = router.get_opening_item_meshes_world(&opening, &mut decoder).unwrap();
    assert_eq!(per_item.len(), 1);
    let mut legacy = collinear_cap_prism(0.0, false);
    legacy.clean_degenerate();
    assert_eq!(per_item[0].indices, legacy.indices,
        "face-ordered consumers retain the existing index-only policy");
    assert_eq!(array_bits(&per_item[0].positions), array_bits(&legacy.positions));
}

// #7292 / review4302494068: cleanup can leave vertices but remove every face.
// A rejected degenerate item must not occupy a stored per-item cutter slot.
struct MixedCapSeamProducer7292;
impl crate::GeometryProcessor for MixedCapSeamProducer7292 {
    fn process(&self, entity: &ifc_lite_core::DecodedEntity,
        _decoder: &mut ifc_lite_core::EntityDecoder, _schema: &ifc_lite_core::IfcSchema,
        _quality: crate::TessellationQuality) -> crate::Result<Mesh> {
        if entity.id == 10 { return Ok(collinear_cap_prism(0.0, false)); }
        let mut mesh = Mesh::new();
        mesh.positions = vec![4.0,0.0,0.0, 5.0,0.0,0.0, 6.0,0.0,0.0];
        mesh.normals = vec![0.0; 9];
        mesh.indices = vec![0,1,2];
        Ok(mesh)
    }
    fn supported_types(&self) -> Vec<ifc_lite_core::IfcType> {
        vec![ifc_lite_core::IfcType::IfcBlock]
    }
}

#[test]
fn issue_7292_per_item_opening_omits_cleaned_zero_triangle_items() {
    let source = CAP_SEAM_OPENING_7292
        .replace("#11=", "#13=IFCBLOCK(#2,1.,1.,1.);\n#11=")
        .replace("(#10));", "(#10,#13));");
    for preserve_order in [false, true] {
        let mut decoder = ifc_lite_core::EntityDecoder::new(&source);
        let opening = decoder.decode_by_id(20).unwrap();
        let mut router = super::GeometryRouter::new();
        router.register(Box::new(MixedCapSeamProducer7292));
        router.set_preserve_triangle_order(preserve_order);
        let per_item = router.get_opening_item_meshes_world(&opening, &mut decoder).unwrap();
        assert_eq!(per_item.len(), 1, "zero-area-only sibling supplies no cutter surface");
        assert!(per_item.iter().all(|mesh| mesh.triangle_count() > 0));
        // The valid-only router reference includes normal normalization during
        // placement, as well as the selected source cleanup policy.
        let mut reference_decoder = ifc_lite_core::EntityDecoder::new(CAP_SEAM_OPENING_7292);
        let reference_opening = reference_decoder.decode_by_id(20).unwrap();
        let mut reference_router = super::GeometryRouter::new();
        reference_router.register(Box::new(CapSeamProducer7292));
        reference_router.set_preserve_triangle_order(preserve_order);
        let reference = reference_router.get_opening_item_meshes_world(
            &reference_opening, &mut reference_decoder).unwrap();
        assert_eq!(reference.len(), 1);
        let expected = &reference[0];
        assert_eq!(per_item[0].indices, expected.indices,
            "omitting an empty sibling preserves the valid item's selected cleanup policy");
        assert_eq!(array_bits(&per_item[0].positions), array_bits(&expected.positions));
        assert_eq!(array_bits(&per_item[0].normals), array_bits(&expected.normals));
        if !preserve_order {
            assert!(crate::exact_topology::strict_closed_mesh(&per_item[0]));
        }
    }
}
