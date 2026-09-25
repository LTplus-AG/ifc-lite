// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #5739: with per-element local frames on (the wasm and viewer
//! default), a plan-rotated voided wall came back open while the native
//! world path was closed. The analytic prism cut's closure verdict, and the
//! wall-frame snap tolerance, read the vertices at their stored precision,
//! so the same wall took a different route in each vertex frame.
//!
//! The model is a neutral reproduction of a curtain-wall layer (first built
//! for #5635): a 44.7 m, 80 mm voided leaf ~86 m from the origin, turned in
//! plan, whose 13 window voids are re-cut by tessellated box openings that
//! remove nothing. Every angle is asserted in BOTH vertex frames, each chosen
//! by an explicit router policy rather than the process-global env/override.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext,
    MeshProductionOptions,
};
use ifc_lite_processing::MeshData;
use rustc_hash::FxHashMap;
use std::collections::HashMap;

const RUN: f64 = 44_700.0;
const HEIGHT: f64 = 2_988.0;
const THICK: f64 = 80.0;
/// Window voids along the run: `(x0, x1)` in mm, all `z` from 600 to 2475.
const WINDOWS: usize = 13;
const WIN_W: f64 = 1_815.0;
const WIN_Z: (f64, f64) = (600.0, 2_475.0);

fn window_x0(i: usize) -> f64 {
    1_200.0 + i as f64 * 3_300.0
}

fn wall_ifc(plan_deg: f64) -> String {
    let (s, c) = plan_deg.to_radians().sin_cos();
    let mut d = vec![
        "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#10);".to_string(),
        "#10=IFCUNITASSIGNMENT((#11));".into(),
        "#11=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);".into(),
        "#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);".into(),
        "#21=IFCAXIS2PLACEMENT3D(#22,$,$);".into(),
        "#22=IFCCARTESIANPOINT((0.,0.,0.));".into(),
        "#30=IFCSITE('1YvctVUKr0kugbFTf53O9L',$,'S',$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);".into(),
        "#31=IFCLOCALPLACEMENT($,#21);".into(),
        "#32=IFCRELAGGREGATES('2YvctVUKr0kugbFTf53O9L',$,$,$,#1,(#30));".into(),
        "#33=IFCRELCONTAINEDINSPATIALSTRUCTURE('3YvctVUKr0kugbFTf53O9L',$,$,$,(#100),#30);".into(),
        "#40=IFCDIRECTION((0.,0.,1.));".into(),
        format!("#41=IFCDIRECTION(({c:.15},{s:.15},0.));"),
        "#42=IFCCARTESIANPOINT((44700.,73115.,13340.));".into(),
        "#43=IFCAXIS2PLACEMENT3D(#42,#40,#41);".into(),
        "#44=IFCLOCALPLACEMENT(#31,#43);".into(),
        "#45=IFCDIRECTION((0.,-1.,0.));".into(),
        "#46=IFCDIRECTION((1.,0.,0.));".into(),
        format!("#50=IFCCARTESIANPOINTLIST2D(((0.,0.),({RUN:?},0.),({RUN:?},{HEIGHT:?}),(0.,{HEIGHT:?})));"),
        "#51=IFCINDEXEDPOLYCURVE(#50,$,.F.);".into(),
    ];
    let mut voids = Vec::new();
    for i in 0..WINDOWS {
        let (x0, x1) = (window_x0(i), window_x0(i) + WIN_W);
        let (z0, z1) = WIN_Z;
        let b = 300 + 2 * i;
        d.push(format!(
            "#{b}=IFCCARTESIANPOINTLIST2D((({x0:?},{z0:?}),({x0:?},{z1:?}),({x1:?},{z1:?}),({x1:?},{z0:?})));"
        ));
        d.push(format!("#{}=IFCINDEXEDPOLYCURVE(#{b},$,.F.);", b + 1));
        voids.push(format!("#{}", b + 1));
    }
    d.push(format!("#60=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#51,({}));", voids.join(",")));
    // Profile in the wall's XZ plane, extruded along wall -Y through the leaf.
    d.push(format!("#61=IFCCARTESIANPOINT((0.,{:?},0.));", THICK / 2.0));
    d.push("#62=IFCAXIS2PLACEMENT3D(#61,#45,#46);".into());
    d.push(format!("#63=IFCEXTRUDEDAREASOLID(#60,#62,#40,{THICK:?});"));
    d.push("#90=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#63));".into());
    d.push("#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#90));".into());
    d.push("#100=IFCWALL('4YvctVUKr0kugbFTf53O9L',$,'W',$,$,#44,#91,$,.NOTDEFINED.);".into());
    // Each opening: a tessellated box exactly filling its window void, deeper
    // than the leaf. It authors no depth, so the frame comes from the host.
    for i in 0..WINDOWS {
        let (x0, x1) = (window_x0(i), window_x0(i) + WIN_W);
        let (z0, z1) = WIN_Z;
        let (y0, y1) = (-THICK, THICK);
        let b = 1000 + 20 * i;
        d.push(format!(
            "#{b}=IFCCARTESIANPOINTLIST3D((({x0:?},{y0:?},{z0:?}),({x1:?},{y0:?},{z0:?}),({x1:?},{y1:?},{z0:?}),({x0:?},{y1:?},{z0:?}),\
({x0:?},{y0:?},{z1:?}),({x1:?},{y0:?},{z1:?}),({x1:?},{y1:?},{z1:?}),({x0:?},{y1:?},{z1:?})));"
        ));
        let faces = ["1,4,3,2", "5,6,7,8", "1,2,6,5", "2,3,7,6", "3,4,8,7", "4,1,5,8"];
        let ids: Vec<String> = (0..6).map(|k| format!("#{}", b + 1 + k)).collect();
        for (k, f) in faces.iter().enumerate() {
            d.push(format!("#{}=IFCINDEXEDPOLYGONALFACE(({f}));", b + 1 + k));
        }
        d.push(format!("#{}=IFCPOLYGONALFACESET(#{b},.T.,({}),$);", b + 7, ids.join(",")));
        d.push(format!("#{}=IFCSHAPEREPRESENTATION(#20,'Body','Tessellation',(#{}));", b + 8, b + 7));
        d.push(format!("#{}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{}));", b + 9, b + 8));
        d.push(format!("#{}=IFCAXIS2PLACEMENT3D(#22,$,$);", b + 10));
        d.push(format!("#{}=IFCLOCALPLACEMENT(#44,#{});", b + 11, b + 10));
        d.push(format!(
            "#{}=IFCOPENINGELEMENT('5Yvct{i:05}Kr0kugbFTf53',$,'O',$,$,#{},#{},$,.OPENING.);",
            b + 12,
            b + 11,
            b + 9
        ));
        d.push(format!(
            "#{}=IFCRELVOIDSELEMENT('6Yvct{i:05}Kr0kugbFTf53',$,$,$,#100,#{});",
            b + 13,
            b + 12
        ));
    }
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('issue-5739'),'2;1');\n\
         FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        d.join("\n")
    )
}

fn authored_volume() -> f64 {
    (RUN * HEIGHT - WINDOWS as f64 * WIN_W * (WIN_Z.1 - WIN_Z.0)) * THICK * 1e-9
}

/// Signed volume about the mesh's bounds centre (positions are absolute).
fn signed_volume(positions: &[f32], indices: &[u32]) -> f64 {
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    for c in positions.chunks_exact(3) {
        for k in 0..3 {
            lo[k] = lo[k].min(c[k] as f64);
            hi[k] = hi[k].max(c[k] as f64);
        }
    }
    let o: [f64; 3] = std::array::from_fn(|k| (lo[k] + hi[k]) / 2.0);
    let p = |i: u32| {
        let b = i as usize * 3;
        [0, 1, 2].map(|k| positions[b + k] as f64 - o[k])
    };
    indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum()
}

/// Directed edges without their reverse, vertices welded at 0.1 mm (the
/// issue's measurement): 0 iff the leaf is closed and consistently wound.
fn unpaired_directed_edges(positions: &[f32], indices: &[u32]) -> usize {
    let key = |i: u32| {
        let b = i as usize * 3;
        [0, 1, 2].map(|k| (positions[b + k] as f64 * 1e4).round() as i64)
    };
    let mut edges: HashMap<([i64; 3], [i64; 3]), i64> = HashMap::new();
    for t in indices.chunks_exact(3) {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let (ka, kb) = (key(a), key(b));
            if ka != kb {
                *edges.entry((ka, kb)).or_insert(0) += 1;
                *edges.entry((kb, ka)).or_insert(0) -= 1;
            }
        }
    }
    edges.values().filter(|&&c| c > 0).count()
}

/// The leaf through the single production path (`produce_element_meshes`)
/// with an explicit vertex-frame policy: `false` stores world coordinates (the
/// native default), `true` stores them relative to a per-element origin (the
/// wasm default).
fn leaf_in_frame(plan_deg: f64, local_frame: bool) -> MeshData {
    let content = wall_ifc(plan_deg);
    let index = std::sync::Arc::new(build_entity_index(&content));
    let mut decoder = EntityDecoder::with_arc_index(content.as_bytes(), index);
    let router = GeometryRouter::with_scale_and_local_frame(1e-3, local_frame);
    decoder.seed_unit_scales(router.unit_scale(), 1.0);
    let openings: Vec<u32> = (0..WINDOWS as u32).map(|i| 1012 + 20 * i).collect();
    let void_index: FxHashMap<u32, Vec<u32>> = [(100, openings)].into_iter().collect();
    let (styles, colours, materials, textures) =
        (FxHashMap::default(), FxHashMap::default(), FxHashMap::default(), FxHashMap::default());
    let ctx = MeshProductionContext {
        void_index: &void_index,
        geometry_style_index: &styles,
        indexed_colour_full: &colours,
        element_material_colors: &materials,
        texture_index: &textures,
        site_local_rotation: None,
    };
    let entity = decoder.decode_by_id(100).expect("wall entity decodes");
    let job = ElementMeshJob {
        id: 100,
        ifc_type: entity.ifc_type.clone(),
        entity: &entity,
        kind: ElementJobKind::Product,
        element_color: None,
        metadata: None,
    };
    let opts = MeshProductionOptions::default();
    let mut meshes = produce_element_meshes(&job, &ctx, &opts, &mut decoder, &router).meshes;
    assert_eq!(meshes.len(), 1, "{plan_deg}°: one leaf mesh");
    meshes.pop().expect("wall mesh")
}

fn assert_leaf_closed(leaf: &MeshData, what: &str) {
    let open = unpaired_directed_edges(&leaf.positions, &leaf.indices);
    let volume = signed_volume(&leaf.positions, &leaf.indices);
    let expected = authored_volume();
    assert_eq!(
        open,
        0,
        "{what}: redundant openings must leave the rotated leaf closed ({} tris, {volume:.6} m^3)",
        leaf.indices.len() / 3
    );
    assert!(
        (volume - expected).abs() / expected < 5e-4,
        "{what}: the openings only re-cut the voids; expected {expected:.6} m^3, got {volume:.6} m^3"
    );
}

const PLAN_ANGLES: [f64; 8] = [-34.3, -12.0, 17.0, 29.0, 41.0, 61.0, 73.3, 133.0];

#[test]
fn leaf_stays_closed_in_world_and_local_vertex_frames_5739() {
    for local_frame in [false, true] {
        for deg in std::iter::once(0.0).chain(PLAN_ANGLES) {
            let leaf = leaf_in_frame(deg, local_frame);
            assert_leaf_closed(&leaf, &format!("{deg}°, local_frame={local_frame} (#5739)"));
        }
    }
}
