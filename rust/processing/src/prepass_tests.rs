// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `prepass.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;
use ifc_lite_core::{EntityIndex, EntityScanner};

#[test]
fn find_ifcproject_id_late_in_file() {
    let ifc = b"ISO-10303-21;\nDATA;\n#1=IFCWALL('x',$,$,$,$,$,$,$,$);\n#999123=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\nENDSEC;\n";
    assert_eq!(find_ifcproject_id(ifc), Some(999123));
}

#[test]
fn find_ifcproject_id_absent() {
    let ifc = b"ISO-10303-21;\nDATA;\n#1=IFCWALL('x',$,$,$,$,$,$,$,$);\nENDSEC;\n";
    assert_eq!(find_ifcproject_id(ifc), None);
}

#[test]
fn find_ifcproject_id_skips_string_decoys() {
    let ifc = b"DATA;\n#5=IFCWALL('decoy =IFCPROJECT( in a name',$);\n#7=IFCPROJECT('g',$);\n";
    assert_eq!(find_ifcproject_id(ifc), Some(7));
}

#[test]
fn find_ifcproject_id_handles_whitespace_around_equals() {
    // Revit/EDM exporters write `#id= IFCPROJECT(` with a space after `=`;
    // the old `=IFCPROJECT(` literal never matched → the whole unit chain
    // defaulted to metres + radians (issue #1367, arched openings → circles).
    let space_after = b"DATA;\n#1=IFCWALL('x',$);\n#1593796= IFCPROJECT('g',$,'P',$,$,$,$,$,$);\n";
    assert_eq!(find_ifcproject_id(space_after), Some(1593796));

    let space_both = b"DATA;\n#42 = IFCPROJECT('g',$);\n";
    assert_eq!(find_ifcproject_id(space_both), Some(42));

    // IFCPROJECTEDCRS must not be mistaken for IFCPROJECT.
    let crs_only = b"DATA;\n#9= IFCPROJECTEDCRS('EPSG:32632',$,'WGS84',$,'UTM','32N',$);\n";
    assert_eq!(find_ifcproject_id(crs_only), None);
}

/// Control: an ordinary express id is found unchanged (issue #3421).
#[test]
fn find_ifcproject_id_ordinary_id_is_unaffected() {
    let ifc = b"DATA;\n#42=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\n";
    assert_eq!(find_ifcproject_id(ifc), Some(42));
}

/// Boundary: an id at exactly `u32::MAX` is not refused (issue #3421).
#[test]
fn find_ifcproject_id_accepts_a_ref_at_exactly_u32_max() {
    let ifc = b"DATA;\n#4294967295=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\n";
    assert_eq!(find_ifcproject_id(ifc), Some(u32::MAX));
}

/// RED for issue #3421: `find_ifcproject_id` used to accumulate the express
/// id with `wrapping_mul`/`wrapping_add`, so `#4294967297=IFCPROJECT(...)`
/// wrapped onto id 1 instead of refusing. A real `#1=IFCWALL(...)` earlier in
/// the same file proves the wrap would have misidentified the wall as the
/// project were parse_express_id not used; this asserts the oversized
/// IFCPROJECT is skipped (refused) and the search keeps going, finding
/// nothing (there is no other IFCPROJECT).
#[test]
fn find_ifcproject_id_refuses_a_ref_above_u32_max_instead_of_wrapping_onto_a_real_entity() {
    let ifc = b"DATA;\n#1=IFCWALL('x',$,$,$,$,$,$,$,$);\n#4294967297=IFCPROJECT('g',$,'P',$,$,$,$,$,$);\nENDSEC;\n";
    assert_eq!(
        find_ifcproject_id(ifc),
        None,
        "an oversized IFCPROJECT id must be refused, never aliased onto id 1 (the IFCWALL)"
    );
}

/// Mimics the Revit/EDM ordering of Architecture.ifc (issue #1367): the
/// DEGREE plane-angle unit sits near the file head but its conversion
/// `IFCMEASUREWITHUNIT` is at the very tail. With a PARTIAL index that has the
/// project + assignment + degree unit but NOT the measure, the plane-angle
/// resolver must report "incomplete" so `resolve_unit_scales` retries against
/// a full index instead of silently shipping radians.
#[test]
fn resolve_unit_scales_recovers_degrees_when_measure_past_partial_index() {
    const IFC: &[u8] = br#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('u.ifc','2026-06-26T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#10= IFCPROJECT('g',$,'P',$,$,$,$,$,#11);
#11= IFCUNITASSIGNMENT((#12,#13));
#12= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#13= IFCCONVERSIONBASEDUNIT(#14,.PLANEANGLEUNIT.,'DEGREE',#15);
#14= IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#16= IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#15= IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.0174532925199433),#16);
ENDSEC;
END-ISO-10303-21;
"#;
    // Build a PARTIAL index that omits the tail measure (#15) and exponents
    // (#14), exactly the streaming-gate situation that masked the bug.
    let mut partial = EntityIndex::default();
    let mut scanner = EntityScanner::new(&IFC);
    while let Some((id, _t, start, end)) = scanner.next_entity() {
        if id == 15 || id == 14 {
            continue; // forward-referenced past the gate
        }
        partial.insert(id, (start, end));
    }
    let mut decoder = EntityDecoder::with_index(IFC, partial);
    let scales = resolve_unit_scales(IFC, Some(10), &mut decoder);
    assert_eq!(scales.project_id, Some(10));
    assert!((scales.length_unit_scale - 0.001).abs() < 1e-12);
    assert!(
        (scales.plane_angle_to_radians - 0.0174532925199433).abs() < 1e-12,
        "expected degrees via full-index retry, got {}",
        scales.plane_angle_to_radians
    );
}

#[test]
fn material_colors_flat_round_trip() {
    let mut map: FxHashMap<u32, Vec<[f32; 4]>> = FxHashMap::default();
    map.insert(10, vec![[0.5, 0.5, 0.5, 1.0], [0.7, 0.9, 0.5, 0.2]]);
    map.insert(42, vec![[1.0, 0.0, 0.0, 1.0]]);

    let (ids, counts, rgba) = flat_material_colors(&map);
    let back = material_colors_from_flat(&ids, &counts, &rgba);

    assert_eq!(back.len(), 2);
    assert_eq!(back[&42].len(), 1);
    assert_eq!(back[&10].len(), 2);
    // RGBA8 quantization: equal within 1/255.
    for (orig, round) in map[&10].iter().zip(back[&10].iter()) {
        for (a, b) in orig.iter().zip(round.iter()) {
            assert!((a - b).abs() <= 1.0 / 255.0 + 1e-6);
        }
    }
}

/// The flat wire arrays are an EXPLICIT id-ascending contract (pinned by
/// the mesh-output determinism manifest), not an FxHashMap iteration-order
/// artifact.
#[test]
fn flat_wire_arrays_are_sorted_by_id() {
    let mut voids: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    voids.insert(300, vec![301, 302]);
    voids.insert(7, vec![8]);
    voids.insert(90, vec![91]);
    let (keys, counts, values) = flat_voids(&voids);
    assert_eq!(keys, vec![7, 90, 300]);
    assert_eq!(counts, vec![1, 1, 2]);
    // Per-host opening lists keep their (file-order) sequence.
    assert_eq!(values, vec![8, 91, 301, 302]);

    let mut colors: FxHashMap<u32, Vec<[f32; 4]>> = FxHashMap::default();
    colors.insert(42, vec![[1.0, 0.0, 0.0, 1.0]]);
    colors.insert(10, vec![[0.0, 1.0, 0.0, 1.0], [0.0, 0.0, 1.0, 0.5]]);
    let (ids, counts, rgba) = flat_material_colors(&colors);
    assert_eq!(ids, vec![10, 42]);
    assert_eq!(counts, vec![2, 1]);
    assert_eq!(rgba.len(), 12);
    // First colour on the wire is element #10's first (green), not #42's.
    assert_eq!(&rgba[0..4], &[0, 255, 0, 255]);
}

#[test]
fn resolve_unit_scales_resolves_degrees_and_millimetres() {
    const IFC: &[u8] = br#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('u.ifc','2026-06-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('w',$,$,$,$,$,$,$,$);
#10=IFCPROJECT('g',$,'P',$,$,$,$,$,#11);
#11=IFCUNITASSIGNMENT((#12,#13));
#12=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#13=IFCCONVERSIONBASEDUNIT(#14,.PLANEANGLEUNIT.,'DEGREE',#15);
#14=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#15=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.017453292519943295),#16);
#16=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
ENDSEC;
END-ISO-10303-21;
"#;
    // No hint: found by substring search; resolved on a fresh decoder.
    let mut decoder = EntityDecoder::new(IFC);
    let scales = resolve_unit_scales(IFC, None, &mut decoder);
    assert_eq!(scales.project_id, Some(10));
    assert!((scales.length_unit_scale - 0.001).abs() < 1e-12);
    assert!((scales.plane_angle_to_radians - 0.017_453_292_519_943_295).abs() < 1e-12);
}
