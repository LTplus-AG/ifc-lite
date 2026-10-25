// SPDX-License-Identifier: MPL-2.0
//! #7955: optional axes retain canonical defaults, transforms and cache reuse.
use super::*;

pub(super) fn admit(bytes: &str, source_id: u32, target_id: u32, constructions: usize) {
    for mode in 0..3 {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(bytes, &mut decoder);
        let target = decoder.decode_by_id(target_id).unwrap();
        let map = decoder.decode_by_id(source_id).unwrap();
        let target = router.parse_cartesian_transformation_operator(&target, &mut decoder).unwrap();
        let origin = router.mapping_origin_frame(&map, &mut decoder).unwrap().unwrap();
        let expected = crate::math::mat4::col_major_array(&(target * origin));
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = match mode {
            0 => RetainedProgram::product_parts(&entity, contract()),
            1 => RetainedProgram::product_submeshes(&entity, true, None, contract()),
            _ => RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract()),
        };
        let selection = program.selection().unwrap().clone();
        let operations = drive(&mut program, &router, &mut decoder);
        if constructions == 1 {
            assert!(matches!(operations[0].value().definition(),
                LogicalRetainedDefinition::Source { source_id: 113, .. }));
            let cached = selection.cached(&decoder, &router, source_id).unwrap().unwrap();
            assert_eq!(cached.len(), 1);
            assert_eq!(cached[0].definition(), operations[0].value().definition());
        }
        assert_eq!(operations.iter().filter(|op| op.construction().is_some()).count(), constructions);
        let plan = if mode == 2 { program.finish_type_map(60, 1, [1.; 4]).unwrap() }
            else { program.finish().unwrap() };
        assert_eq!(plan.values.len(), 2, "mode {mode}: {bytes}");
        let placement = plan.values[1].placements().iter().find(|placement|
            placement.stage == RetainedPlacementStage::Mapping { source_id }).unwrap();
        assert_eq!(placement.matrix, expected, "canonical arithmetic, mode {mode}: {bytes}");
        assert!(plan.values.iter().all(|value| value.object_frame().iter().all(|v| v.is_finite())));
    }
}

#[test]
fn s2_r1_target_optional_axis_combinations_keep_canonical_frames_and_cache_hits() {
    // Every subset of X/Y/Z, for uniform and nonuniform operators.
    for nonuniform in [false, true] {
        for mask in 0..8 {
            let x = if mask & 1 == 0 { "$" } else { "#97" };
            let y = if mask & 2 == 0 { "$" } else { "#98" };
            let z = if mask & 4 == 0 { "$" } else { "#99" };
            let target = if nonuniform {
                format!("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM({x},{y},#84,1.,{z},$,$)")
            } else { format!("IFCCARTESIANTRANSFORMATIONOPERATOR3D({x},{y},#84,1.,{z})") };
            admit(&later_target(&target, AXES), 81, 96, 1);
        }
        for mask in 0..4 {
            let x = if mask & 1 == 0 { "$" } else { "#100" };
            let y = if mask & 2 == 0 { "$" } else { "#101" };
            let target = if nonuniform {
                format!("IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM({x},{y},#84,1.,$)")
            } else { format!("IFCCARTESIANTRANSFORMATIONOPERATOR2D({x},{y},#84,1.)") };
            admit(&later_target(&target, AXES), 81, 96, 1);
        }
    }
    // Omission permits deriving an axis. Comparing every authored direction
    // with a fixed default would incorrectly reject these valid controls.
    for target in [
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,1.,#97)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,#99,#84,1.,#97)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#98,$,#84,1.,#97)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR2D($,#100,#84,1.)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM($,#100,#84,1.,$)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#102,#98,#84,1.,#99)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#97,#103,#84,1.,#99)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR2D(#100,#104,#84,1.)",
    ] {
        admit(&later_target(target, &format!("{AXES}#102=IFCDIRECTION((2.,0.,1.));#103=IFCDIRECTION((0.,-2.,0.));#104=IFCDIRECTION((0.,-2.));")), 81, 96, 1);
    }
}

#[test]
fn s2_r1_origin_optional_axis_combinations_keep_canonical_frames() {
    for origin in [
        "IFCAXIS2PLACEMENT3D(#4,$,$)",
        "IFCAXIS2PLACEMENT3D(#4)",
        "IFCAXIS2PLACEMENT3D(#4,#99,$)",
        "IFCAXIS2PLACEMENT3D(#4,$,#97)",
        "IFCAXIS2PLACEMENT3D(#4,#99,#97)",
        "IFCAXIS2PLACEMENT3D(#4,#97,$)",
        "IFCAXIS2PLACEMENT3D(#4,#97,#98)",
        "IFCAXIS2PLACEMENT3D(#4,#99,#102)",
        "IFCAXIS2PLACEMENT2D(#4,$)",
        "IFCAXIS2PLACEMENT2D(#4)",
        "IFCAXIS2PLACEMENT2D(#4,#101)",
    ] {
        admit(&later_origin(origin, &format!("{AXES}#102=IFCDIRECTION((2.,0.,1.));")), 94, 82, 2);
    }
}

#[test]
fn s2_r1_direct_type_map_optional_origins_keep_late_canonical_placement() {
    for origin in ["IFCAXIS2PLACEMENT3D(#4,$,$)", "IFCAXIS2PLACEMENT3D(#4,#97,$)",
        "IFCAXIS2PLACEMENT3D(#4,$,#98)", "IFCAXIS2PLACEMENT3D(#4,#97,#98)"] {
        let bytes = SOURCE.replace("#61=IFCREPRESENTATIONMAP(#7,#12)", "#61=IFCREPRESENTATIONMAP(#96,#12)")
            .replace("ENDSEC;END-ISO", &format!("#96={origin};{AXES}ENDSEC;END-ISO"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let map = decoder.decode_by_id(61).unwrap();
        let expected = router.mapping_origin_frame(&map, &mut decoder).unwrap().unwrap();
        let mut program = RetainedProgram::type_map(map, None, contract());
        assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
        let plan = program.finish_type_map(60, 1, [1.; 4]).unwrap();
        assert_eq!(plan.values.len(), 1);
        assert_eq!(plan.values[0].placements()[0].matrix, crate::math::mat4::col_major_array(&expected));
    }
}
