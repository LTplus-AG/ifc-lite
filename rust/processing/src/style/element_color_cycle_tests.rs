// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `find_color_for_geometry` chases `IfcMappedItem -> IfcRepresentationMap
//! -> MappedRepresentation.Items`. The chain is built entirely from file
//! references, so a malformed file controls both its depth and its
//! branching factor (#2866).
use super::{find_color_for_geometry, MAX_MAPPED_ITEM_DEPTH};
use ifc_lite_core::{build_entity_index, EntityDecoder};
use rustc_hash::FxHashMap;

fn decoder_for(content: &str) -> EntityDecoder<'static> {
    let content: &'static str = Box::leak(content.to_string().into_boxed_str());
    let idx = build_entity_index(content);
    EntityDecoder::with_index(content, idx)
}

/// `#100`'s mapped representation lists `#100` itself.
const CYCLIC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test','2026-05-27',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);
#100=IFCMAPPEDITEM(#101,$);
#101=IFCREPRESENTATIONMAP($,#103);
#103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#100));
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn terminates_on_cyclic_mapping() {
    let mut decoder = decoder_for(CYCLIC);
    let styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    assert_eq!(find_color_for_geometry(100, &styles, &mut decoder), None);
}

/// Four items looping back through one representation map. A depth cap
/// alone bounds the chain's LENGTH but not its BREADTH, so this costs
/// `O(4^depth)` decodes without the visited set -- no stack overflow, just
/// a worker pinned on the file. The assertion is on the returned colour,
/// as everywhere here; its failure mode without the set is a HANG rather
/// than a wrong value, which surfaces as a lane timeout. That is stated
/// plainly because there is no way to assert "returned in finite time"
/// that is not a timing test.
const CYCLIC_FAN_OUT: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test','2026-05-27',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);
#100=IFCMAPPEDITEM(#101,$);
#101=IFCREPRESENTATIONMAP($,#103);
#103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#110,#111,#112,#113));
#110=IFCMAPPEDITEM(#101,$);
#111=IFCMAPPEDITEM(#101,$);
#112=IFCMAPPEDITEM(#101,$);
#113=IFCMAPPEDITEM(#101,$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn bounds_cyclic_fan_out_not_just_depth() {
    let mut decoder = decoder_for(CYCLIC_FAN_OUT);
    let styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    assert_eq!(find_color_for_geometry(100, &styles, &mut decoder), None);
}

/// Build an acyclic chain of `hops` nested mapped items whose innermost
/// representation holds the styled leaf `#999`. Entry point is `#200`.
fn nested_chain(hops: u32) -> String {
    let mut s = String::from(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Test'),'2;1');\n\
         FILE_NAME('test','2026-05-27',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);\n",
    );
    for i in 0..hops {
        let item = 200 + i;
        let map = 1000 + i;
        let shape = 2000 + i;
        let inner = if i + 1 == hops { 999 } else { 200 + i + 1 };
        s.push_str(&format!("#{item}=IFCMAPPEDITEM(#{map},$);\n"));
        s.push_str(&format!("#{map}=IFCREPRESENTATIONMAP($,#{shape});\n"));
        s.push_str(&format!(
            "#{shape}=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#{inner}));\n"
        ));
    }
    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

/// A literal depth, not one derived from `MAX_MAPPED_ITEM_DEPTH`: fixtures
/// built from the constant follow it wherever it moves and stay green even
/// if it is tuned to 1, so they pin the boundary's shape and never its
/// position. 20 hops is past the sibling resolver's former cap of 16 and
/// within the router's 32 -- the case a mismatched cap breaks, and it
/// breaks it by returning a WRONG COLOUR rather than by crashing: the
/// geometry still renders and just loses its authored style, with nothing
/// reporting it.
#[test]
fn resolves_a_legitimate_twenty_hop_chain() {
    let ifc = nested_chain(20);
    let mut decoder = decoder_for(&ifc);
    let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    styles.insert(999, [0.0, 0.8, 0.2, 1.0]);
    assert_eq!(
        find_color_for_geometry(200, &styles, &mut decoder),
        Some([0.0, 0.8, 0.2, 1.0]),
        "a 20-hop chain is within every sibling's cap and must keep its style"
    );
}

#[test]
fn stops_one_hop_past_the_depth_cap() {
    let ifc = nested_chain(MAX_MAPPED_ITEM_DEPTH + 1);
    let mut decoder = decoder_for(&ifc);
    let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    styles.insert(999, [0.0, 0.8, 0.2, 1.0]);
    assert_eq!(find_color_for_geometry(200, &styles, &mut decoder), None);
}

/// The cap is not a free parameter: every walk over this chain must agree, or
/// the shortest one silently strips colour off chains the others still render.
///
/// There are no longer three copies to compare — all three sites import one
/// constant — so this asserts the import rather than a literal. It used to read
/// `assert_eq!(MAX_MAPPED_ITEM_DEPTH, 32)` with a message naming the other two
/// crates, which is the shape it was written to prevent: the message claimed
/// agreement while the assertion checked a constant against itself.
#[test]
fn depth_cap_is_the_shared_constant() {
    assert_eq!(
        MAX_MAPPED_ITEM_DEPTH,
        ifc_lite_core::MAX_MAPPED_ITEM_DEPTH,
        "use the shared cap from ifc_lite_core::limits, not a private copy"
    );
}

/// An item shared between a DEEP branch (where the cap cuts its subtree before
/// the styled leaf) and a SHORT one (where it resolves). A plain visited SET
/// marks it on the deep visit and skips the short one, silently losing the
/// colour: measured `Some(green)` -> `None` before the map recorded depths
/// (Codex, #2868 review).
///
/// This is the failure mode that produces a WRONG VALUE rather than a crash,
/// so nothing reports it — which is why it is asserted on the colour and not
/// on termination.
#[test]
fn a_shared_item_resolves_via_the_shallow_branch() {
    let mut s = String::from(
        "#200=IFCMAPPEDITEM(#201,$);\n\
         #201=IFCREPRESENTATIONMAP($,#202);\n\
         #202=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#300,#900));\n",
    );
    for i in 0..30u32 {
        let (item, rm, sh) = (300 + i, 400 + i, 500 + i);
        let inner = if i == 29 { 900 } else { 300 + i + 1 };
        s.push_str(&format!("#{item}=IFCMAPPEDITEM(#{rm},$);\n"));
        s.push_str(&format!("#{rm}=IFCREPRESENTATIONMAP($,#{sh});\n"));
        s.push_str(&format!(
            "#{sh}=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#{inner}));\n"
        ));
    }
    // X (#900) needs TWO more hops to reach the styled leaf, so arriving at
    // depth 31 leaves #950 cut by the cap at 32 while #900 is already marked
    // visited.
    s.push_str(
        "#900=IFCMAPPEDITEM(#901,$);\n\
         #901=IFCREPRESENTATIONMAP($,#902);\n\
         #902=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#950));\n\
         #950=IFCMAPPEDITEM(#951,$);\n\
         #951=IFCREPRESENTATIONMAP($,#952);\n\
         #952=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#999));\n",
    );
    let ifc = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Test'),'2;1');\n\
         FILE_NAME('test','2026-05-27',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);\n{s}ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let mut decoder = decoder_for(&ifc);
    let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    styles.insert(999, [0.0, 0.8, 0.2, 1.0]);
    assert_eq!(
        find_color_for_geometry(200, &styles, &mut decoder),
        Some([0.0, 0.8, 0.2, 1.0]),
        "the shallow branch reaches the styled leaf well inside the cap; \
         marking the item on the deep branch must not hide it"
    );
}
