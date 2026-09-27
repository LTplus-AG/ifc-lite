// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The plan-rotated voided wall shared by the #5635 and #5739 tests: a neutral
//! reproduction of a curtain-wall layer. A 44.7 m, 80 mm leaf with 13 window
//! voids (`IfcArbitraryProfileDefWithVoids`) about 86 m from the origin,
//! turned in plan, whose voids are re-cut by 13 tessellated box openings that
//! remove nothing. The wall is `#100`; its openings are `#1012 + 20 * i`.

use std::collections::HashMap;

pub const RUN: f64 = 44_700.0;
pub const HEIGHT: f64 = 2_988.0;
pub const THICK: f64 = 80.0;
/// Window voids along the run: `(x0, x1)` in mm, all `z` from 600 to 2475.
pub const WINDOWS: usize = 13;
pub const WIN_W: f64 = 1_815.0;
pub const WIN_Z: (f64, f64) = (600.0, 2_475.0);

pub fn window_x0(i: usize) -> f64 {
    1_200.0 + i as f64 * 3_300.0
}

pub fn wall_ifc(plan_deg: f64) -> String {
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
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('wall-frame-seams'),'2;1');\n\
         FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        d.join("\n")
    )
}

pub fn authored_volume() -> f64 {
    (RUN * HEIGHT - WINDOWS as f64 * WIN_W * (WIN_Z.1 - WIN_Z.0)) * THICK * 1e-9
}

/// Signed volume about the mesh's bounds centre (positions are absolute).
pub fn signed_volume(positions: &[f32], indices: &[u32]) -> f64 {
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

/// Undirected edges NOT used exactly once in each direction, vertices welded
/// at 0.1 mm (the issue's measurement): the strict directed-pair rule (#3397).
/// 0 iff the leaf is closed, consistently wound and manifold.
pub fn unpaired_directed_edges(positions: &[f32], indices: &[u32]) -> usize {
    let key = |i: u32| {
        let b = i as usize * 3;
        [0, 1, 2].map(|k| (positions[b + k] as f64 * 1e4).round() as i64)
    };
    let mut uses: HashMap<([i64; 3], [i64; 3]), (u32, u32)> = HashMap::new();
    for t in indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(t[0]), key(t[1]), key(t[2]));
        if ka == kb || kb == kc || kc == ka {
            continue;
        }
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            let e = uses.entry((x.min(y), x.max(y))).or_insert((0, 0));
            if x < y {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    uses.values().filter(|&&u| u != (1, 1)).count()
}
