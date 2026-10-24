// SPDX-License-Identifier: MPL-2.0
//! Opt-in presentation provenance (#7955 J5) on a real meshed STEP
//! tetrahedron: palette bindings, UV authority and normal provenance, and the
//! invariant that recording them changes nothing the exact path produces.
//!
//! Oracles and tolerances were fixed before the first run: copied values
//! (ids, palette indices, positions, UVs) compare exactly; triangle centroids
//! compare within 1e-6 m.
use super::presentation_tests::{job, metadata, options, Data, SOURCE};
use super::*;
use crate::types::presentation::{
    MeshPresentationProvenance, NormalProvenance, PaletteAbsence, PaletteBinding, UvAuthority,
};

const POINTS: [[f64; 3]; 4] = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
const FACES: [[usize; 3]; 4] = [[0, 1, 2], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
const GREEN: [f32; 4] = [0., 1., 0., 1.];

/// The tetrahedron wall at the origin, with a colour map and optionally a
/// texture map whose `TexCoordIndex` is `uv_index` (`$` for the spec pairing).
fn source(colours: &str, colour_index: &str, uv_index: Option<&str>) -> String {
    source_with(FACE_ROWS, TEX_COORDS, colours, colour_index, uv_index)
}

/// The authored tetrahedron `CoordIndex` and texture vertices.
pub(super) const FACE_ROWS: &str = "((1,2,3),(1,2,4),(1,4,3),(2,3,4))";
pub(super) const TEX_COORDS: &str = "((0.,0.),(1.,0.),(0.,1.),(1.,1.))";

/// [`source`] with the face set's `CoordIndex` and the texture vertices given.
pub(super) fn source_with(
    rows: &str,
    tex_coords: &str,
    colours: &str,
    colour_index: &str,
    uv_index: Option<&str>,
) -> String {
    let texture = uv_index.map_or(String::new(), |index| {
        format!(
            "\n#200=IFCIMAGETEXTURE(.T.,.F.,$,$,$,'textures/tetra.png');\n\
             #201=IFCTEXTUREVERTEXLIST({tex_coords});\n\
             #202=IFCINDEXEDTRIANGLETEXTUREMAP((#200),#13,#201,{index});"
        )
    });
    SOURCE
        .replace("#8=IFCCARTESIANPOINT((10.,20.,30.));", "#8=IFCCARTESIANPOINT((0.,0.,0.));")
        .replace(
            "#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);",
            &format!(
                "#13=IFCTRIANGULATEDFACESET(#16,$,.T.,{rows},$);\n\
                 #16=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));{texture}\n\
                 #210=IFCCOLOURRGBLIST({colours});\n\
                 #211=IFCINDEXEDCOLOURMAP(#13,$,#210,{colour_index});\n\
                 #30=IFCOPENINGELEMENT('o',$,'Opening',$,$,#9,#11,$,.OPENING.);"
            ),
        )
        .replace("'Body','SweptSolid',(#13)", "'Body','Tessellation',(#13)")
}

pub(super) const TWO: &str = "((1.,0.,0.),(0.,1.,0.))";

pub(super) struct Run {
    pub source: String,
    pub data: Data,
}

impl Run {
    pub fn from_source(source: String, textured: bool) -> Self {
        let mut decoder = EntityDecoder::new(&source);
        let full = crate::style::resolve_indexed_colour_map_full(&decoder.decode_by_id(211).unwrap(), &mut decoder);
        let data = Data {
            palettes: full.into_iter().map(|full| (13, full)).collect(),
            textures: if textured {
                ifc_lite_geometry::build_texture_index(source.as_bytes(), &mut decoder)
            } else {
                Default::default()
            },
            ..Default::default()
        };
        Self { source, data }
    }

    fn produce(&self, id: u32, provenance: bool) -> Vec<MeshData> {
        let mut decoder = EntityDecoder::new(&self.source);
        let router = GeometryRouter::with_units(&self.source, &mut decoder);
        decoder.seed_unit_scales(router.unit_scale(), 1.);
        let entity = decoder.decode_by_id(id).unwrap();
        let meta = metadata(id);
        let opts = MeshProductionOptions { presentation_provenance: provenance, ..options() };
        produce_element_meshes(&job(&entity, &meta), &self.data.ctx(), &opts, &mut decoder, &router).meshes
    }

    /// Produce with and without provenance; assert the exact output is
    /// unchanged and return the recorded bindings.
    pub fn records(&self, id: u32) -> (Vec<MeshData>, Vec<MeshPresentationProvenance>) {
        let off = self.produce(id, false);
        let on = self.produce(id, true);
        assert_same_output(&off, &on);
        assert!(off.iter().all(|m| m.presentation.is_none()), "default records nothing");
        let records = on.iter().map(|m| *m.presentation.clone().expect("opt-in records every mesh")).collect();
        (on, records)
    }
}

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|x| x.to_bits()).collect()
}

/// Every pre-existing field, bit for bit; only `presentation` may differ.
fn assert_same_output(off: &[MeshData], on: &[MeshData]) {
    assert_eq!(off.len(), on.len());
    for (a, b) in off.iter().zip(on) {
        assert_eq!(bits(&a.positions), bits(&b.positions));
        assert_eq!(bits(&a.normals), bits(&b.normals));
        assert_eq!(a.indices, b.indices);
        assert_eq!(a.uvs.as_deref().map(bits), b.uvs.as_deref().map(bits));
        assert_eq!(bits(&a.color), bits(&b.color));
        assert_eq!((a.express_id, a.geometry_item_id, a.material_id), (b.express_id, b.geometry_item_id, b.material_id));
        assert_eq!((a.geometry_class, &a.material_name, a.origin), (b.geometry_class, &b.material_name, b.origin));
        let texture = |m: &MeshData| m.texture.as_ref().map(|t| (t.texture_id, t.url.clone()));
        assert_eq!(texture(a), texture(b));
        assert_eq!(serde_json::to_string(a).unwrap(), serde_json::to_string(b).unwrap(), "payload unchanged");
    }
}

fn centroid(points: impl Iterator<Item = [f64; 3]>) -> [f64; 3] {
    let mut sum = [0.; 3];
    for p in points {
        (0..3).for_each(|k| sum[k] += p[k] / 3.);
    }
    sum
}

/// World triangle centroids of one produced mesh, sorted.
fn mesh_centroids(mesh: &MeshData) -> Vec<[f64; 3]> {
    let vertex = |i: u32| {
        let p = &mesh.positions[i as usize * 3..i as usize * 3 + 3];
        [0, 1, 2].map(|k| f64::from(p[k]) + mesh.origin[k])
    };
    let mut out: Vec<_> = mesh.indices.chunks_exact(3).map(|t| centroid(t.iter().map(|&i| vertex(i)))).collect();
    out.sort_by(|a, b| a.partial_cmp(b).unwrap());
    out
}

fn source_centroids(faces: &[usize]) -> Vec<[f64; 3]> {
    let mut out: Vec<_> = faces.iter().map(|&f| centroid(FACES[f].iter().map(|&v| POINTS[v]))).collect();
    out.sort_by(|a, b| a.partial_cmp(b).unwrap());
    out
}

fn assert_centroids(mesh: &MeshData, faces: &[usize]) {
    let (got, want) = (mesh_centroids(mesh), source_centroids(faces));
    assert_eq!(got.len(), want.len());
    for (g, w) in got.iter().zip(&want) {
        assert!((0..3).all(|k| (g[k] - w[k]).abs() <= 1e-6), "{got:?} != {want:?}");
    }
}

#[test]
fn issue_7955_j5_palette_split_parts_bind_their_source_index_and_triangles() {
    let run = Run::from_source(source(TWO, "(1,2,1,2)", None), false);
    let (meshes, records) = run.records(10);
    assert_eq!(meshes.len(), 2);
    for (index, (mesh, record)) in meshes.iter().zip(&records).enumerate() {
        assert_eq!(
            record.palette,
            Some(PaletteBinding::Bound { map_id: 211, face_set_id: 13, palette_index: index as u32 })
        );
        assert_eq!(mesh.color, [[1., 0., 0., 1.], GREEN][index]);
        // ColourIndex (1,2,1,2): entry 1 colours source triangles 0 and 2.
        assert_centroids(mesh, [&[0, 2][..], &[1, 3][..]][index]);
        assert_eq!(record.texture, None);
        // The authored CoordIndex mixes windings: (1,2,3) has normal +Z but the
        // tetrahedron lies above it, while (1,2,4) faces outward. The orienter
        // therefore flips and recomputes, and the record must say so.
        assert_eq!(record.normals, NormalProvenance::RecomputedAfterWindingRepair);
    }
}

#[test]
fn issue_7955_j5_repaired_palette_is_reported_malformed_not_bound() {
    for (colours, index) in [
        (TWO, "(1,2,1,3)"),                           // index past the end, clamped
        (TWO, "(1,2,1,0)"),                           // index below 1, clamped
        (TWO, "(1,2.,1,2)"),                          // a REAL is not an index (#7689)
        ("((1.,0.,0.),(0.,1.),(0.,0.,1.))", "(1,3,1,3)"), // bad row shifts entry 3
        ("((1.,0.,0.),(0.,1.5,0.))", "(1,2,1,2)"),    // colour outside 0..=1
        ("((1.,0.,0.),$,(0.,1.,0.),(0.,0.,1.))", "(1,3,1,3)"), // a non-list row is dropped, shifting entry 3 (#8120)
    ] {
        let run = Run::from_source(source(colours, index, None), false);
        assert!(!run.data.palettes[&13].authentic, "{colours} {index}");
        let (meshes, records) = run.records(10);
        assert_eq!(meshes.len(), 2, "display still splits as before: {colours} {index}");
        for record in records {
            assert_eq!(record.palette, Some(PaletteBinding::Absent { map_id: 211, reason: PaletteAbsence::Malformed }));
        }
    }
    assert!(Run::from_source(source(TWO, "(1,2,1,2)", None), false).data.palettes[&13].authentic);
}

#[test]
fn issue_7955_j5_uniform_palette_binds_only_the_colour_actually_displayed() {
    for (style, expected) in [
        (GREEN, PaletteBinding::Bound { map_id: 211, face_set_id: 13, palette_index: 1 }),
        ([0.2, 0.2, 0.2, 1.], PaletteBinding::Absent { map_id: 211, reason: PaletteAbsence::StyleOverride }),
    ] {
        let mut run = Run::from_source(source(TWO, "(2,2,2,2)", None), false);
        run.data.styles = [(13, GeometryStyleInfo::from_color(style))].into_iter().collect();
        let (meshes, records) = run.records(10);
        assert_eq!(meshes.len(), 1);
        assert_eq!(meshes[0].color, style);
        assert_eq!(records[0].palette, Some(expected));
    }
}

#[test]
fn issue_7955_j5_distinct_entries_sharing_one_colour_still_split_and_bind_per_entry() {
    // The display splitter groups by palette ENTRY, not by colour, so two
    // different entries with identical RGBA stay two meshes and each binds its
    // own entry. A merged mesh naming several entries cannot reach `unsplit`
    // (#8120 review).
    let same = "((0.,1.,0.),(0.,1.,0.))";
    let run = Run::from_source(source(same, "(1,2,1,2)", None), false);
    let (meshes, records) = run.records(10);
    assert_eq!(meshes.len(), 2, "split by entry, not by colour");
    for (index, record) in records.iter().enumerate() {
        assert_eq!(
            record.palette,
            Some(PaletteBinding::Bound { map_id: 211, face_set_id: 13, palette_index: index as u32 })
        );
    }
}

#[test]
fn issue_7955_j5_retopologized_body_reports_the_lost_palette_mapping() {
    let run = Run::from_source(source(TWO, "(1,2,1,2)", None), false);
    let mut decoder = EntityDecoder::new(&run.source);
    let router = GeometryRouter::with_units(&run.source, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    let entity = decoder.decode_by_id(10).unwrap();
    let meta = metadata(10);
    let job = job(&entity, &meta);
    let mut mesh = router.process_element_parts(&entity, &mut decoder).unwrap().remove(0);
    mesh.indices.truncate(9); // stated invariant: topology changed after colour indexing
    let out = super::presentation_source::fallback(
        &AssemblyJob::from(&job).with_provenance(true),
        &entity,
        mesh,
        [0.8; 4],
        &run.data.ctx(),
        &mut decoder,
        &mut None,
    );
    assert_eq!(out.len(), 1);
    assert_eq!(
        out[0].presentation.as_deref().unwrap().palette,
        Some(PaletteBinding::Absent { map_id: 211, reason: PaletteAbsence::Retopologized })
    );
}

#[test]
fn issue_7955_j5_uv_authority_follows_the_authored_texture_index() {
    for (index, authority) in [
        ("((1,2,3),(1,2,4),(1,4,3),(2,3,4))", UvAuthority::Authored),
        ("$", UvAuthority::CoordinatePaired),
        ("((1,2,3),(1,2,4),(1,4,3))", UvAuthority::Fabricated), // one row missing
        ("((1,2,3),(1,2,4),(1,4,3),(2,3,9))", UvAuthority::Fabricated), // past TexCoords
    ] {
        let run = Run::from_source(source(TWO, "(1,2,1,2)", Some(index)), true);
        let (meshes, records) = run.records(10);
        assert_eq!(meshes.len(), 1, "a valid texture wins over the palette: {index}");
        assert!(meshes[0].texture.is_some());
        let texture = records[0].texture.expect("textured mesh records its binding");
        assert_eq!((texture.texture_id, texture.face_set_id, texture.uv_authority), (200, Some(13), authority), "{index}");
        assert_eq!(
            records[0].palette,
            Some(PaletteBinding::Absent { map_id: 211, reason: PaletteAbsence::SupersededByTexture })
        );
    }
}

#[test]
fn issue_7955_j5_dropped_texture_is_reported_and_the_palette_then_binds() {
    let run = Run::from_source(source(TWO, "(1,2,1,2)", Some("$")), true);
    let mut decoder = EntityDecoder::new(&run.source);
    let router = GeometryRouter::with_units(&run.source, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    let ctx = run.data.ctx();
    let entity = decoder.decode_by_id(10).unwrap();
    let meta = metadata(10);
    let job = job(&entity, &meta);
    let mut submeshes = router.process_element_with_submeshes_textured(&entity, &mut decoder, ctx.texture_index).unwrap();
    submeshes.sub_meshes[0].uvs.as_mut().unwrap().truncate(2); // rebuilt without the UV channel
    let (split, _) = super::presentation_source::submeshes(
        &AssemblyJob::from(&job).with_provenance(true),
        submeshes,
        [0.8; 4],
        &ctx,
        &mut decoder,
        &mut None,
        0,
        super::presentation::CollectionTopology::ItemsUncut,
    );
    assert_eq!(split.len(), 2);
    for (index, mesh) in split.iter().enumerate() {
        assert!(mesh.texture.is_none());
        let record = mesh.presentation.as_deref().unwrap();
        assert_eq!(record.texture.map(|t| t.uv_authority), Some(UvAuthority::Dropped));
        assert_eq!(
            record.palette,
            Some(PaletteBinding::Bound { map_id: 211, face_set_id: 13, palette_index: index as u32 })
        );
    }
}

#[test]
fn issue_7955_j5_fixed_display_colour_overrides_palette_and_texture_bindings() {
    let run = Run::from_source(source(TWO, "(1,2,1,2)", Some("$")), true);
    let (meshes, records) = run.records(30);
    assert!(!meshes.is_empty());
    for (mesh, record) in meshes.iter().zip(records) {
        assert!(mesh.texture.is_none() && mesh.uvs.is_none());
        assert_eq!(record.texture, None);
        assert_eq!(
            record.palette,
            Some(PaletteBinding::Absent { map_id: 211, reason: PaletteAbsence::FixedDisplayColour })
        );
    }
}

#[test]
fn issue_7955_j5_normal_provenance_names_who_wrote_the_normals() {
    // Producer normals that already agree with outward winding survive; a
    // flip or a missing channel replaces them, and the record says which.
    let outward = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    for (inward, normals, expected) in [
        (false, true, NormalProvenance::Producer),
        (false, false, NormalProvenance::RecomputedMissing),
        (true, true, NormalProvenance::RecomputedAfterWindingRepair),
    ] {
        let mut mesh = ifc_lite_geometry::Mesh::new();
        mesh.positions = POINTS.iter().flatten().map(|&v| v as f32).collect();
        mesh.indices = outward.to_vec();
        if inward {
            mesh.indices.chunks_exact_mut(3).for_each(|t| t.swap(1, 2));
        }
        if normals {
            ifc_lite_geometry::calculate_normals(&mut mesh);
        }
        let mut collection = SubMeshCollection::new();
        collection.sub_meshes.push(ifc_lite_geometry::SubMesh::new(13, mesh));
        let mut decoder = EntityDecoder::new(SOURCE);
        let entity = decoder.decode_by_id(10).unwrap();
        let meta = metadata(10);
        let data = Data::default();
        let (meshes, _) = super::presentation_source::submeshes(
            &AssemblyJob::from(&job(&entity, &meta)).with_provenance(true),
            collection,
            [0.8; 4],
            &data.ctx(),
            &mut decoder,
            &mut None,
            0,
            super::presentation::CollectionTopology::ItemsUncut,
        );
        assert_eq!(meshes[0].presentation.as_deref().unwrap().normals, expected, "inward={inward} normals={normals}");
    }
}
