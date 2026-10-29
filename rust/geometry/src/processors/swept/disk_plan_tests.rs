// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::processors::SweptDiskSolidProcessor;
use crate::TessellationQuality;
use ifc_lite_core::{EntityDecoder, IfcSchema};

fn lower(inner: &str) -> SweptDiskPlan {
    let source = format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCCARTESIANPOINT((4.,0.,0.));\n\
        #3=IFCPOLYLINE((#1,#2));\n\
        #4=IFCSWEPTDISKSOLID(#3,2.,{inner},$,$);"
    );
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(4).unwrap();
    SweptDiskSolidProcessor::new(IfcSchema::new())
        .lower(&entity, &mut decoder, TessellationQuality::Medium)
        .unwrap()
        .unwrap()
}

/// Area of the regular 24-gon inscribed in the UNIT circle (vertices on the
/// circle, as the radius assertions below pin). The ring is a polygon scaled
/// uniformly, so its area scales with radius squared: annulus R=2, r=1 gives
/// (2^2 - 1^2) * A1 and the rod (R=2, no bore) gives 2^2 * A1.
fn unit_24gon_area() -> f64 {
    0.5 * 24.0 * (2.0 * std::f64::consts::PI / 24.0).sin()
}

fn signed_volume(mesh: &Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|tri| {
            let p = |id: u32| {
                nalgebra::Vector3::new(
                    mesh.positions[id as usize * 3] as f64,
                    mesh.positions[id as usize * 3 + 1] as f64,
                    mesh.positions[id as usize * 3 + 2] as f64,
                )
            };
            p(tri[0]).dot(&p(tri[1]).cross(&p(tri[2]))) / 6.0
        })
        .sum()
}

#[test]
fn owned_disk_retains_raw_units_bore_and_normals_after_source_disposal() {
    let plan = lower("1.");
    // Source and decoder were dropped by lower(); volume is independently the
    // regular 24-gon annulus area times the authored four-unit path length.
    let mesh = plan.evaluate();
    let expected = unit_24gon_area() * (2.0_f64.powi(2) - 1.0_f64.powi(2)) * 4.0; // ~37.3
    // The true circular annulus (12*pi ~ 37.70) must NOT satisfy this.
    assert!((expected - 12.0 * std::f64::consts::PI).abs() > 0.3);
    assert!((signed_volume(&mesh) - expected).abs() < 1e-5);
    assert_eq!(mesh.normals.len(), mesh.positions.len());
    assert!(mesh.normals.iter().all(|n| n.is_finite()));
    for vertex in mesh.positions.chunks_exact(3) {
        let radius = (f64::from(vertex[1]).powi(2) + f64::from(vertex[2]).powi(2)).sqrt();
        assert!((radius - 1.0).abs() < 1e-6 || (radius - 2.0).abs() < 1e-6);
        assert!(vertex[0] == 0.0 || vertex[0] == 4.0);
    }
}

#[test]
fn owned_disk_preserves_invalid_inner_radius_rod_policy() {
    for inner in ["$", "0.", "-1.", "2.", "3."] {
        let mesh = lower(inner).evaluate();
        let expected = unit_24gon_area() * 2.0_f64.powi(2) * 4.0; // ~49.7, not 16*pi
        assert!(
            (signed_volume(&mesh) - expected).abs() < 1e-5,
            "inner radius {inner}"
        );
    }
}

#[test]
fn owned_disk_keeps_empty_directrix_and_dangling_reference_distinct() {
    let processor = SweptDiskSolidProcessor::new(IfcSchema::new());
    let mut decoder = EntityDecoder::new(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCPOLYLINE((#1,#1));\n\
        #3=IFCSWEPTDISKSOLID(#2,1.,$,$,$);\n\
        #4=IFCSWEPTDISKSOLID(#99,1.,$,$,$);",
    );
    let empty = decoder.decode_by_id(3).unwrap();
    assert!(processor
        .lower(&empty, &mut decoder, TessellationQuality::Medium)
        .unwrap()
        .is_none());
    let missing = decoder.decode_by_id(4).unwrap();
    assert!(processor
        .lower(&missing, &mut decoder, TessellationQuality::Medium)
        .is_err());
}

/// Ring segment count chosen for a rod of `radius` file units at `quality`, in a file whose
/// project declares millimetres (`mm`) or metres.
fn ring_segments(radius: &str, mm: bool, quality: TessellationQuality) -> usize {
    let unit = if mm { ".MILLI." } else { "$" };
    let source = format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCCARTESIANPOINT((4.,0.,0.));\n\
        #3=IFCPOLYLINE((#1,#2));\n\
        #4=IFCSWEPTDISKSOLID(#3,{radius},$,$,$);\n\
        #10=IFCPROJECT('0001projectaaaaaaaaaaa',$,'P',$,$,$,$,$,#11);\n\
        #11=IFCUNITASSIGNMENT((#12));\n\
        #12=IFCSIUNIT(*,.LENGTHUNIT.,{unit},.METRE.);"
    );
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(4).unwrap();
    SweptDiskSolidProcessor::new(IfcSchema::new())
        .lower(&entity, &mut decoder, quality)
        .unwrap()
        .unwrap()
        .segments
}

#[test]
fn thin_rods_coarsen_below_medium_by_their_size_in_metres() {
    use TessellationQuality::*;
    // A 12 mm bar, authored in millimetres and in metres: the same rod either way.
    for (radius, mm) in [("6.", true), ("0.006", false)] {
        assert_eq!(ring_segments(radius, mm, Lowest), 4, "{radius} mm={mm}");
        assert_eq!(ring_segments(radius, mm, Low), 6, "{radius} mm={mm}");
        assert_eq!(ring_segments(radius, mm, Medium), 24, "{radius} mm={mm}");
        assert_eq!(ring_segments(radius, mm, Highest), 96, "{radius} mm={mm}");
    }
    // A 300 mm pipe, and a value of 6 that is metres, not millimetres: never a thin rod.
    for (radius, mm) in [("150.", true), ("6.", false)] {
        assert_eq!(ring_segments(radius, mm, Lowest), 6, "{radius} mm={mm}");
        assert_eq!(ring_segments(radius, mm, Low), 12, "{radius} mm={mm}");
        assert_eq!(ring_segments(radius, mm, Medium), 24, "{radius} mm={mm}");
    }
}

#[test]
fn thin_rod_at_low_meshes_a_closed_hexagonal_tube() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCCARTESIANPOINT((4.,0.,0.));\n\
        #3=IFCPOLYLINE((#1,#2));\n\
        #4=IFCSWEPTDISKSOLID(#3,0.006,$,$,$);";
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(4).unwrap();
    let mesh = SweptDiskSolidProcessor::new(IfcSchema::new())
        .lower(&entity, &mut decoder, TessellationQuality::Low)
        .unwrap()
        .unwrap()
        .evaluate();
    let hexagon = 0.5 * 6.0 * (2.0 * std::f64::consts::PI / 6.0).sin() * 0.006_f64.powi(2);
    assert!((signed_volume(&mesh) - hexagon * 4.0).abs() < 1e-9);
    for vertex in mesh.positions.chunks_exact(3) {
        let radius = (f64::from(vertex[1]).powi(2) + f64::from(vertex[2]).powi(2)).sqrt();
        assert!(radius < 1e-9 || (radius - 0.006).abs() < 1e-7);
    }
}
