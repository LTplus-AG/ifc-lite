// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::EntityDecoder;

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
    sample_curve_polyline(&curve, &mut decoder, TessellationQuality::default())
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
