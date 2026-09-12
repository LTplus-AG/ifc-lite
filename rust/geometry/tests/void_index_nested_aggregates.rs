// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `propagate_voids_to_parts` on NESTED aggregation (rust review follow-up,
//! finding D12). Void propagation already walked the whole aggregate tree,
//! but the part -> parent map only looked one level down, so a layer part
//! under `IfcWall -> IfcElementAssembly -> IfcBuildingElementPart` received
//! the wall's openings and was still drawn on top of the wall's merged solid
//! when the merge-layers toggle was on. The map now reaches the same depth
//! as the propagation, descending only through representation-less
//! intermediates, and a file-supplied cycle in `IfcRelAggregates` ends the
//! walk instead of spinning it.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::propagate_voids_to_parts;
use rustc_hash::FxHashMap;
use std::sync::mpsc;
use std::time::Duration;

const HEADER: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('t.ifc','2026-09-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#50=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#40));
#40=IFCEXTRUDEDAREASOLID($,$,$,3.0);
"#;

const FOOTER: &str = "ENDSEC;\nEND-ISO-10303-21;\n";

fn ifc(body: &str) -> String {
    format!("{HEADER}{body}{FOOTER}")
}

fn run(content: &str, seed: &[(u32, Vec<u32>)]) -> (FxHashMap<u32, u32>, FxHashMap<u32, Vec<u32>>) {
    let mut decoder = EntityDecoder::new(content);
    let mut void_index: FxHashMap<u32, Vec<u32>> = seed.iter().cloned().collect();
    let map = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    (map, void_index)
}

/// Wall (#100, has geometry) aggregates a grouping assembly (#110, no
/// geometry) which aggregates two layer parts (#121, #122, each with
/// geometry). Mutation: restoring the one-level `for &child_id in children`
/// loop leaves the map empty while the voids still reach every part.
#[test]
fn nested_part_maps_to_the_nearest_ancestor_with_geometry() {
    let content = ifc(
        "#100=IFCWALL('0001wall',$,'Wall',$,$,$,#51,$,$);
#110=IFCELEMENTASSEMBLY('0001asm',$,'Layers',$,$,$,$,$,.NOTDEFINED.,.NOTDEFINED.);
#121=IFCBUILDINGELEMENTPART('0001p01',$,'L0',$,$,$,#51,$,$);
#122=IFCBUILDINGELEMENTPART('0001p02',$,'L1',$,$,$,#51,$,$);
#200=IFCOPENINGELEMENT('0001op',$,'Window',$,$,$,#51,$,$);
#210=IFCRELVOIDSELEMENT('0001rv',$,$,$,#100,#200);
#300=IFCRELAGGREGATES('0001ra',$,$,$,#100,(#110));
#301=IFCRELAGGREGATES('0001rb',$,$,$,#110,(#121,#122));
",
    );
    let (map, voids) = run(&content, &[(100, vec![200])]);

    for part in [121, 122] {
        assert_eq!(
            voids.get(&part).map(Vec::as_slice),
            Some(&[200u32][..]),
            "part #{part} must inherit the wall's opening"
        );
        assert_eq!(
            map.get(&part).copied(),
            Some(100),
            "part #{part} must map to the wall it is nested under, got {map:?}"
        );
    }
    assert_eq!(map.len(), 2, "only the two geometry-bearing parts are skippable: {map:?}");
    assert!(
        !map.contains_key(&110),
        "the grouping assembly has no geometry of its own and is not a part"
    );
}

/// Control for the rule "nearest ancestor with geometry": when the
/// intermediate assembly HAS its own representation the descent stops there,
/// so the part maps to the assembly, exactly as the one-level map always did.
#[test]
fn a_child_with_its_own_geometry_ends_the_descent() {
    let content = ifc(
        "#100=IFCWALL('0001wall',$,'Wall',$,$,$,#51,$,$);
#110=IFCELEMENTASSEMBLY('0001asm',$,'Layers',$,$,$,#51,$,.NOTDEFINED.,.NOTDEFINED.);
#121=IFCBUILDINGELEMENTPART('0001p01',$,'L0',$,$,$,#51,$,$);
#300=IFCRELAGGREGATES('0001ra',$,$,$,#100,(#110));
#301=IFCRELAGGREGATES('0001rb',$,$,$,#110,(#121));
",
    );
    let (map, _) = run(&content, &[]);
    assert_eq!(map.get(&121).copied(), Some(110), "nearest geometry-bearing ancestor wins: {map:?}");
    assert_eq!(map.len(), 1);
}

/// A representation-less parent contributes nothing, at any depth: the parts
/// are the only geometry for that assembly and must never be skipped.
#[test]
fn a_geometry_less_root_never_becomes_a_map_value() {
    let content = ifc(
        "#100=IFCWALL('0001wall',$,'Wall',$,$,$,$,$,$);
#110=IFCELEMENTASSEMBLY('0001asm',$,'Layers',$,$,$,$,$,.NOTDEFINED.,.NOTDEFINED.);
#121=IFCBUILDINGELEMENTPART('0001p01',$,'L0',$,$,$,#51,$,$);
#300=IFCRELAGGREGATES('0001ra',$,$,$,#100,(#110));
#301=IFCRELAGGREGATES('0001rb',$,$,$,#110,(#121));
",
    );
    let (map, _) = run(&content, &[]);
    assert!(map.is_empty(), "no ancestor has geometry, nothing is skippable: {map:?}");
}

/// A file-supplied cycle (`#100 -> #110 -> #100`) through a
/// representation-less assembly must end the walk. The timeout is the
/// assertion: a walk without the visited set spins here rather than
/// overflowing, so the work runs on a thread and the test fails in 10 s
/// instead of hanging the suite.
#[test]
fn a_cyclic_aggregate_ends_the_map_walk() {
    let content = ifc(
        "#100=IFCWALL('0001wall',$,'Wall',$,$,$,#51,$,$);
#110=IFCELEMENTASSEMBLY('0001asm',$,'Layers',$,$,$,$,$,.NOTDEFINED.,.NOTDEFINED.);
#121=IFCBUILDINGELEMENTPART('0001p01',$,'L0',$,$,$,#51,$,$);
#300=IFCRELAGGREGATES('0001ra',$,$,$,#100,(#110));
#301=IFCRELAGGREGATES('0001rb',$,$,$,#110,(#100,#121));
",
    );
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(run(&content, &[(100, vec![200])]));
    });
    let (map, voids) = match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            panic!("WORKER HUNG: the part -> parent walk did not terminate on a cyclic IfcRelAggregates")
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => panic!("WORKER PANICKED (not a hang)"),
    };
    assert_eq!(map.get(&121).copied(), Some(100), "{map:?}");
    assert_eq!(voids.get(&121).map(Vec::as_slice), Some(&[200u32][..]));
}
