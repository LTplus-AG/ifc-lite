// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::{EntityDecoder, IfcSchema};

/// A composite curve whose every segment's `ParentCurve` is that same curve,
/// so each level multiplies the work by the segment count.
fn fan_out_ifc(k: u32) -> String {
    let segs: Vec<String> = (0..k).map(|i| format!("#{}", 100 + i)).collect();
    let mut d = format!("#10=IFCCOMPOSITECURVE(({}),.F.);\n", segs.join(","));
    for i in 0..k {
        d.push_str(&format!(
            "#{}=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#10);\n",
            100 + i
        ));
    }
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{d}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// A self-referential composite curve terminates on the depth cap, and the
/// error propagates with `?` so its siblings never run.
///
/// This is worth pinning, but NOT as evidence that the cap is sufficient — it
/// only collapses the search on input where a branch actually errors. See
/// `a_wide_acyclic_dag_is_bounded_by_the_node_budget` for the input where
/// nothing errors and the cap does nothing at all.
///
/// The assertion is on the ERROR, not on elapsed time: a timing assertion
/// placed after the call cannot fire when the call never returns.
#[test]
fn a_self_referential_curve_stops_on_the_depth_cap() {
    for k in 1..=3u32 {
        let ifc = fan_out_ifc(k);
        let mut decoder = EntityDecoder::new(&ifc);
        let curve = decoder.decode_by_id(10).expect("decode #10");
        let processor = ProfileProcessor::new(IfcSchema::new());
        let err = processor
            .get_curve_points(&curve, &mut decoder, TessellationQuality::Medium)
            .expect_err("a self-referential composite curve must report the depth limit");
        assert!(
            err.to_string().contains("Curve nesting depth"),
            "k={k}: the cap must be the thing that stops it, got: {err}"
        );
    }
}

/// An ACYCLIC composite-curve DAG where every branch RESOLVES: two segments
/// per level, both pointing at the next level, terminating in a real polyline.
/// Nothing is cyclic and nothing fails, so neither a cycle guard nor the `?`
/// propagation above can see it — and the work doubles per level.
fn dag_ifc(levels: u32) -> String {
    let mut d = String::new();
    for i in 0..levels {
        let cc = 10 + i;
        let next = if i + 1 == levels { 9000 } else { 10 + i + 1 };
        let (s1, s2) = (1000 + i * 2, 1001 + i * 2);
        d.push_str(&format!("#{cc}=IFCCOMPOSITECURVE((#{s1},#{s2}),.F.);\n"));
        d.push_str(&format!("#{s1}=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#{next});\n"));
        d.push_str(&format!("#{s2}=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#{next});\n"));
    }
    d.push_str("#9000=IFCPOLYLINE((#9001,#9002));\n");
    d.push_str("#9001=IFCCARTESIANPOINT((0.,0.,0.));\n");
    d.push_str("#9002=IFCCARTESIANPOINT((1.,0.,0.));\n");
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{d}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn sample_dag(levels: u32) -> Result<Vec<Point3<f64>>> {
    let ifc = dag_ifc(levels);
    let mut decoder = EntityDecoder::new(&ifc);
    let curve = decoder.decode_by_id(10).expect("decode #10");
    ProfileProcessor::new(IfcSchema::new()).get_curve_points(
        &curve,
        &mut decoder,
        TessellationQuality::Medium,
    )
}

/// The positive control, and the reason the budget is 100k rather than small:
/// a modest DAG must still resolve completely. 8 levels is 2^8 + 1 points.
#[test]
fn a_modest_acyclic_dag_still_resolves_completely() {
    assert_eq!(sample_dag(8).expect("8 levels must resolve").len(), 257);
}

/// The bound. Under a depth cap alone this is `2^30` curve visits and a
/// `Vec<Point3>` to match — measured before the budget at 2^levels points
/// exactly (levels=20: 1,048,577 points, 473ms; every +4 levels 16x). The cap
/// of 50 does not see it: depth 30 is inside the cap, nothing is cyclic, and
/// nothing errors, so no `?` fires.
///
/// Asserted on the ERROR rather than on elapsed time. A timing assertion after
/// the call cannot fire when the call does not return, and exhausting memory
/// is the regression.
#[test]
fn a_wide_acyclic_dag_is_bounded_by_the_node_budget() {
    let err = sample_dag(30).expect_err("a 2^30 traversal must be refused, not attempted");
    assert!(
        err.to_string().contains("exceeded"),
        "the node budget must be what stops it, got: {err}"
    );
}
