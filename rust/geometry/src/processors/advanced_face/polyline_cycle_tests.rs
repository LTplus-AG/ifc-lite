// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::EntityDecoder;
use std::time::{Duration, Instant};

/// A single self-referential entity: `#10`'s `BasisCurve` is `#10`. Enough on
/// its own to abort the process before the guard (#2866).
const SELF_BASIS: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCTRIMMEDCURVE(#10,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.PARAMETER.);
ENDSEC;
END-ISO-10303-21;
"#;

/// A two-node cycle: `#10` trims `#11`, which trims `#10` back. The one-entity
/// case above is catchable by a naive `basis.id == curve.id` check; this one
/// is not, so it pins that the guard is a real visited set.
const TWO_CYCLE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCTRIMMEDCURVE(#11,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.PARAMETER.);
#11=IFCTRIMMEDCURVE(#10,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.PARAMETER.);
ENDSEC;
END-ISO-10303-21;
"#;

/// A legitimate trimmed-on-trimmed chain ending at a real `IfcLine`, so the
/// guard is shown to stop at cycles rather than at nesting. The assertion is on
/// the sampled polyline, not on "it returned": a guard that made every trimmed
/// curve yield nothing would also terminate, and would silently strip geometry
/// off every IfcAdvancedBrep in the file.
const NESTED_TRIM_ON_LINE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCTRIMMEDCURVE(#11,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.PARAMETER.);
#11=IFCTRIMMEDCURVE(#12,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.PARAMETER.);
#12=IFCLINE(#13,#14);
#13=IFCCARTESIANPOINT((0.,0.,0.));
#14=IFCVECTOR(#15,1.);
#15=IFCDIRECTION((1.,0.,0.));
ENDSEC;
END-ISO-10303-21;
"#;

fn wrap(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn sample(content: &str, id: u32) -> Vec<Point3<f64>> {
    let mut decoder = EntityDecoder::new(content);
    let curve = decoder.decode_by_id(id).expect("decode curve");
    try_sample_curve_polyline(&curve, &mut decoder, TessellationQuality::default()).expect("not refused")
}

#[test]
fn self_referential_basis_curve_terminates() {
    assert!(sample(SELF_BASIS, 10).is_empty());
}

#[test]
fn two_node_basis_curve_cycle_terminates() {
    assert!(sample(TWO_CYCLE, 10).is_empty());
}

#[test]
fn a_legitimate_nested_trim_still_samples() {
    let pts = sample(NESTED_TRIM_ON_LINE, 10);
    assert!(
        pts.len() >= 2,
        "nested-but-acyclic trimming must still yield a polyline, got {} points",
        pts.len()
    );
}

/// A long ACYCLIC chain: `#1` trims `#2` trims `#3`, every id distinct, so
/// every `visited.insert` succeeds and the set never fires. Before the depth
/// cap this consumed one stack frame per entity and aborted the process — the
/// same crash as the cyclic case, on a file containing no cycle at all
/// (Codex, #2871 review). A chain is as easy to author as a loop.
#[test]
fn a_long_acyclic_basis_chain_terminates() {
    let n: u32 = 5_000;
    let mut data = String::new();
    for i in 1..n {
        data.push_str(&format!(
            "#{}=IFCTRIMMEDCURVE(#{},(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.PARAMETER.);\n",
            i,
            i + 1
        ));
    }
    data.push_str(&format!("#{n}=IFCCARTESIANPOINT((0.,0.,0.));\n"));
    assert!(sample(&wrap(&data), 1).is_empty());
}

/// #4901, caught in review: `sample_curve_polyline` is the standalone
/// surface-of-revolution generator-profile path (NOT `sample_bspline_edge_curve`,
/// which is edge-loop-only). The degree/curve-point bound must apply there
/// too, or a curve that `sample_bspline_edge_curve` correctly bounds still
/// explodes when reached through this second call site. Since #7687 both go
/// through one parse, which this pins from the standalone side.
#[test]
fn pathological_degree_via_standalone_polyline_fails_fast_not_hangs() {
    let data = "\
#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
#2=IFCCARTESIANPOINT((1.,1.,0.));\n\
#3=IFCCARTESIANPOINT((2.,0.,0.));\n\
#10=IFCBSPLINECURVEWITHKNOTS(999999,(#1,#2,#3),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.));\n";

    let start = Instant::now();
    let pts = sample(&wrap(data), 10);
    let elapsed = start.elapsed();

    // #7687: the standalone sampler has no start vertex to degrade to. It
    // used to return the synthetic `(0,0,0)` start it handed the edge
    // sampler, which a composite edge then spliced into its face loop.
    assert!(
        pts.is_empty(),
        "a degree past MAX_BSPLINE_DEGREE must yield no points, got {pts:?}"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "pathological degree via the standalone polyline path must fail within the deterministic bound, took {elapsed:?}"
    );
}

/// Review of #7803: a trimmed rational B-spline (the quarter circle, weights
/// 1, sqrt(2)/2, 1) trimmed to parameters 0.25..0.75 samples only that
/// subspan. Without the parameter trims the interior samples ran over the
/// whole basis curve, out to the (1,0) and (0,1) ends.
#[test]
fn trimmed_rational_bspline_samples_its_parameter_subspan_7750() {
    let h = std::f64::consts::FRAC_1_SQRT_2;
    let at = |t: f64| {
        let d = (1.0 - t).powi(2) + 2.0 * h * t * (1.0 - t) + t * t;
        let x = ((1.0 - t).powi(2) + 2.0 * h * t * (1.0 - t)) / d;
        let y = (2.0 * h * t * (1.0 - t) + t * t) / d;
        (x, y)
    };
    let ((x1, y1), (x2, y2)) = (at(0.25), at(0.75));
    let content = wrap(&format!(
        "#1=IFCCARTESIANPOINT((1.,0.,0.));\n#2=IFCCARTESIANPOINT((1.,1.,0.));\n\
         #3=IFCCARTESIANPOINT((0.,1.,0.));\n\
         #4=IFCCARTESIANPOINT(({x1:.17E},{y1:.17E},0.));\n#5=IFCCARTESIANPOINT(({x2:.17E},{y2:.17E},0.));\n\
         #10=IFCTRIMMEDCURVE(#11,(#4,IFCPARAMETERVALUE(0.25)),(#5,IFCPARAMETERVALUE(0.75)),.T.,.PARAMETER.);\n\
         #11=IFCRATIONALBSPLINECURVEWITHKNOTS(2,(#1,#2,#3),.CIRCULARARC.,.F.,.F.,(3,3),(0.,1.),\
         .UNSPECIFIED.,(1.,{h:.17E},1.));\n"
    ));
    let pts = sample(&content, 10);
    assert!(pts.len() > 3, "{pts:?}");
    let (lo, hi) = (y1.atan2(x1), y2.atan2(x2));
    for p in &pts {
        assert!((p.coords.norm() - 1.0).abs() < 1e-9, "{p:?} is off the circle");
        let a = p.y.atan2(p.x);
        assert!(a > lo - 1e-9 && a < hi + 1e-9, "{p:?} (angle {a}) is outside the trimmed arc [{lo}, {hi}]");
    }
}
