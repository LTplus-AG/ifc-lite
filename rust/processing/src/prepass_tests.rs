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

/// End-to-end: `resolve_unit_scales` with no hint (forcing the
/// `find_ifcproject_id` fallback path) resolves a lowercase-keyword,
/// millimetre + degree file exactly like its uppercase equivalent
/// (`resolve_unit_scales_resolves_degrees_and_millimetres` below).
#[test]
fn resolve_unit_scales_fallback_path_lowercase_keywords() {
    const IFC: &[u8] = b"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=ifcproject('guid',$,'Test',$,$,$,$,(#2),#3);
#2=ifcgeometricrepresentationcontext($,'Model',3,1.E-5,#4,$);
#3=ifcunitassignment((#5,#10));
#4=ifcaxis2placement3d(#7,$,$);
#5=ifcsiunit(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#7=ifccartesianpoint((0.,0.,0.));
#8=ifcsiunit(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#9=ifcmeasurewithunit(ifcratiomeasure(0.0174532925199433),#8);
#10=ifcconversionbasedunit(#11,.PLANEANGLEUNIT.,'DEGREE',#9);
#11=ifcdimensionalexponents(0,0,0,0,0,0,0);
ENDSEC;
END-ISO-10303-21;
";
    let index = ifc_lite_core::build_entity_index(IFC);
    let mut decoder = EntityDecoder::with_index(IFC, index);

    // No hint: forces resolve_unit_scales to call find_ifcproject_id.
    let scales = resolve_unit_scales(IFC, None, &mut decoder);
    assert_eq!(scales.project_id, Some(1));
    assert!(
        (scales.length_unit_scale - 0.001).abs() < 1e-12,
        "expected 0.001 (mm), got {}",
        scales.length_unit_scale
    );
    assert!(
        (scales.plane_angle_to_radians - 0.0174532925199433).abs() < 1e-9,
        "expected 0.01745… (degree), got {}",
        scales.plane_angle_to_radians
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

/// #5582: the authored finish survives the flatten, aligned with its id.
/// Three sources share one wire: a METAL-rendered styled item (#10), a styled
/// item with no specular evidence (#11), and an indexed-colour fallback (#30).
/// #10 also has an indexed colour, which the geometry style must win together
/// with its finish. A finish shifted by one slot lands on a neighbour that
/// must stay NaN.
#[test]
fn flat_styles_with_finishes_carries_the_geometry_style_finish_by_id() {
    let content = b"ISO-10303-21;\nDATA;\n\
        #1=IFCCOLOURRGB($,0.8,0.8,0.85);\n\
        #2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.9),$,.METAL.);\n\
        #3=IFCSURFACESTYLE('Brushed steel',.BOTH.,(#2));\n\
        #4=IFCSTYLEDITEM(#10,(#3),$);\n\
        #5=IFCCOLOURRGB($,0.2,0.4,0.6);\n\
        #6=IFCSURFACESTYLERENDERING(#5,0.,$,$,$,$,$,$,.NOTDEFINED.);\n\
        #7=IFCSURFACESTYLE('Plain',.BOTH.,(#6));\n\
        #8=IFCSTYLEDITEM(#11,(#7),$);\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let mut decoder = EntityDecoder::new(content);
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        spans.stash(type_name, id, start, end);
    }
    let mut resolved = resolve_prepass(&spans, &mut decoder, ResolveOptions::default());
    resolved.indexed_colour_index.insert(10, [0.0, 1.0, 0.0, 1.0]);
    resolved.indexed_colour_index.insert(30, [1.0, 0.0, 0.0, 1.0]);

    let geometry_finishes = resolve_geometry_finishes(&spans.styled_items, &mut decoder);
    let (ids, rgba, finishes) = flat_styles_with_finishes(&resolved, &geometry_finishes, &mut decoder);
    assert_eq!(ids, vec![10, 11, 30]);
    assert_eq!((rgba.len(), finishes.len()), (12, 6), "4 bytes and 2 floats per id");
    assert_eq!(
        (ids.clone(), rgba.clone()),
        flat_styles_rgba8(&resolved, &mut decoder),
        "carrying finishes leaves the rgba8 wire unchanged"
    );
    assert_eq!(&rgba[0..4], &[204, 204, 217, 255], "#10 keeps its styled colour over the indexed one");

    let finish_of = |i: usize| finish_from_wire([finishes[i * 2], finishes[i * 2 + 1]]);
    let steel = finish_of(0).expect("#10's METAL rendering is on the wire");
    assert_eq!(steel.metallic, Some(1.0));
    assert!(steel.roughness.is_some_and(|r| (r - 0.1).abs() < 1e-6), "1 - 0.9 -> 0.1");
    assert!(finishes[2..6].iter().all(|v| v.is_nan()), "#11 and #30 carry no finish: {finishes:?}");
}

#[test]
fn finish_wire_pair_round_trips_and_treats_non_finite_as_absent() {
    let both = SpecularMaterial { metallic: Some(0.0), roughness: Some(0.25) };
    assert_eq!(finish_from_wire(finish_to_wire(Some(both))), Some(both), "0.0 is authored, not absent");
    let half = SpecularMaterial { metallic: None, roughness: Some(0.5) };
    assert_eq!(finish_from_wire(finish_to_wire(Some(half))), Some(half));
    assert_eq!(finish_from_wire(finish_to_wire(None)), None);
    assert_eq!(
        finish_from_wire([f32::INFINITY, f32::NEG_INFINITY]),
        None,
        "an infinite field is as unauthored as NaN"
    );
}

/// #7675: the counts are wire input. A count of `u32::MAX` reserved 64 GiB
/// before the per-colour bounds check ran (and `offset` could wrap on
/// wasm32); the decoder keeps only the colours `rgba` actually holds.
#[test]
fn material_colors_from_flat_does_not_size_by_the_wire_count() {
    let back = material_colors_from_flat(&[1, 2], &[u32::MAX, 1], &[255, 0, 0, 255]);
    assert_eq!(back.len(), 1, "{back:?}");
    assert_eq!(back[&1], vec![[1.0, 0.0, 0.0, 1.0]]);
}
