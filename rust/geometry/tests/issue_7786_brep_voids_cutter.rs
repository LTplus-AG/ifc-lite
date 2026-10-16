// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7786: `*BrepWithVoids` used as a boolean cutter, and bounded half-space
//! boundaries past the vertex cap.
//!
//! The host is a 2 x 2 x 2 box (x, y in [-1, 1], z in [0, 2]; volume 8).

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::{BoolFailureReason, GeometryRouter, Mesh};

/// The host: a 2 x 2 rectangle extruded 2 along +Z, plus the shared placement
/// and plane entities the cutters below reference.
///
/// - `#4` is the identity placement, `#11` sits at z = 1 (axis +Z).
/// - `#12` is the plane z = 1, normal +Z. With `AgreementFlag = .F.` the
///   half-space material is ABOVE it, so a DIFFERENCE keeps z in [0, 1].
const HOST: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
#2=IFCDIRECTION((0.,0.,1.));\n\
#3=IFCDIRECTION((1.,0.,0.));\n\
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);\n\
#5=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);\n\
#6=IFCEXTRUDEDAREASOLID(#5,#4,#2,2.);\n\
#10=IFCCARTESIANPOINT((0.,0.,1.));\n\
#11=IFCAXIS2PLACEMENT3D(#10,#2,#3);\n\
#12=IFCPLANE(#11);\n";

struct Meshed {
    result: ifc_lite_geometry::Result<Mesh>,
    failures: Vec<BoolFailureReason>,
}

impl Meshed {
    fn volume(&self) -> f64 {
        let mesh = self.result.as_ref().expect("the boolean item must mesh, not error");
        mesh_volume(mesh)
    }

    fn assert_volume(&self, expected: f64, what: &str) {
        let volume = self.volume();
        assert!(
            (volume - expected).abs() < 1e-3,
            "{what}: volume {volume}, expected {expected}; failures {:?}",
            self.failures
        );
    }

    fn recorded(&self, wanted: impl Fn(&BoolFailureReason) -> bool) -> bool {
        self.failures.iter().any(wanted)
    }
}

/// Mesh representation item `#id` of `data` through a fresh router.
fn mesh_item(data: &str, id: u32) -> Meshed {
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(id).expect("the item decodes");
    let router = GeometryRouter::new();
    let result = router.process_representation_item(&entity, &mut decoder);
    let failures = router
        .take_csg_failures()
        .into_values()
        .flatten()
        .map(|f| f.reason)
        .collect();
    Meshed { result, failures }
}

/// An axis-aligned box `[lo, hi]` as an `IfcClosedShell` of six outward-wound
/// polyloop faces, numbered from `first` (the shell itself is `#first`).
fn box_shell(first: u32, lo: [f64; 3], hi: [f64; 3]) -> String {
    let corner = |i: usize| {
        [
            if i & 1 == 0 { lo[0] } else { hi[0] },
            if i & 2 == 0 { lo[1] } else { hi[1] },
            if i & 4 == 0 { lo[2] } else { hi[2] },
        ]
    };
    // Outward winding (right-hand rule) for each face, as corner indices.
    let faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]];
    let mut out = String::new();
    let point = |i: usize| first + 1 + i as u32;
    for i in 0..8 {
        let [x, y, z] = corner(i);
        out += &format!("#{}=IFCCARTESIANPOINT(({x:?},{y:?},{z:?}));\n", point(i));
    }
    let mut face_ids = Vec::new();
    for (k, f) in faces.iter().enumerate() {
        let base = first + 10 + 3 * k as u32;
        let refs: Vec<String> = f.iter().map(|&i| format!("#{}", point(i))).collect();
        out += &format!("#{}=IFCPOLYLOOP(({}));\n", base, refs.join(","));
        out += &format!("#{}=IFCFACEOUTERBOUND(#{},.T.);\n", base + 1, base);
        out += &format!("#{}=IFCFACE((#{}));\n", base + 2, base + 1);
        face_ids.push(format!("#{}", base + 2));
    }
    out += &format!("#{first}=IFCCLOSEDSHELL(({}));\n", face_ids.join(","));
    out
}


/// Cutter = box x, y in [0, 2], z in [1, 3] with a void x, y in [0.25, 0.75],
/// z in [1.25, 1.75] strictly INSIDE the host overlap. The cutter removes the
/// box x, y in [0, 1], z in [1, 2] (volume 1) minus the void (0.125): the void
/// is empty space the cutter does not own, so the host keeps it.
#[test]
fn issue_7786_a_faceted_brep_with_voids_cutter_does_not_cut_its_voids() {
    let cutter = box_shell(300, [0.0, 0.0, 1.0], [2.0, 2.0, 3.0]);
    let void = box_shell(400, [0.25, 0.25, 1.25], [0.75, 0.75, 1.75]);
    let data = format!("{HOST}{cutter}{void}#91=IFCFACETEDBREPWITHVOIDS(#300,(#400));\n\
        #20=IFCBOOLEANRESULT(.DIFFERENCE.,#6,#91);\n");
    let meshed = mesh_item(&data, 20);
    meshed.assert_volume(8.0 - (1.0 - 0.125), "host minus a hollow faceted cutter");
    assert!(meshed.failures.is_empty(), "{:?}", meshed.failures);
}

/// A void shell wound INWARD (normals into the cavity, one of the two
/// conventions exporters use) gives the same answer.
#[test]
fn issue_7786_a_void_shell_wound_inward_cuts_the_same() {
    let cutter = box_shell(300, [0.0, 0.0, 1.0], [2.0, 2.0, 3.0]);
    let void = reverse_shell(&box_shell(400, [0.25, 0.25, 1.25], [0.75, 0.75, 1.75]));
    let data = format!("{HOST}{cutter}{void}#91=IFCFACETEDBREPWITHVOIDS(#300,(#400));\n\
        #20=IFCBOOLEANRESULT(.DIFFERENCE.,#6,#91);\n");
    mesh_item(&data, 20).assert_volume(8.0 - (1.0 - 0.125), "inward-wound void");
}

/// A void that does not reach the host changes nothing (the existing #7688
/// PROC-S6 answer, 7), and a cutter with an empty Voids list is just its Outer.
#[test]
fn issue_7786_a_void_outside_the_host_changes_nothing() {
    let cutter = box_shell(300, [0.0, 0.0, 1.0], [2.0, 2.0, 3.0]);
    let void = box_shell(400, [0.5, 0.5, 2.2], [1.5, 1.5, 2.8]);
    let data = format!("{HOST}{cutter}{void}#91=IFCFACETEDBREPWITHVOIDS(#300,(#400));\n\
        #92=IFCFACETEDBREPWITHVOIDS(#300,());\n\
        #20=IFCBOOLEANRESULT(.DIFFERENCE.,#6,#91);\n\
        #21=IFCBOOLEANRESULT(.DIFFERENCE.,#6,#92);\n");
    mesh_item(&data, 20).assert_volume(7.0, "void outside the host");
    mesh_item(&data, 21).assert_volume(7.0, "empty Voids list");
}

/// A void outside the OUTER shell (bad data, but harmless: there is nothing
/// to subtract) leaves the cutter its Outer: the cut applies (7) and nothing
/// is refused (the kernel's `NoOverlap` is a miss, not a rejection).
#[test]
fn issue_7786_a_void_outside_the_outer_shell_is_not_a_refusal() {
    let cutter = box_shell(300, [0.0, 0.0, 1.0], [2.0, 2.0, 3.0]);
    let far = box_shell(400, [5.0, 5.0, 5.0], [6.0, 6.0, 6.0]);
    let data = format!("{HOST}{cutter}{far}#91=IFCFACETEDBREPWITHVOIDS(#300,(#400));\n\
        #20=IFCBOOLEANRESULT(.DIFFERENCE.,#6,#91);\n");
    let meshed = mesh_item(&data, 20);
    meshed.assert_volume(7.0, "void outside the outer shell");
    assert!(meshed.failures.is_empty(), "{:?}", meshed.failures);
}

/// Two voids, one crossing the Outer shell: the cutter is Outer minus both.
/// Void A is inside (0.125). Void B (x, y in [0.25, 0.75], z in [0.5, 1.125])
/// pokes out of the cutter's bottom face; only its part inside the cutter
/// (z in [1, 1.125], 0.03125) is not cutter material, so the host keeps it.
#[test]
fn issue_7786_multiple_voids_one_crossing_the_outer_shell() {
    let cutter = box_shell(300, [0.0, 0.0, 1.0], [2.0, 2.0, 3.0]);
    let a = box_shell(400, [0.25, 0.25, 1.25], [0.75, 0.75, 1.75]);
    let b = box_shell(500, [0.25, 0.25, 0.5], [0.75, 0.75, 1.125]);
    let data = format!("{HOST}{cutter}{a}{b}#91=IFCFACETEDBREPWITHVOIDS(#300,(#400,#500));\n\
        #20=IFCBOOLEANRESULT(.DIFFERENCE.,#6,#91);\n");
    let meshed = mesh_item(&data, 20);
    meshed.assert_volume(8.0 - (1.0 - 0.125 - 0.03125), "two voids, one crossing the outer");
    assert!(meshed.failures.is_empty(), "{:?}", meshed.failures);
}

/// A Voids reference that does not mesh refuses the cut (host uncut, 8) with a
/// counted record (D3) instead of cutting as if the void were material.
#[test]
fn issue_7786_an_unreadable_void_refuses_the_cut_on_record() {
    let cutter = box_shell(300, [0.0, 0.0, 1.0], [2.0, 2.0, 3.0]);
    let data = format!("{HOST}{cutter}#91=IFCFACETEDBREPWITHVOIDS(#300,(#999));\n\
        #20=IFCBOOLEANRESULT(.DIFFERENCE.,#6,#91);\n");
    let meshed = mesh_item(&data, 20);
    meshed.assert_volume(8.0, "unreadable void");
    assert_eq!(meshed.failures.len(), 1, "one refused cutter, one record: {:?}", meshed.failures);
    assert!(
        meshed.recorded(|f| matches!(f, BoolFailureReason::KernelError(m) if m.contains("IfcFacetedBrepWithVoids"))),
        "{:?}",
        meshed.failures
    );
}

/// The boundary vertex cap: a half-space bounded by a large indexed poly
/// curve is refused (host uncut, ONE record) instead of paying the prism and
/// CSG cost (11.9 s at 4,000 points before the cap). It must not take the
/// unbounded plane-clip fallback, which would remove the whole top half of
/// the host (volume 4) though the boundary is readable (D3, D16).
#[test]
fn issue_7786_an_oversized_bounded_half_space_boundary_is_refused_on_record() {
    let data = format!("{HOST}{}#13=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n", circle_boundary(34, 4000, 0.0, 3.0));
    let started = std::time::Instant::now();
    let meshed = mesh_item(&data, 20);
    assert!(started.elapsed().as_secs() < 5, "refusal must be cheap: {:?}", started.elapsed());
    meshed.assert_volume(8.0, "refused boundary leaves the host uncut");
    assert_eq!(meshed.failures.len(), 1, "one refusal, one record: {:?}", meshed.failures);
    assert!(
        meshed.recorded(|f| matches!(f, BoolFailureReason::KernelError(m) if m.contains("4000 vertices"))),
        "{:?}",
        meshed.failures
    );
}

/// In a batched chain the over-cap cutter defers to the sequential walk, which
/// still applies the good cutter (a 1 x 1 square: volume 7) and records the
/// refused one exactly once (the batched attempt's record is rewound).
#[test]
fn issue_7786_an_oversized_boundary_in_a_chain_keeps_the_good_cut() {
    let data = format!("{HOST}{}#40=IFCCARTESIANPOINT((0.,0.));\n\
        #41=IFCCARTESIANPOINT((1.,0.));\n#42=IFCCARTESIANPOINT((1.,1.));\n\
        #43=IFCCARTESIANPOINT((0.,1.));\n#44=IFCPOLYLINE((#40,#41,#42,#43,#40));\n\
        #13=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n\
        #14=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#44);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#14);\n\
        #21=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#20,#13);\n\
        #22=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n\
        #23=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#22,#14);\n", circle_boundary(34, 300, 0.0, 3.0));
    for id in [21, 23] {
        let meshed = mesh_item(&data, id);
        meshed.assert_volume(7.0, "good cutter applied, over-cap cutter refused");
        assert_eq!(meshed.failures.len(), 1, "#{id}: one refusal, one record: {:?}", meshed.failures);
    }
}

/// A closed `IfcPolyline` 256-gon repeats its first point (257 points): it is
/// 256 vertices, under the cap, and still bounds the cut.
#[test]
fn issue_7786_a_closed_polyline_at_the_cap_still_bounds_the_cut() {
    let n = 256;
    let mut out = String::new();
    let mut refs = Vec::new();
    for i in 0..n {
        let a = std::f64::consts::TAU * i as f64 / n as f64;
        let (x, y) = (0.5 + 0.25 * a.cos(), 0.5 + 0.25 * a.sin());
        out += &format!("#{}=IFCCARTESIANPOINT(({x:?},{y:?}));\n", 1000 + i);
        refs.push(format!("#{}", 1000 + i));
    }
    refs.push("#1000".to_string());
    let data = format!("{HOST}{out}#34=IFCPOLYLINE(({}));\n\
        #13=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n", refs.join(","));
    let meshed = mesh_item(&data, 20);
    let v = meshed.volume();
    assert!(v > 7.5 && v < 8.0, "bounded cut removes a small disc prism, got {v}; {:?}", meshed.failures);
    assert!(meshed.failures.is_empty(), "{:?}", meshed.failures);
}

/// `#id = IFCINDEXEDPOLYCURVE` over an `n`-point circle (radius `r`, centre
/// (`c`, `c`)), with its point list at `#id + 1`.
fn circle_boundary(id: u32, n: usize, c: f64, r: f64) -> String {
    let pts: Vec<String> = (0..n)
        .map(|i| {
            let a = std::f64::consts::TAU * i as f64 / n as f64;
            format!("({:?},{:?})", c + r * a.cos(), c + r * a.sin())
        })
        .collect();
    format!("#{}=IFCCARTESIANPOINTLIST2D(({}),$);\n#{id}=IFCINDEXEDPOLYCURVE(#{},$,.F.);\n", id + 1, pts.join(","), id + 1)
}

/// Just under the cap still bounds the cut (the cap is not a regression for
/// real boundaries).
#[test]
fn issue_7786_a_boundary_under_the_cap_still_bounds_the_cut() {
    let n = 256;
    let pts: Vec<String> = (0..n)
        .map(|i| {
            let a = std::f64::consts::TAU * i as f64 / n as f64;
            format!("({:?},{:?})", 0.5 + 0.25 * a.cos(), 0.5 + 0.25 * a.sin())
        })
        .collect();
    let data = format!("{HOST}#35=IFCCARTESIANPOINTLIST2D(({}),$);\n\
        #34=IFCINDEXEDPOLYCURVE(#35,$,.F.);\n\
        #13=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n", pts.join(","));
    let meshed = mesh_item(&data, 20);
    let v = meshed.volume();
    assert!(v > 7.5 && v < 8.0, "bounded cut removes a small disc prism, got {v}");
    assert!(
        !meshed.recorded(|f| matches!(f, BoolFailureReason::PolygonalBoundedHalfSpaceFallback)),
        "{:?}",
        meshed.failures
    );
}

/// `shell` with every polyloop reversed.
fn reverse_shell(shell: &str) -> String {
    shell
        .lines()
        .map(|l| {
            if let Some(rest) = l.split_once("=IFCPOLYLOOP((").map(|(a, b)| (a, b.trim_end_matches(");"))) {
                let (head, body) = rest;
                let body = body.trim_end_matches(')');
                let mut refs: Vec<&str> = body.split(',').collect();
                refs.reverse();
                format!("{head}=IFCPOLYLOOP(({}));", refs.join(","))
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
