// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::EntityDecoder;

fn wrap(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Run `item_has_identity_position` on a worker thread with a timeout.
///
/// The walk is iterative, so a regression that drops the visited set does not
/// crash -- it spins forever. Called directly that HANGS THE WHOLE SUITE,
/// which reads as "still running", not as a failure. On a worker it reads as
/// a failed assert with a name attached.
fn identity_of(data: &str, id: u32) -> bool {
    let content = wrap(data);
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let mut decoder = EntityDecoder::new(&content);
        let item = decoder.decode_by_id(id).expect("decode item");
        let _ = tx.send(item_has_identity_position(item, &mut decoder));
    });
    // Match the variant rather than `is_ok()`: `recv_timeout` returns Err for
    // Disconnected as well as Timeout, so a PANIC in the worker drops `tx` and
    // reports as "did not terminate" — a confident wrong diagnosis pointing at
    // a guard that is fine (#2945).
    let value = match rx.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(v) => v,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("item_has_identity_position did not terminate within 30s")
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            panic!("item_has_identity_position's worker PANICKED (not a hang); \
                    its panic is printed above")
        }
    };
    let _ = handle.join();
    value
}

/// One self-referential entity: `#10`'s FirstOperand is `#10` (#2866).
#[test]
fn self_referential_first_operand_terminates() {
    assert!(!identity_of(
        "#10=IFCBOOLEANRESULT(.DIFFERENCE.,#10,#20);\n#20=IFCBLOCK($,1.,1.,1.);\n",
        10
    ));
}

/// A two-node cycle. The one-entity case above is catchable by a naive
/// `inner.id == item.id` check; this is not, so it pins a real visited set.
#[test]
fn two_node_first_operand_cycle_terminates() {
    assert!(!identity_of(
        "#10=IFCBOOLEANRESULT(.DIFFERENCE.,#11,#20);\n\
         #11=IFCBOOLEANRESULT(.DIFFERENCE.,#10,#20);\n\
         #20=IFCBLOCK($,1.,1.,1.);\n",
        10
    ));
}

/// The positive control, and the reason the guard returns `false` rather than
/// short-circuiting the whole function: a boolean wrapping an extrusion with
/// an IDENTITY placement must still report `true`, or every layered wall built
/// this way silently loses its layer slicing. Terminating is not the property;
/// terminating without breaking the common case is.
#[test]
fn boolean_over_identity_extrusion_still_reports_identity() {
    assert!(identity_of(
        "#10=IFCBOOLEANRESULT(.DIFFERENCE.,#11,#20);\n\
         #11=IFCEXTRUDEDAREASOLID(#12,#13,#16,3000.);\n\
         #12=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,200.,4000.);\n\
         #13=IFCAXIS2PLACEMENT3D(#14,$,$);\n\
         #14=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #16=IFCDIRECTION((0.,0.,1.));\n\
         #20=IFCBLOCK($,1.,1.,1.);\n",
        10
    ));
}

/// And the negative control on the same axis: a NON-identity placement must
/// still report `false`, so the test above cannot be satisfied by a function
/// that returns `true` unconditionally.
#[test]
fn boolean_over_translated_extrusion_reports_non_identity() {
    assert!(!identity_of(
        "#10=IFCBOOLEANRESULT(.DIFFERENCE.,#11,#20);\n\
         #11=IFCEXTRUDEDAREASOLID(#12,#13,#16,3000.);\n\
         #12=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,200.,4000.);\n\
         #13=IFCAXIS2PLACEMENT3D(#14,$,$);\n\
         #14=IFCCARTESIANPOINT((500.,0.,0.));\n\
         #16=IFCDIRECTION((0.,0.,1.));\n\
         #20=IFCBLOCK($,1.,1.,1.);\n",
        10
    ));
}

/// A long ACYCLIC FirstOperand chain, every id distinct, so every
/// `visited.insert` succeeds and the set never fires. Recursively this
/// aborted the process the same way the cyclic case did, on a file with no
/// cycle in it (Codex, #2872 review).
///
/// The chain bottoms out in an IDENTITY extrusion and the assertion is
/// `true`, which is what pins the ABSENCE of a length cap as well as
/// termination: a cap returns `false` here, as does giving up part-way, so
/// only a walk that reaches the bottom of all 20_000 links passes. Asserting
/// `false` would not distinguish them -- bailing early and walking correctly
/// both return `false` when a chain ends in a non-identity item.
#[test]
fn a_long_acyclic_operand_chain_walks_all_the_way_down() {
    let n: u32 = 20_000;
    let mut data = String::new();
    for i in 1..n {
        data.push_str(&format!(
            "#{}=IFCBOOLEANRESULT(.DIFFERENCE.,#{},#90000);\n",
            i,
            i + 1
        ));
    }
    data.push_str(&format!(
        "#{n}=IFCEXTRUDEDAREASOLID(#90001,#90002,#90004,3000.);\n"
    ));
    data.push_str("#90000=IFCBLOCK($,1.,1.,1.);\n");
    data.push_str("#90001=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,200.,4000.);\n");
    data.push_str("#90002=IFCAXIS2PLACEMENT3D(#90003,$,$);\n");
    data.push_str("#90003=IFCCARTESIANPOINT((0.,0.,0.));\n");
    data.push_str("#90004=IFCDIRECTION((0.,0.,1.));\n");
    assert!(
        identity_of(&data, 1),
        "a {n}-deep acyclic chain over an identity extrusion must report identity"
    );
}
