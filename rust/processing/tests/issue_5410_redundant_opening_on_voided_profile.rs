// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #5410: a Revit wall whose Body ALREADY carries its window voids
//! (`IfcArbitraryProfileDefWithVoids`) and whose `IfcOpeningElement`s cut
//! the same voids again with a stepped, tessellated cutter. The second
//! subtraction removes nothing (IfcOpenShell reports identical volumes with
//! and without openings), yet the wall came back with missing faces, missing
//! wall above and below the windows, and incomplete layers.
//!
//! Two defects compounded, and both are pinned here:
//!
//! 1. The extruder wound every profile hole's side walls INTO the solid, so
//!    the void host reached the exact kernel closed but winding-inconsistent.
//!    The cutter's faces coincide with exactly those walls, and the kernel's
//!    coplanar classification read them as solid-facing. This alone breaks
//!    the axis-aligned wall.
//! 2. On a plan-rotated wall none of these cutters authors a depth, so the
//!    wall-local frame (#1167) was never selected and the world path guessed
//!    each cutter's depth from its world AABB, which on a diagonal wall is
//!    vertical: flush sill/head caps were pushed into the wall.
//!
//! The model below is built from the reporter's geometry (numbers only): two
//! leaves of the wall with the leaf-specific voids, and the Revit cutter's
//! `IfcPolygonalFaceSet` verbatim.

use ifc_lite_processing::process_geometry;
use std::collections::HashMap;

const RUN: f64 = 5000.0;
const HEIGHT: f64 = 2988.0;
/// `(y_lo, y_hi, [x0, x1, z0, z1])` per leaf, in the wall's frame (mm).
const LEAVES: [(f64, f64, [f64; 4]); 2] = [
    (65.0, 135.0, [892.5, 2707.5, 225.0, 2400.0]),
    (-135.0, 65.0, [822.5, 2777.5, 225.0, 2470.0]),
];
const CUTTER_POINTS: &str = "((950.,3048.7055977969399,0.),(950.,3048.7055977969399,2245.),\
(1955.,3048.7055977969399,2245.),(1955.,3048.7055977969399,0.),(1955.,2119.7200037459902,2245.),\
(0.,2119.7200037459902,2245.),(0.,2119.7200037459902,0.),(70.,2119.7200037459902,0.),\
(70.,2119.7200037459902,2175.),(1885.,2119.7200037459902,2175.),(1885.,2119.7200037459902,0.),\
(1955.,2119.7200037459902,0.),(950.,2671.6477745577899,0.),(950.,2671.6477745577899,2245.),\
(0.,2671.6477745577899,2245.),(1885.,276.41804305412501,0.),(1006.,276.41804305412501,0.),\
(1006.,0.,0.),(70.,0.,0.),(0.,2671.6477745577999,0.),(1885.,276.41804305412501,2175.),\
(1006.,276.41804305412501,2175.),(70.,0.,2175.),(1006.,0.,2175.))";
const CUTTER_FACES: [&str; 14] = [
    "4,1,2,3",
    "20,15,14,13",
    "6,7,8,9,10,11,12,5",
    "17,16,21,22",
    "24,23,19,18",
    "2,1,13,14",
    "6,15,20,7",
    "23,9,8,19",
    "14,15,6,5,3,2",
    "10,9,23,24,22,21",
    "4,3,5,12",
    "18,17,22,24",
    "11,10,21,16",
    "13,1,4,12,11,16,17,18,19,8,7,20",
];

/// The wall, placed at `(41 m, 60 m)` and turned `plan_deg` about Z.
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
        "#42=IFCCARTESIANPOINT((41000.,60000.,13340.));".into(),
        "#43=IFCAXIS2PLACEMENT3D(#42,#40,#41);".into(),
        "#44=IFCLOCALPLACEMENT(#31,#43);".into(),
        "#45=IFCDIRECTION((0.,-1.,0.));".into(),
        "#46=IFCDIRECTION((1.,0.,0.));".into(),
        "#47=IFCDIRECTION((-1.,0.,0.));".into(),
    ];
    let mut items = Vec::new();
    for (i, (y_lo, y_hi, [x0, x1, z0, z1])) in LEAVES.iter().enumerate() {
        let b = 50 + 10 * i;
        d.push(format!(
            "#{b}=IFCCARTESIANPOINTLIST2D(((0.,0.),({RUN:?},0.),({RUN:?},{HEIGHT:?}),(0.,{HEIGHT:?})));"
        ));
        d.push(format!("#{}=IFCINDEXEDPOLYCURVE(#{b},$,.F.);", b + 1));
        d.push(format!(
            "#{}=IFCCARTESIANPOINTLIST2D((({x0:?},{z0:?}),({x0:?},{z1:?}),({x1:?},{z1:?}),({x1:?},{z0:?})));",
            b + 2
        ));
        d.push(format!("#{}=IFCINDEXEDPOLYCURVE(#{},$,.F.);", b + 3, b + 2));
        d.push(format!("#{}=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#{},(#{}));", b + 4, b + 1, b + 3));
        d.push(format!("#{}=IFCCARTESIANPOINT((0.,{y_hi:?},0.));", b + 5));
        // Profile in the wall's XZ plane, extruded along wall -Y from `y_hi`.
        d.push(format!("#{}=IFCAXIS2PLACEMENT3D(#{},#45,#46);", b + 6, b + 5));
        d.push(format!(
            "#{}=IFCEXTRUDEDAREASOLID(#{},#{},#40,{:?});",
            b + 7,
            b + 4,
            b + 6,
            y_hi - y_lo
        ));
        items.push(format!("#{}", b + 7));
    }
    d.push(format!("#90=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',({}));", items.join(",")));
    d.push("#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#90));".into());
    d.push("#100=IFCWALL('4YvctVUKr0kugbFTf53O9L',$,'W',$,$,#44,#91,$,.NOTDEFINED.);".into());
    d.push(format!("#200=IFCCARTESIANPOINTLIST3D({CUTTER_POINTS});"));
    let faces: Vec<String> = (0..CUTTER_FACES.len()).map(|k| format!("#{}", 201 + k)).collect();
    for (k, face) in CUTTER_FACES.iter().enumerate() {
        d.push(format!("#{}=IFCINDEXEDPOLYGONALFACE(({face}));", 201 + k));
    }
    d.push(format!("#220=IFCPOLYGONALFACESET(#200,.T.,({}),$);", faces.join(",")));
    d.push("#221=IFCSHAPEREPRESENTATION(#20,'Body','Tessellation',(#220));".into());
    d.push("#222=IFCPRODUCTDEFINITIONSHAPE($,$,(#221));".into());
    d.push("#230=IFCCARTESIANPOINT((2777.5,2184.7200037344301,225.));".into());
    d.push("#231=IFCAXIS2PLACEMENT3D(#230,#40,#47);".into());
    d.push("#232=IFCLOCALPLACEMENT(#44,#231);".into());
    d.push("#233=IFCOPENINGELEMENT('5YvctVUKr0kugbFTf53O9L',$,'O',$,$,#232,#222,$,.OPENING.);".into());
    d.push("#234=IFCRELVOIDSELEMENT('6YvctVUKr0kugbFTf53O9L',$,$,$,#100,#233);".into());
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('issue-5410'),'2;1');\n\
         FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        d.join("\n")
    )
}

/// The voided wall's volume in m^3. The opening lies wholly inside the
/// profile voids or outside the wall, so it removes nothing.
fn authored_volume() -> f64 {
    LEAVES
        .iter()
        .map(|(y_lo, y_hi, [x0, x1, z0, z1])| (RUN * HEIGHT - (x1 - x0) * (z1 - z0)) * (y_hi - y_lo))
        .sum::<f64>()
        * 1e-9
}

fn signed_volume(positions: &[f32], indices: &[u32]) -> f64 {
    let p = |i: u32| {
        let b = i as usize * 3;
        [positions[b] as f64, positions[b + 1] as f64, positions[b + 2] as f64]
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

/// Directed edges without their reverse, vertices welded at 10 µm: 0 iff the
/// leaf is closed and consistently wound.
fn unpaired_directed_edges(positions: &[f32], indices: &[u32]) -> usize {
    let key = |i: u32| {
        let b = i as usize * 3;
        [0, 1, 2].map(|k| (positions[b + k] as f64 * 1e5).round() as i64)
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
    edges.values().filter(|&&c| c != 0).count()
}

fn assert_redundant_opening_leaves_wall_intact(plan_deg: f64) {
    let result = process_geometry(wall_ifc(plan_deg).as_bytes());
    let leaves: Vec<_> = result.meshes.iter().filter(|m| m.express_id == 100).collect();
    assert_eq!(leaves.len(), 2, "{plan_deg}°: one mesh per wall leaf");
    let mut volume = 0.0;
    for leaf in &leaves {
        let open = unpaired_directed_edges(&leaf.positions, &leaf.indices);
        assert_eq!(
            open, 0,
            "{plan_deg}°: leaf {:?} must stay closed and consistently wound ({} tris)",
            leaf.geometry_item_id,
            leaf.indices.len() / 3
        );
        volume += signed_volume(&leaf.positions, &leaf.indices);
    }
    let expected = authored_volume();
    assert!(
        (volume - expected).abs() / expected < 1e-4,
        "{plan_deg}°: the opening only re-cuts the profile voids, so the wall keeps its \
         authored {expected:.6} m^3; got {volume:.6} m^3"
    );
}

#[test]
fn redundant_stepped_opening_on_axis_aligned_voided_wall_5410() {
    assert_redundant_opening_leaves_wall_intact(0.0);
}

#[test]
fn redundant_stepped_opening_on_plan_rotated_voided_wall_5410() {
    // The reporter's facade runs at -34.3° in plan.
    assert_redundant_opening_leaves_wall_intact(-34.3);
}
