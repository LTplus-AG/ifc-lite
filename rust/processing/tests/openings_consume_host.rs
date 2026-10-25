// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A wall whose openings together consume it renders nothing. When the
//! openings could not be merged into one cutter, the cut came back empty but
//! the host was not marked consumed, so the element was re-rendered uncut.
//! A partial cut stays partial and a wall its opening misses is unchanged.
//! Exposed when #7942 made the opening merge exact.
//!
//! Synthetic: a 1510 x 97 x 2110 mm wall with one opening element whose body
//! is one or two rectangular prisms. The wall's placement is varied: identity,
//! a negative quarter-turn perturbed by about +3.12e-7 rad (the two prisms
//! then miss the exact merge), the same rotation far from the origin, and
//! rotated 30 degrees (the wall-frame cut).

use ifc_lite_processing::process_geometry;
use ifc_lite_testkit::mesh::signed_volume;

const WALL: u32 = 110;
const L: f64 = 1510.0;
const T: f64 = 97.0;
const H: f64 = 2110.0;

/// Wall placement: (location, x direction).
#[derive(Clone, Copy)]
enum Placement {
    Identity,
    PerturbedNegativeQuarterTurn,
    FarAndPerturbedNegativeQuarterTurn,
    Rotated30,
}

impl Placement {
    fn location_and_x(self) -> (&'static str, &'static str) {
        const FAR: &str = "64000.000379,53465.2659693,15000.";
        match self {
            Self::Identity => ("0.,0.,0.", "1.,0.,0."),
            Self::PerturbedNegativeQuarterTurn => ("0.,0.,0.", "3.12000341089E-7,-1.,0."),
            Self::FarAndPerturbedNegativeQuarterTurn => (FAR, "3.12000341089E-7,-1.,0."),
            Self::Rotated30 => ("0.,0.,0.", "0.8660254037844387,0.5,0."),
        }
    }
}

/// One rectangular prism of the opening body, wall-high, in the opening's
/// frame (which sits at x = `opening_x` in the wall frame): profile centre,
/// extrusion axis and depth, profile width.
struct Prism {
    at: [f64; 3],
    axis: &'static str,
    depth: f64,
    width: f64,
}

fn prism(at: [f64; 3], axis: &'static str, depth: f64, width: f64) -> Prism {
    Prism { at, axis, depth, width }
}

/// Two half-depth prisms from one plane inside the wall, together spanning
/// its thickness and full length and height.
fn two_from_a_shared_plane() -> Vec<Prism> {
    vec![
        prism([0.0, 12.0, H / 2.0], "0.,-1.,0.", 182.0, L),
        prism([0.0, 12.0, H / 2.0], "0.,1.,0.", 109.0, L),
    ]
}

/// Two through prisms that overlap along the wall and differ in depth, so
/// they cannot merge; their union covers the wall.
fn two_overlapping() -> Vec<Prism> {
    vec![
        prism([-355.0, -50.0, H / 2.0], "0.,-1.,0.", 200.0, 800.0),
        prism([350.0, -60.0, H / 2.0], "0.,-1.,0.", 220.0, 810.0),
    ]
}

fn wall_ifc(placement: Placement, opening_x: f64, prisms: &[Prism]) -> String {
    let (location, x_dir) = placement.location_and_x();
    let mut data = format!(
        "#1=IFCPERSON($,'u',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'o',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','synth','synth');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#7=IFCUNITASSIGNMENT((#6));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#13,$);
#15=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#14,$,.MODEL_VIEW.,$);
#20=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#5,'p',$,$,$,$,(#14),#7);
#21=IFCLOCALPLACEMENT($,#13);
#22=IFCSITE('1YvctVUKr0kugbFTf53O9L',#5,'s',$,$,#21,$,$,.ELEMENT.,$,$,$,$,$);
#23=IFCLOCALPLACEMENT(#21,#13);
#24=IFCBUILDING('2YvctVUKr0kugbFTf53O9L',#5,'b',$,$,#23,$,$,.ELEMENT.,$,$,$);
#25=IFCLOCALPLACEMENT(#23,#13);
#26=IFCBUILDINGSTOREY('3YvctVUKr0kugbFTf53O9L',#5,'l',$,$,#25,$,$,.ELEMENT.,0.);
#27=IFCRELAGGREGATES('4YvctVUKr0kugbFTf53O9L',#5,$,$,#20,(#22));
#28=IFCRELAGGREGATES('5YvctVUKr0kugbFTf53O9L',#5,$,$,#22,(#24));
#29=IFCRELAGGREGATES('6YvctVUKr0kugbFTf53O9L',#5,$,$,#24,(#26));
#100=IFCCARTESIANPOINT((0.,0.));
#101=IFCCARTESIANPOINT(({L},0.));
#102=IFCCARTESIANPOINT(({L},{T}));
#103=IFCCARTESIANPOINT((0.,{T}));
#104=IFCPOLYLINE((#100,#101,#102,#103,#100));
#105=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#104);
#106=IFCEXTRUDEDAREASOLID(#105,#13,#11,{H});
#107=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',(#106));
#108=IFCPRODUCTDEFINITIONSHAPE($,$,(#107));
#109=IFCLOCALPLACEMENT(#25,#112);
#113=IFCCARTESIANPOINT(({location}));
#114=IFCDIRECTION(({x_dir}));
#112=IFCAXIS2PLACEMENT3D(#113,#11,#114);
#{WALL}=IFCWALLSTANDARDCASE('7YvctVUKr0kugbFTf53O9L',#5,'wall',$,$,#109,#108,$);
#111=IFCRELCONTAINEDINSPATIALSTRUCTURE('8YvctVUKr0kugbFTf53O9L',#5,$,$,(#{WALL}),#26);
#200=IFCCARTESIANPOINT(({opening_x},0.,0.));
#201=IFCAXIS2PLACEMENT3D(#200,#11,#12);
#202=IFCLOCALPLACEMENT(#109,#201);
"
    );
    let mut items = Vec::new();
    for (k, p) in prisms.iter().enumerate() {
        let n = 300 + 20 * k;
        let [x, y, z] = p.at;
        let lines = [
            "IFCCARTESIANPOINT((0.,0.))".to_string(),
            "IFCDIRECTION((1.,0.))".to_string(),
            format!("IFCAXIS2PLACEMENT2D(#{n},#{})", n + 1),
            format!("IFCRECTANGLEPROFILEDEF(.AREA.,$,#{},{},{H})", n + 2, p.width),
            format!("IFCCARTESIANPOINT(({x},{y},{z}))"),
            format!("IFCDIRECTION(({}))", p.axis),
            "IFCDIRECTION((-1.,0.,0.))".to_string(),
            format!("IFCAXIS2PLACEMENT3D(#{},#{},#{})", n + 4, n + 5, n + 6),
            "IFCDIRECTION((0.,0.,-1.))".to_string(),
            format!("IFCEXTRUDEDAREASOLID(#{},#{},#{},{})", n + 3, n + 7, n + 8, p.depth),
        ];
        for (offset, line) in lines.iter().enumerate() {
            data += &format!("#{}={line};\n", n + offset);
        }
        items.push(format!("#{}", n + 9));
    }
    data += &format!(
        "#400=IFCSHAPEREPRESENTATION(#15,'Body','SweptSolid',({}));
#401=IFCPRODUCTDEFINITIONSHAPE($,$,(#400));
#402=IFCOPENINGELEMENT('9YvctVUKr0kugbFTf53O9L',#5,'opening',$,$,#202,#401,$);
#403=IFCRELVOIDSELEMENT('AYvctVUKr0kugbFTf53O9L',#5,$,$,#{WALL},#402);
",
        items.join(",")
    );
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('synthetic.ifc','2026-10-25T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
{data}ENDSEC;
END-ISO-10303-21;
"
    )
}

/// The wall's rendered volume in m³, `None` when it renders nothing.
fn wall_volume(ifc: &str) -> Option<f64> {
    let result = process_geometry(ifc);
    let meshes: Vec<_> = result.meshes.iter().filter(|m| m.express_id == WALL).collect();
    if meshes.is_empty() {
        return None;
    }
    Some(meshes.iter().map(|m| signed_volume(&m.positions, &m.indices)).sum::<f64>().abs())
}

const WALL_M3: f64 = L * T * H * 1e-9;

#[test]
fn openings_that_consume_the_wall_leave_no_geometry() {
    let cases = [
        (
            "two from a shared plane, perturbed negative quarter-turn",
            Placement::PerturbedNegativeQuarterTurn,
            two_from_a_shared_plane(),
        ),
        ("two from a shared plane, identity", Placement::Identity, two_from_a_shared_plane()),
        (
            "two from a shared plane, far with perturbed negative quarter-turn",
            Placement::FarAndPerturbedNegativeQuarterTurn,
            two_from_a_shared_plane(),
        ),
        ("two from a shared plane, rotated 30", Placement::Rotated30, two_from_a_shared_plane()),
        ("two overlapping, identity", Placement::Identity, two_overlapping()),
        (
            "two overlapping, perturbed negative quarter-turn",
            Placement::PerturbedNegativeQuarterTurn,
            two_overlapping(),
        ),
        ("two overlapping, rotated 30", Placement::Rotated30, two_overlapping()),
        ("one engulfing", Placement::Identity, vec![prism([0.0, -50.0, H / 2.0], "0.,-1.,0.", 200.0, L)]),
    ];
    for (name, placement, prisms) in cases {
        let volume = wall_volume(&wall_ifc(placement, L / 2.0, &prisms));
        assert_eq!(volume, None, "{name}: the wall is consumed, got {volume:?} m³");
    }
}

#[test]
fn a_partial_cut_stays_partial() {
    let half = [prism([0.0, -50.0, H / 2.0], "0.,-1.,0.", 200.0, L / 2.0)];
    for placement in [
        Placement::Identity,
        Placement::PerturbedNegativeQuarterTurn,
        Placement::Rotated30,
    ] {
        let volume = wall_volume(&wall_ifc(placement, 0.75 * L, &half)).expect("half the wall stays");
        assert!((volume - WALL_M3 / 2.0).abs() < 1e-4, "half the wall, got {volume} m³");
    }
}

#[test]
fn a_wall_its_opening_misses_is_unchanged() {
    let beside = [prism([0.0, -50.0, H / 2.0], "0.,-1.,0.", 200.0, 400.0)];
    for placement in [
        Placement::Identity,
        Placement::PerturbedNegativeQuarterTurn,
        Placement::Rotated30,
    ] {
        let volume = wall_volume(&wall_ifc(placement, L + 1000.0, &beside)).expect("the wall stays");
        assert!((volume - WALL_M3).abs() < 1e-6, "the whole wall, got {volume} m³");
    }
}
