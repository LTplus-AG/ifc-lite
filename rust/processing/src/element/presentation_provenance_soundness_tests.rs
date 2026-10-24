// SPDX-License-Identifier: MPL-2.0
//! #7955 J5 provenance soundness: a record may claim a source binding only
//! when the shipped triangles provably are the source rows it names. Each
//! case below was a false `Authored` / `Bound` (or an unpinned path) before.
//!
//! Oracles fixed before the run: ids, palette indices and enum verdicts
//! compare exactly; the display output must be unchanged by recording
//! (`Run::records` asserts it bit for bit).
use super::presentation_provenance_tests::{source_with, Run, FACE_ROWS, TEX_COORDS, TWO};
use super::presentation_tests::{job, metadata};
use super::*;
use crate::types::presentation::{
    MeshPresentationProvenance, NormalProvenance, PaletteAbsence, PaletteBinding, UvAuthority,
};

/// Triangle 0 names point 9 of four, so the mesher drops it.
const DROPS_FIRST: &str = "((1,2,9),(1,2,4),(1,4,3),(2,3,4))";

fn uv_authority(rows: &str, tex_coords: &str, index: &str) -> UvAuthority {
    let run = Run::from_source(source_with(rows, tex_coords, TWO, "(1,2,1,2)", Some(index)), true);
    let (meshes, records) = run.records(10);
    assert_eq!(meshes.len(), 1, "{rows} {index}");
    assert!(meshes[0].texture.is_some(), "{rows} {index}");
    records[0].texture.expect("textured mesh records its binding").uv_authority
}

#[test]
fn issue_7955_j5_uv_authority_judges_the_rows_the_mesher_actually_sampled() {
    // Three triangles ship; the last samples row 3, whose `9` is past
    // TexCoords, so one corner is a made-up (0, 0). Judging "the first three
    // rows" called this Authored.
    assert_eq!(uv_authority(DROPS_FIRST, TEX_COORDS, "((1,2,3),(1,2,4),(1,4,3),(2,3,9))"), UvAuthority::Fabricated);
    // The bad row is the dropped triangle's own: every shipped UV is authored.
    assert_eq!(uv_authority(DROPS_FIRST, TEX_COORDS, "((1,2,9),(1,2,4),(1,4,3),(2,3,4))"), UvAuthority::Authored);
    // `$` pairing is now checked: three texture vertices cannot pair point 4.
    assert_eq!(uv_authority(FACE_ROWS, "((0.,0.),(1.,0.),(0.,1.))", "$"), UvAuthority::Fabricated);
    assert_eq!(uv_authority(DROPS_FIRST, TEX_COORDS, "$"), UvAuthority::CoordinatePaired);
}

/// The tetrahedron wall whose body is an `IfcPolygonalFaceSet`: a planar quad
/// (two triangles) and a collinear triangle (none), coloured per face.
fn polygonal(colour_index: &str) -> String {
    source_with(FACE_ROWS, TEX_COORDS, TWO, colour_index, None)
        .replace(
            &format!("#13=IFCTRIANGULATEDFACESET(#16,$,.T.,{FACE_ROWS},$);"),
            "#13=IFCPOLYGONALFACESET(#16,$,(#40,#41),$);\n\
             #40=IFCINDEXEDPOLYGONALFACE((1,2,3,4));#41=IFCINDEXEDPOLYGONALFACE((1,2,5));",
        )
        .replace(
            "#16=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));",
            "#16=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),(2.,0.,0.)));",
        )
}

fn palettes(records: &[MeshPresentationProvenance]) -> Vec<Option<PaletteBinding>> {
    records.iter().map(|record| record.palette).collect()
}

#[test]
fn issue_7955_j5_polygonal_face_set_is_never_bound_by_triangle_index() {
    // ColourIndex (1,2) is per FACE. The quad yields two triangles and the
    // collinear face none, so the count matches and display splits the quad
    // by triangle index (existing behaviour, unchanged); half of face 1 shows
    // entry 2. No part may claim a source binding.
    let run = Run::from_source(polygonal("(1,2)"), false);
    let (meshes, records) = run.records(10);
    assert_eq!(meshes.len(), 2, "display still splits as before");
    let lost = Some(PaletteBinding::Absent { map_id: 211, reason: PaletteAbsence::Retopologized });
    assert_eq!(palettes(&records), [lost, lost]);
    // A uniform per-face map does not split; it is not bound either.
    let (meshes, records) = Run::from_source(polygonal("(2,2)"), false).records(10);
    assert_eq!(meshes.len(), 1);
    assert_eq!(palettes(&records), [lost]);
}

#[test]
fn issue_7955_j5_dropped_triangle_breaks_the_triangle_to_row_correspondence() {
    // The mesher drops row 0, so three triangles ship and ColourIndex has
    // three entries: the split happens (existing display), but shipped
    // triangle 0 is source row 1.
    let run = Run::from_source(source_with(DROPS_FIRST, TEX_COORDS, TWO, "(1,2,1)", None), false);
    let (meshes, records) = run.records(10);
    assert_eq!(meshes.len(), 2, "display still splits as before");
    let lost = Some(PaletteBinding::Absent { map_id: 211, reason: PaletteAbsence::Retopologized });
    assert_eq!(palettes(&records), [lost, lost]);
}

/// A unit cube wall whose 12 rows alternate two palette entries, with the
/// opening `#30`: a 3x3x2 box whose min corner sits at `opening_min`.
fn voided_cube(opening_min: [f64; 3]) -> Run {
    const CUBE_ROWS: &str = "((1,3,2),(1,4,3),(5,6,7),(5,7,8),(1,2,6),(1,6,5),\
                             (4,8,7),(4,7,3),(1,5,8),(1,8,4),(2,3,7),(2,7,6))";
    let [x, y, z] = opening_min;
    let (x, y) = (x + 1.5, y + 1.5); // the profile is centred on the placement
    let source = source_with(CUBE_ROWS, TEX_COORDS, TWO, &format!("({})", ["1,2"; 6].join(",")), None)
        .replace(
            "#16=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));",
            "#16=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.),(0.,1.,0.),\
             (0.,0.,1.),(1.,0.,1.),(1.,1.,1.),(0.,1.,1.)));",
        )
        .replace(
            "#30=IFCOPENINGELEMENT('o',$,'Opening',$,$,#9,#11,$,.OPENING.);",
            &format!(
                "#30=IFCOPENINGELEMENT('o',$,'Opening',$,$,#50,#53,$,.OPENING.);\n\
                 #50=IFCLOCALPLACEMENT($,#51);#51=IFCAXIS2PLACEMENT3D(#52,$,$);\
                 #52=IFCCARTESIANPOINT(({x:?},{y:?},{z:?}));\n\
                 #53=IFCPRODUCTDEFINITIONSHAPE($,$,(#54));\
                 #54=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#55));\n\
                 #55=IFCEXTRUDEDAREASOLID(#56,#5,#15,2.);#56=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,3.,3.);"
            ),
        );
    let mut run = Run::from_source(source, false);
    run.data.openings.insert(10, vec![30]);
    run
}

#[test]
fn issue_7955_j5_void_cut_submeshes_never_bind_even_when_the_cut_keeps_the_count() {
    // Each cut leaves a box: 12 triangles again, so ColourIndex still has
    // one entry per triangle and display splits as before. But the cut
    // rebuilt the body; e.g. the top-face rows (z = 1) no longer exist.
    for (opening_min, axis, kept_max) in [([-1., -1., 0.5], 2, 0.5), ([0.75, -1., -0.5], 0, 0.75)] {
        let (meshes, records) = voided_cube(opening_min).records(10);
        assert_eq!(meshes.len(), 2, "{opening_min:?}: display still splits");
        let max = meshes.iter().flat_map(|m| m.positions.chunks_exact(3)).map(|p| p[axis]).fold(f32::MIN, f32::max);
        assert_eq!(max, kept_max, "{opening_min:?}: the opening cut the body");
        assert_eq!(meshes.iter().map(|m| m.indices.len() / 3).sum::<usize>(), 12, "{opening_min:?}");
        let unproven = Some(PaletteBinding::Absent { map_id: 211, reason: PaletteAbsence::Unproven });
        assert_eq!(palettes(&records), [unproven, unproven], "{opening_min:?}");
    }
}

#[test]
fn issue_7955_j5_only_an_unsliced_textured_product_is_proven_uncut() {
    use super::plan::PrimaryStrategy::{TexturedSubmeshes, VoidedSubmeshes};
    use super::presentation::CollectionTopology::{ItemsUncut, MayBeRebuilt};
    let layer = GEOM_CLASS_LAYER_SLICE;
    assert_eq!(TexturedSubmeshes.topology(0), ItemsUncut);
    assert_eq!(TexturedSubmeshes.topology(layer), MayBeRebuilt);
    assert_eq!(VoidedSubmeshes.topology(0), MayBeRebuilt);
    assert_eq!(VoidedSubmeshes.topology(layer), MayBeRebuilt);
}

/// The wall's merged fallback body, through the void-cut/plain-parts funnel.
fn run_fallback(run: &Run, edit: impl FnOnce(&mut ifc_lite_geometry::Mesh)) -> Vec<MeshData> {
    let mut decoder = EntityDecoder::new(&run.source);
    let router = GeometryRouter::with_units(&run.source, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    let entity = decoder.decode_by_id(10).unwrap();
    let meta = metadata(10);
    let job = job(&entity, &meta);
    let mut mesh = router.process_element_parts(&entity, &mut decoder).unwrap().remove(0);
    edit(&mut mesh);
    super::presentation_source::fallback(
        &AssemblyJob::from(&job).with_provenance(true),
        &entity,
        mesh,
        [0.8; 4],
        &run.data.ctx(),
        &mut decoder,
        &mut None,
    )
}

#[test]
fn issue_7955_j5_fallback_body_with_a_matching_count_is_unproven_not_bound() {
    // A void cut can keep the triangle count, and a merged body holds other
    // items: the fallback funnel splits by index but proves nothing.
    let run = Run::from_source(source_with(FACE_ROWS, TEX_COORDS, TWO, "(1,2,1,2)", None), false);
    let out = run_fallback(&run, |_| {});
    assert_eq!(out.len(), 2, "the count still matches, so display splits");
    for mesh in &out {
        assert_eq!(
            mesh.presentation.as_deref().unwrap().palette,
            Some(PaletteBinding::Absent { map_id: 211, reason: PaletteAbsence::Unproven })
        );
    }
}

#[test]
fn issue_7955_j5_fallback_winding_repair_is_recorded() {
    // The fallback funnel's own flip recomputes normals; a missing channel is
    // repaired further down, and agreeing producer normals survive.
    let run = Run::from_source(source_with(FACE_ROWS, TEX_COORDS, TWO, "(2,2,2,2)", None), false);
    let outward = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    for (inward, normals, expected) in [
        (true, true, NormalProvenance::RecomputedAfterWindingRepair),
        (false, true, NormalProvenance::Producer),
        (false, false, NormalProvenance::RecomputedMissing),
    ] {
        let out = run_fallback(&run, |mesh| {
            *mesh = ifc_lite_geometry::Mesh::new();
            mesh.positions = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]].concat();
            mesh.indices = outward.to_vec();
            if inward {
                mesh.indices.chunks_exact_mut(3).for_each(|t| t.swap(1, 2));
            }
            if normals {
                ifc_lite_geometry::calculate_normals(mesh);
            }
        });
        assert_eq!(out.len(), 1);
        let record = out[0].presentation.as_deref().unwrap();
        assert_eq!(record.normals, expected, "inward={inward} normals={normals}");
    }
}

#[test]
fn issue_7955_j5_default_path_provenance_growth_is_bounded() {
    // The field is one pointer. Measured on x86_64 at base b96e198f61:
    // MeshData was 960 B with align 16, so the 8 B field rounds it up to
    // 976 B, not 968 B. Rust already reorders fields, so placement cannot
    // reclaim the padding.
    let mesh = MeshData::new(1, String::new(), Vec::new(), Vec::new(), Vec::new(), [0.; 4]);
    assert_eq!(std::mem::size_of_val(&mesh.presentation), std::mem::size_of::<usize>());
    assert!(std::mem::size_of::<MeshData>() <= 976, "{} B", std::mem::size_of::<MeshData>());
}
