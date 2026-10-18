// SPDX-License-Identifier: MPL-2.0
//! Owned void-shell extraction preserves cavity volume, operand roles and
//! conditional production admission after source disposal.
use super::*;
use crate::kernel::mesh_volume::mesh_volume;
use crate::processors::{advanced_face::note_face_refused, take_face_refused};

fn box_shell(first: u32, lo: f64, hi: f64, advanced: bool) -> String {
    let faces = [
        [0, 2, 3, 1],
        [4, 5, 7, 6],
        [0, 1, 5, 4],
        [1, 3, 7, 5],
        [3, 2, 6, 7],
        [2, 0, 4, 6],
    ];
    let mut source = String::new();
    for i in 0..8 {
        let c = |axis| if i & (1_u32 << axis) == 0_u32 { lo } else { hi };
        source.push_str(&format!(
            "#{}=IFCCARTESIANPOINT(({},{},{}));\n",
            first + 1 + i,
            c(0),
            c(1),
            c(2)
        ));
    }
    let mut ids = Vec::new();
    for (i, face) in faces.iter().enumerate() {
        let id = first + 10 + i as u32 * 3;
        let refs = face
            .iter()
            .map(|corner| format!("#{}", first + 1 + corner))
            .collect::<Vec<_>>()
            .join(",");
        source.push_str(&format!(
            "#{id}=IFCPOLYLOOP(({refs}));#{}=IFCFACEOUTERBOUND(#{id},.T.);",
            id + 1
        ));
        if advanced {
            source.push_str(&format!(
                "#{}=IFCADVANCEDFACE((#{}),#9000,.T.);",
                id + 2,
                id + 1
            ));
        } else {
            source.push_str(&format!("#{}=IFCFACE((#{}));", id + 2, id + 1));
        }
        ids.push(format!("#{}", id + 2));
    }
    source.push_str(&format!("#{first}=IFCCLOSEDSHELL(({}));\n", ids.join(",")));
    source
}
fn source(advanced: bool, voids: &str, inner_lo: f64, inner_hi: f64) -> String {
    let name = if advanced {
        "IFCADVANCEDBREPWITHVOIDS"
    } else {
        "IFCFACETEDBREPWITHVOIDS"
    };
    format!("{}{}#91={name}(#100,{voids});\n\
        #9000=IFCPLANE(#9001);#9001=IFCAXIS2PLACEMENT3D(#9002,$,$);#9002=IFCCARTESIANPOINT((0.,0.,0.));",
        box_shell(100,0.,2.,advanced),box_shell(200,inner_lo,inner_hi,advanced))
}
fn shell_kind(advanced: bool) -> IfcType {
    if advanced {
        IfcType::IfcAdvancedBrep
    } else {
        IfcType::IfcFacetedBrep
    }
}
fn assert_volume(mesh: &Mesh, expected: f64) {
    assert!(
        (mesh_volume(mesh) - expected).abs() < 1e-5,
        "volume {}, expected {expected}",
        mesh_volume(mesh)
    );
}

#[test]
fn owned_faceted_and_advanced_voids_replay_cavity_after_source_disposal_and_keep_outer_only_roles()
{
    for advanced in [false, true] {
        let recorder = BooleanClippingProcessor::new();
        let (plan, outer) = {
            let bytes = source(advanced, "(#200)", 0.5, 1.5);
            let mut decoder = EntityDecoder::new(&bytes);
            let operand = decoder.decode_by_id(91).unwrap();
            let (outer, recorded) = recorder
                .process_operand_checked(
                    BoolOp::Unknown,
                    &operand,
                    &mut decoder,
                    TessellationQuality::Medium,
                )
                .unwrap();
            assert!(!recorded);
            assert_volume(&outer, 8.);
            (
                VoidShellPlan::lower(
                    &operand,
                    &shell_kind(advanced),
                    &mut decoder,
                    TessellationQuality::Medium,
                ),
                outer,
            )
        };
        let replay = plan.clone();
        for plan in [plan, replay] {
            let VoidPreparation::Ready(ready) = plan.evaluate_shells(&recorder, BoolOp::Difference)
            else {
                panic!("valid shells");
            };
            let (hollow, recorded) = ready.subtract(
                outer.clone(),
                1.,
                &recorder.effects,
                BoolOp::Difference,
                &if advanced {
                    IfcType::IfcAdvancedBrepWithVoids
                } else {
                    IfcType::IfcFacetedBrepWithVoids
                },
            );
            assert!(!recorded);
            assert_volume(&hollow, 7.);
        }
        assert!(recorder.take_failures().is_empty());
    }
}

#[test]
fn no_overlap_void_keeps_outer_bytes_and_engulfing_void_refuses_once() {
    for (lo, hi, engulfs) in [(3., 4., false), (-1., 3., true)] {
        let bytes = source(false, "(#200)", lo, hi);
        let mut decoder = EntityDecoder::new(&bytes);
        let operand = decoder.decode_by_id(91).unwrap();
        let outer = ShellPlan::lower(
            100,
            ShellKind::Faceted,
            &mut decoder,
            TessellationQuality::Medium,
        )
        .unwrap()
        .evaluate()
        .unwrap();
        let recorder = BooleanClippingProcessor::new();
        let VoidPreparation::Ready(ready) = VoidShellPlan::lower(
            &operand,
            &IfcType::IfcFacetedBrep,
            &mut decoder,
            TessellationQuality::Medium,
        )
        .evaluate_shells(&recorder, BoolOp::Difference) else {
            panic!("valid shells");
        };
        let (result, recorded) = ready.subtract(
            outer.clone(),
            1.,
            &recorder.effects,
            BoolOp::Difference,
            &operand.ifc_type,
        );
        assert_eq!(recorded, engulfs);
        if engulfs {
            assert!(result.is_empty());
            assert_eq!(recorder.take_failures().len(), 1);
        } else {
            assert_eq!(result.positions, outer.positions);
            assert_eq!(result.indices, outer.indices);
            assert!(recorder.take_failures().is_empty());
        }
    }
}

#[test]
fn terminal_void_reference_fault_replays_prior_shell_reports_and_records_one_loss() {
    take_face_refused();
    note_face_refused(&IfcType::IfcFaceSurface);
    let plan = {
        let bytes = source(false, "(#200,$)", 0.5, 1.5)
            .replace("#200=IFCCLOSEDSHELL((", "#200=IFCCLOSEDSHELL((#2999,")
            + "#2999=IFCFACE((#999999));";
        let mut decoder = EntityDecoder::new(&bytes);
        let operand = decoder.decode_by_id(91).unwrap();
        VoidShellPlan::lower(
            &operand,
            &IfcType::IfcFacetedBrep,
            &mut decoder,
            TessellationQuality::Medium,
        )
    };
    assert_eq!(
        take_face_refused(),
        [IfcType::IfcFaceSurface],
        "source reports are owned, prior caller reports survive"
    );
    assert_eq!(plan.source_reports().face_refused, [IfcType::IfcFace]);
    let recorder = BooleanClippingProcessor::new();
    assert!(matches!(
        plan.evaluate_shells(&recorder, BoolOp::Difference),
        VoidPreparation::Refused
    ));
    assert_eq!(take_face_refused(), [IfcType::IfcFace]);
    let failures = recorder.take_failures();
    assert_eq!(failures.len(), 1);
    // Production formats IfcType via Display, which uses its EXPRESS name.
    assert_eq!(failures[0].reason, crate::BoolFailureReason::KernelError(
        "IfcFacetedBrepWithVoids cutter voids: void is not a shell reference".to_owned()));
}

const UNUSABLE_UNIT:&str="#1=IFCPROJECT('P',$,$,$,$,$,$,$,#2);#2=IFCUNITASSIGNMENT((#3));\n\
    #3=IFCCONVERSIONBASEDUNIT(#4,.LENGTHUNIT.,'CUSTOM',#8);#4=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);\n\
    #8=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.),#9);#9=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);";
#[test]
fn production_empty_or_invalid_shells_do_not_discover_units_or_decode_later_shells() {
    for (voids, empty_outer) in [
        ("(#300,#400)", false),
        ("($,#400)", false),
        ("(#400)", true),
        ("()", false),
    ] {
        let bytes=source(false,voids,0.5,1.5)+UNUSABLE_UNIT+
            "#300=IFCCLOSEDSHELL(());#400=IFCCLOSEDSHELL((#401));#401=IFCFACE((#402));\n\
            #402=IFCFACEOUTERBOUND(#403,.T.);#403=IFCPOLYLOOP((#404,#405,#406));\n\
            #404=IFCCARTESIANPOINT((1.E400,0.,0.));#405=IFCCARTESIANPOINT((0.,1.,0.));#406=IFCCARTESIANPOINT((0.,0.,1.));";
        let mut decoder = EntityDecoder::new(&bytes).with_strict_reals();
        let operand = decoder.decode_by_id(91).unwrap();
        let outer = if empty_outer {
            Mesh::new()
        } else {
            ShellPlan::lower(
                100,
                ShellKind::Faceted,
                &mut decoder,
                TessellationQuality::Medium,
            )
            .unwrap()
            .evaluate()
            .unwrap()
        };
        let recorder = BooleanClippingProcessor::new();
        let (_, recorded) = recorder.without_voids(
            IfcType::IfcFacetedBrep,
            BoolOp::Difference,
            &operand,
            outer,
            &mut decoder,
            TessellationQuality::Medium,
        ).unwrap();
        assert_eq!(recorded, !empty_outer && voids != "()");
        assert!(
            decoder.refused_record_ids().is_empty(),
            "neither later bad point nor invalid unit may be read: {:?}",
            decoder.refused_record_ids()
        );
        assert_eq!(recorder.take_failures().len(), usize::from(recorded));
        decoder.length_unit_scale();
        assert!(
            decoder.refused_record_ids().contains(&8),
            "unit diagnostic is observable when explicitly discovered"
        );
    }
}
#[test]
fn production_discovers_units_only_after_all_void_shells_mesh_nonempty() {
    let bytes = source(false, "(#200)", 0.5, 1.5) + UNUSABLE_UNIT;
    let mut decoder = EntityDecoder::new(&bytes).with_strict_reals();
    let operand = decoder.decode_by_id(91).unwrap();
    let outer = ShellPlan::lower(
        100,
        ShellKind::Faceted,
        &mut decoder,
        TessellationQuality::Medium,
    )
    .unwrap()
    .evaluate()
    .unwrap();
    assert!(decoder.refused_record_ids().is_empty());
    let recorder = BooleanClippingProcessor::new();
    let (hollow, recorded) = recorder.without_voids(
        IfcType::IfcFacetedBrep,
        BoolOp::Difference,
        &operand,
        outer,
        &mut decoder,
        TessellationQuality::Medium,
    ).unwrap();
    assert!(!recorded);
    assert_volume(&hollow, 7.);
    assert_eq!(decoder.refused_record_ids(), [8]);
    assert!(recorder.take_failures().is_empty());
}
