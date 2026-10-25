// SPDX-License-Identifier: MPL-2.0
//! #7955 J5: opt-in palette bindings on real `IfcIndexedColourMap` files
//! (issue #858 and the buildingSMART annex-E individual-colours fixture),
//! through the canonical producer.
//!
//! The oracle is decoded from the source, not from the pipeline: each palette
//! index must bind exactly the triangles whose `ColourIndex` names it (matched
//! by world centroid, 1e-6 m, fixed before the run) and show exactly its
//! `IfcColourRgbList` colour. Fixtures come from `pnpm fixtures`; a missing
//! fixture skips, and panics under `IFC_LITE_REQUIRE_FIXTURES=1` (the shared
//! testkit gate, #2802).

use ifc_lite_core::{EntityDecoder, EntityScanner};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext, MeshProductionOptions,
};
use ifc_lite_processing::style::resolve_indexed_colour_map_full;
use ifc_lite_processing::{MeshData, PaletteBinding};
use rustc_hash::FxHashMap;

const FIXTURES: [&str; 2] = [
    "issues/858_indexed_colour_map.ifc",
    "buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-individual-colors.ifc",
];
const PRODUCT: u32 = 302;
const FACE_SET: u32 = 201;
const MAP: u32 = 203;

fn floats(value: &ifc_lite_core::AttributeValue) -> Vec<f64> {
    value.as_list().unwrap().iter().map(|v| v.as_float().unwrap()).collect()
}

/// Source triangles' world centroids per 0-based palette index, decoded
/// straight from `Coordinates`, `CoordIndex` and `ColourIndex`.
fn source_oracle(decoder: &mut EntityDecoder, scale: f64) -> Vec<Vec<[f64; 3]>> {
    let face_set = decoder.decode_by_id(FACE_SET).unwrap();
    let points = decoder.decode_by_id(face_set.get_ref(0).unwrap()).unwrap();
    let points: Vec<Vec<f64>> = points.get(0).unwrap().as_list().unwrap().iter().map(floats).collect();
    let map = decoder.decode_by_id(MAP).unwrap();
    let palette: Vec<usize> = map.get(3).unwrap().as_list().unwrap().iter().map(|v| v.as_int().unwrap() as usize - 1).collect();
    let mut out = vec![Vec::new(); palette.iter().max().unwrap() + 1];
    for (triangle, &index) in face_set.get(3).unwrap().as_list().unwrap().iter().zip(&palette) {
        let corners: Vec<usize> = triangle.as_list().unwrap().iter().map(|v| v.as_int().unwrap() as usize - 1).collect();
        out[index].push([0, 1, 2].map(|k| corners.iter().map(|&c| points[c][k] * scale).sum::<f64>() / 3.));
    }
    out
}

fn centroids(mesh: &MeshData) -> Vec<[f64; 3]> {
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            [0, 1, 2].map(|k| {
                t.iter().map(|&i| f64::from(mesh.positions[i as usize * 3 + k]) + mesh.origin[k]).sum::<f64>() / 3.
            })
        })
        .collect()
}

fn same_set(mut got: Vec<[f64; 3]>, mut want: Vec<[f64; 3]>) -> bool {
    let order = |a: &[f64; 3], b: &[f64; 3]| a.partial_cmp(b).unwrap();
    got.sort_by(order);
    want.sort_by(order);
    got.len() == want.len() && got.iter().zip(&want).all(|(g, w)| (0..3).all(|k| (g[k] - w[k]).abs() <= 1e-6))
}

#[test]
fn issue_7955_j5_real_palette_files_bind_every_triangle_to_its_source_index() {
    let mut ran = 0;
    for fixture in FIXTURES {
        let Some(content) = ifc_lite_testkit::fixture_text(fixture) else {
            eprintln!("skipping {fixture}: run `pnpm fixtures`");
            continue;
        };
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::with_units(&content, &mut decoder);
        decoder.seed_unit_scales(router.unit_scale(), 1.0);
        let mut palettes = FxHashMap::default();
        let mut scanner = EntityScanner::new(content.as_bytes());
        while let Some((id, name, start, end)) = scanner.next_entity() {
            if name.eq_ignore_ascii_case("IFCINDEXEDCOLOURMAP") {
                let map = decoder.decode_at_with_id(id, start, end).unwrap();
                let full = resolve_indexed_colour_map_full(&map, &mut decoder).unwrap();
                assert!(full.authentic, "{fixture}: the authored map is verbatim");
                palettes.insert(full.geometry_id, full);
            }
        }
        let colours = palettes[&FACE_SET].colours.clone();
        let oracle = source_oracle(&mut decoder, router.unit_scale());
        let empty = FxHashMap::default();
        let (styles, materials, textures) = (FxHashMap::default(), FxHashMap::default(), FxHashMap::default());
        let ctx = MeshProductionContext {
            void_index: &empty,
            geometry_style_index: &styles,
            indexed_colour_full: &palettes,
            element_material_colors: &materials,
            texture_index: &textures,
            site_local_rotation: None,
        };
        let entity = decoder.decode_by_id(PRODUCT).unwrap();
        let job = ElementMeshJob {
            id: PRODUCT,
            ifc_type: entity.ifc_type.clone(),
            entity: &entity,
            kind: ElementJobKind::Product,
            element_color: None,
            metadata: None,
        };
        let opts = MeshProductionOptions { presentation_provenance: true, ..Default::default() };
        let meshes = produce_element_meshes(&job, &ctx, &opts, &mut decoder, &router).meshes;
        assert_eq!(meshes.len(), oracle.len(), "{fixture}: one mesh per used palette entry");
        for mesh in &meshes {
            let Some(PaletteBinding::Bound { map_id, face_set_id, palette_index }) =
                mesh.presentation.as_deref().and_then(|p| p.palette)
            else {
                panic!("{fixture}: every part is bound, got {:?}", mesh.presentation);
            };
            assert_eq!((map_id, face_set_id), (MAP, FACE_SET), "{fixture}");
            let index = palette_index as usize;
            assert_eq!(mesh.color, colours[index].to_array(), "{fixture}: index {index} shows its own colour");
            assert!(
                same_set(centroids(mesh), oracle[index].clone()),
                "{fixture}: index {index} binds exactly its source triangles"
            );
        }
        ran += 1;
    }
    if ran == 0 {
        eprintln!("skipping: no palette fixture present");
    }
}
