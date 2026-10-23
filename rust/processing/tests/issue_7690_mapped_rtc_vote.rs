// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7690 ROUTER-27, end to end: a model whose large coordinates exist ONLY
//! inside mapped geometry (the Civil 3D mapped-terrain shape) must be detected
//! as needing a rebase, so the mapped source is rebased in f64 before it is
//! narrowed to f32.
//!
//! No `set_rtc_offset` anywhere: the RTC detector has to find the anchor
//! itself. Before the fix `sample_first_geometry_vertex` had no
//! `IfcMappedItem` arm, every proxy voted its `(0,0,0)` placement, the frame
//! stayed `RawIfc` and a 12 mm box at LV95 E 2,600,000 / N 1,200,000 collapsed
//! onto the f32 grid (~0.25 m ULP there): 0.115 m off its authored corners,
//! 0.221 m for the turned occurrence.

use ifc_lite_processing::{process, MeshData, ProcessingRequest, ProcessingResult};

/// The box's authored corners (metres, LV95), 12 x 7 x 5 mm.
const BASE: [f64; 3] = [2_600_001.4, 1_200_003.3, 400.2];
const SIZE: [f64; 3] = [0.012, 0.007, 0.005];

/// 0.1 degree about Z, the turned occurrence's placement.
const TURN_DEG: f64 = 0.1;

/// The four occurrences: (express id, placement translation, placement turn
/// in degrees, MappingTarget translation).
const OCCURRENCES: [(u32, [f64; 3], f64, [f64; 3]); 4] = [
    (100, [0.0, 0.0, 0.0], 0.0, [0.0, 0.0, 0.0]),
    (110, [10.0, 20.0, 0.0], 0.0, [0.0, 0.0, 0.0]),
    (120, [0.0, 0.0, 0.0], 0.0, [5.0, -3.0, 0.0]),
    (130, [0.0, 0.0, 0.0], TURN_DEG, [0.0, 0.0, 0.0]),
];

/// 1 mm: three orders below the 12 mm feature, two below the f32 grid at
/// these magnitudes, so a narrowed-at-survey-magnitude source cannot pass.
const TOL: f64 = 1e-3;

fn corners() -> Vec<[f64; 3]> {
    (0..8)
        .map(|i| std::array::from_fn(|k| BASE[k] + if i >> k & 1 == 1 { SIZE[k] } else { 0.0 }))
        .collect()
}

fn fmt_pt(p: [f64; 3]) -> String {
    format!("({:.6},{:.6},{:.6})", p[0], p[1], p[2])
}

fn model() -> String {
    let coords: Vec<String> = corners().into_iter().map(fmt_pt).collect();
    // 12 triangles over the 8 corners (1-based), corner index bit k = axis k.
    let tris = "((1,3,2),(2,3,4),(5,6,7),(6,8,7),(1,2,5),(2,6,5),\
                (3,7,4),(4,7,8),(1,5,3),(3,5,7),(2,4,6),(4,8,6))";
    let mut occurrences = String::new();
    for (id, t, deg, target) in OCCURRENCES {
        let (s, c) = deg.to_radians().sin_cos();
        occurrences.push_str(&format!(
            "#{p}=IFCCARTESIANPOINT({tp});\n\
             #{d}=IFCDIRECTION(({c:.17},{s:.17},0.));\n\
             #{a}=IFCAXIS2PLACEMENT3D(#{p},#40,#{d});\n\
             #{l}=IFCLOCALPLACEMENT($,#{a});\n\
             #{q}=IFCCARTESIANPOINT({tq});\n\
             #{o}=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#{q},1.,$);\n\
             #{m}=IFCMAPPEDITEM(#30,#{o});\n\
             #{r}=IFCSHAPEREPRESENTATION(#6,'Body','MappedRepresentation',(#{m}));\n\
             #{s_}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{r}));\n\
             #{id}=IFCBUILDINGELEMENTPROXY('0Proxy{id}000000000000',$,'p{id}',$,$,#{l},#{s_},$,$);\n",
            p = id + 1, d = id + 2, a = id + 3, l = id + 4, q = id + 5, o = id + 6,
            m = id + 7, r = id + 8, s_ = id + 9,
            tp = fmt_pt(t), tq = fmt_pt(target),
        ));
    }
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');\n\
         FILE_NAME('','2026-01-01T00:00:00',(''),(''),'test','test','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#2=IFCUNITASSIGNMENT((#1));\n\
         #3=IFCCARTESIANPOINT((0.,0.,0.));\n#4=IFCAXIS2PLACEMENT3D(#3,$,$);\n\
         #5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);\n\
         #6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);\n\
         #7=IFCPROJECT('0Project0000000000000a',$,'p',$,$,$,$,(#5),#2);\n\
         #20=IFCCARTESIANPOINTLIST3D(({coords}),$);\n\
         #21=IFCTRIANGULATEDFACESET(#20,$,.T.,{tris},$);\n\
         #22=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#21));\n\
         #30=IFCREPRESENTATIONMAP(#4,#22);\n\
         #40=IFCDIRECTION((0.,0.,1.));\n\
         {occurrences}ENDSEC;\nEND-ISO-10303-21;\n",
        coords = coords.join(","),
    )
}

/// An occurrence's authored world corners: placement · MappingTarget · v, f64.
fn authored_corners(t: [f64; 3], deg: f64, target: [f64; 3]) -> Vec<[f64; 3]> {
    let (s, c) = deg.to_radians().sin_cos();
    corners()
        .into_iter()
        .map(|v| {
            let m = [v[0] + target[0], v[1] + target[1], v[2] + target[2]];
            [
                c * m[0] - s * m[1] + t[0],
                s * m[0] + c * m[1] + t[1],
                m[2] + t[2],
            ]
        })
        .collect()
}

fn run(instancing: bool) -> ProcessingResult {
    process(model().as_bytes(), &ProcessingRequest::default().instancing(instancing), &mut ())
}

/// The world vertices of a template mesh, in the RTC frame (`origin + pos`).
fn frame_vertices(mesh: &MeshData) -> Vec<[f64; 3]> {
    mesh.positions
        .chunks_exact(3)
        .map(|v| std::array::from_fn(|k| mesh.origin[k] + f64::from(v[k])))
        .collect()
}

/// World vertices of occurrence `id`: its own mesh, or (instanced) its
/// template's frame vertices placed by the record's row-major `rel`, then
/// shifted back by the model anchor.
fn world_vertices(res: &ProcessingResult, id: u32) -> Vec<[f64; 3]> {
    let anchor = res.frame.rtc_offset();
    let anchor = [anchor.0, anchor.1, anchor.2];
    let shift = |p: [f64; 3]| -> [f64; 3] { std::array::from_fn(|k| p[k] + anchor[k]) };
    if let Some(mesh) = res.meshes.iter().find(|m| m.express_id == id) {
        return frame_vertices(mesh).into_iter().map(shift).collect();
    }
    let record = res
        .instances
        .iter()
        .find(|r| r.express_id == id)
        .unwrap_or_else(|| panic!("#{id}: neither a mesh nor an instance record"));
    let template = res
        .meshes
        .iter()
        .find(|m| m.express_id == record.template_express_id)
        .expect("instance record's template mesh");
    let t = record.transform.map(f64::from);
    frame_vertices(template)
        .into_iter()
        .map(|p| {
            let row = |r: usize| {
                t[4 * r] * p[0] + t[4 * r + 1] * p[1] + t[4 * r + 2] * p[2] + t[4 * r + 3]
            };
            let w = row(3);
            shift([row(0) / w, row(1) / w, row(2) / w])
        })
        .collect()
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// Worst distance between the two point sets, in both directions, so a lost
/// corner and a stray vertex both count.
fn worst_miss(mesh: &[[f64; 3]], authored: &[[f64; 3]]) -> f64 {
    let nearest = |p: [f64; 3], set: &[[f64; 3]]| {
        set.iter()
            .map(|q| dist(p, *q))
            .fold(f64::INFINITY, f64::min)
    };
    let a = authored
        .iter()
        .map(|c| nearest(*c, mesh))
        .fold(0.0, f64::max);
    let b = mesh
        .iter()
        .map(|v| nearest(*v, authored))
        .fold(0.0, f64::max);
    a.max(b)
}

#[test]
fn router_27_mapped_only_survey_geometry_is_detected_and_rebased_end_to_end() {
    let mut misses = Vec::new();
    for instancing in [false, true] {
        let res = run(instancing);
        let frame = format!(
            "{:?} rtc={:?}",
            res.mesh_coordinate_space,
            res.frame.rtc_offset()
        );
        for (id, t, deg, target) in OCCURRENCES {
            let mesh = world_vertices(&res, id);
            assert!(
                !mesh.is_empty(),
                "instancing={instancing} #{id}: no geometry"
            );
            let miss = worst_miss(&mesh, &authored_corners(t, deg, target));
            if miss > TOL {
                misses.push(format!(
                    "instancing={instancing} [{frame}] #{id} (turn {deg} deg) {miss:.3e} m"
                ));
            }
        }
        if instancing {
            assert!(
                !res.instances.is_empty(),
                "the instanced path must actually instance a shared single-item map"
            );
        }
    }
    assert!(
        misses.is_empty(),
        "authored corners lost beyond {TOL} m:\n  {}",
        misses.join("\n  "),
    );
}
