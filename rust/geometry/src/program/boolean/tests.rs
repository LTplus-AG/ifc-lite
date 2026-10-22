// SPDX-License-Identifier: MPL-2.0
//! The Boolean/CSG continuation as common-program steps: the selected
//! processor's recorder, the solid/solid numerical step, a returned stop,
//! errors and native-stack independence.
use crate::program::{GeometryProgram, ProgramStage};
use crate::resource::{self, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use crate::{BoolFailureReason, GeometryProcessor, GeometryRouter};
use ifc_lite_core::{EntityDecoder, IfcSchema};

fn wrap_ifc(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Two overlapping blocks, unioned.
const UNION: &str = "#1=IFCBOOLEANRESULT(.UNION.,#2,#3);\n#2=IFCBLOCK($,1.,1.,1.);\n\
    #3=IFCBLOCK(#4,1.,1.,1.);\n#4=IFCAXIS2PLACEMENT3D(#5,$,$);\n#5=IFCCARTESIANPOINT((0.5,0.5,0.5));\n";

/// Each step is a program request; the solid/solid union is a numerical
/// step, and the program's mesh is the processor's own synchronous result.
#[test]
fn a_solid_boolean_is_a_numerical_program_step() {
    let content = wrap_ifc(UNION);
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(&content);
    let item = decoder.decode_by_id(1).unwrap();
    let mut program = GeometryProgram::item(&item, (0., 0., 0.));
    let mut stages = Vec::new();
    while let Some(request) = program.request().unwrap() {
        stages.push(request.stage());
        let reply = program.execute(request, &router, &mut decoder).unwrap();
        program.accept(reply, &router).ok().unwrap();
    }
    let mesh = program.finish().unwrap();
    assert!(!stages.contains(&ProgramStage::Extension), "no processor callback runs the whole boolean");
    assert_eq!(stages.iter().filter(|stage| **stage == ProgramStage::Numerical).count(), 1);
    // The late unit scale is read by the source step before the boolean.
    let solid = stages.iter().position(|stage| *stage == ProgramStage::Numerical).unwrap();
    assert_eq!(stages[solid - 1], ProgramStage::Source);
    let mut decoder = EntityDecoder::new(&content);
    let processor = crate::processors::BooleanClippingProcessor::new();
    let expected = processor.process(&item, &mut decoder, &IfcSchema::new(), Default::default()).unwrap();
    assert_eq!(mesh.positions, expected.positions);
    assert_eq!(mesh.indices, expected.indices);
}

/// A loss is recorded by the router's selected processor, through the
/// program: an unsupported union operand under an `IfcCsgSolid`.
#[test]
fn a_csg_item_records_through_the_selected_processor() {
    let content = wrap_ifc(
        "#9=IFCCSGSOLID(#1);\n#1=IFCBOOLEANRESULT(.UNION.,#2,#3);\n#2=IFCBLOCK($,1.,1.,1.);\n\
         #3=IFCCARTESIANPOINT((0.,0.,0.));\n",
    );
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(&content);
    let item = decoder.decode_by_id(9).unwrap();
    let mesh = GeometryProgram::item(&item, (0., 0., 0.)).drain(&router, &mut decoder).unwrap();
    assert!(!mesh.is_empty(), "the base block survives its unsupported union operand");
    router.drain_processor_failures();
    let failures: Vec<_> = router.take_csg_failures().into_values().flatten().collect();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(matches!(&failures[0].reason, BoolFailureReason::UnsupportedOperand(kind) if kind == "IfcCartesianPoint"));
}

/// A stop reached between steps ends the item with the stop: no further
/// operand is meshed and the boolean never runs.
#[test]
fn a_stop_between_boolean_steps_is_returned() {
    let content = wrap_ifc(UNION);
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(&content);
    let item = decoder.decode_by_id(1).unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let (result, stages) = account.scope(|| {
        let mut program = GeometryProgram::item(&item, (0., 0., 0.));
        let mut stages = Vec::new();
        while let Some(request) = program.request().unwrap() {
            stages.push(request.stage());
            let reply = program.execute(request, &router, &mut decoder).unwrap();
            program.accept(reply, &router).ok().unwrap();
            if stages.len() == 2 {
                resource::stop(ProgramStop::Cancelled);
            }
        }
        (program.finish(), stages)
    });
    assert!(matches!(result, Err(crate::Error::ProgramStopped(_))), "{:?}", result.err());
    assert!(!stages.contains(&ProgramStage::Numerical), "the boolean never ran");
}

/// A 2 x 2 x 2 block host whose base operand records a loss while it is
/// meshed (a union with an unsupported point), under a chain of two
/// polygonal-bounded cutters: the batched attempt meshes that base
/// provisionally before it commits or defers.
const BATCHED_CHAIN: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((0.,0.,1.));\n\
    #3=IFCDIRECTION((1.,0.,0.));\n#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);\n\
    #5=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);\n#6=IFCEXTRUDEDAREASOLID(#5,#4,#2,2.);\n\
    #10=IFCCARTESIANPOINT((0.,0.,1.));\n#11=IFCAXIS2PLACEMENT3D(#10,#2,#3);\n#12=IFCPLANE(#11);\n\
    #30=IFCCARTESIANPOINT((0.,0.));\n#31=IFCCARTESIANPOINT((2.,0.));\n#32=IFCCARTESIANPOINT((2.,2.));\n\
    #33=IFCCARTESIANPOINT((0.,2.));\n#34=IFCPOLYLINE((#30,#31,#32,#33,#30));\n\
    #13=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n#14=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n\
    #50=IFCBOOLEANRESULT(.UNION.,#6,#51);\n#51=IFCCARTESIANPOINT((0.,0.,0.));\n\
    #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#50,#13);\n\
    #21=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#20,#14);\n";

/// A stop that lands after the batched chain's base was meshed, before the
/// attempt commits or defers, drops the continuation with the attempt
/// pending. Its provisional records go with it: the shared recorder's log is
/// what it was before the item started.
#[test]
fn a_stop_during_a_batched_attempt_retracts_its_provisional_records() {
    let content = wrap_ifc(BATCHED_CHAIN);
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(&content);
    let item = decoder.decode_by_id(21).unwrap();
    let recorder = router.processor_for(&item.ifc_type).expect("the boolean processor is selected");
    let before = recorder.bool_failure_count();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let (result, recorded_at_stop) = account.scope(|| {
        let mut program = GeometryProgram::item(&item, (0., 0., 0.));
        let mut recorded_at_stop = None;
        while let Some(request) = program.request().unwrap() {
            let reply = program.execute(request, &router, &mut decoder).unwrap();
            program.accept(reply, &router).ok().unwrap();
            if recorded_at_stop.is_none() && recorder.bool_failure_count() > before {
                recorded_at_stop = Some(recorder.bool_failure_count() - before);
                resource::stop(ProgramStop::Cancelled);
            }
        }
        (program.finish(), recorded_at_stop)
    });
    assert!(recorded_at_stop.is_some(), "the base operand records a loss while it is meshed");
    assert!(matches!(result, Err(crate::Error::ProgramStopped(_))), "{:?}", result.err());
    assert_eq!(recorder.bool_failure_count(), before, "the provisional record outlived the stopped attempt");
}

/// Malformed trees still end in their own errors through the program.
#[test]
fn cycles_and_unresolved_operands_end_the_item() {
    let router = GeometryRouter::new();
    for (data, message) in [
        ("#1=IFCBOOLEANRESULT(.UNION.,#1,#2);\n#2=IFCBLOCK($,1.,1.,1.);\n", "cyclic boolean FirstOperand chain"),
        (
            "#1=IFCBOOLEANRESULT(.UNION.,#2,#3);\n#2=IFCBLOCK($,1.,1.,1.);\n#3=IFCCSGSOLID(#4);\n\
             #4=IFCBOOLEANRESULT(.UNION.,#2,#3);\n",
            "Cyclic boolean/CSG operand reference",
        ),
    ] {
        let content = wrap_ifc(data);
        let mut decoder = EntityDecoder::new(&content);
        let item = decoder.decode_by_id(1).unwrap();
        let error = GeometryProgram::item(&item, (0., 0., 0.)).drain(&router, &mut decoder).unwrap_err();
        assert!(error.to_string().contains(message), "{error}");
    }
}

/// Operand nesting is held on the heap: a chain close to the path bound runs
/// on a thread whose native stack could not hold that many processor frames.
#[test]
fn operand_nesting_near_the_path_bound_does_not_use_native_stack() {
    let hops: u32 = 30;
    let mut data = String::new();
    for i in 0..hops {
        let b = 1 + i * 2;
        let c = 2 + i * 2;
        let next = if i + 1 == hops { 90_000 } else { 1 + (i + 1) * 2 };
        // The CSG hop is the operand on the FIRST side, so each level's base
        // is the next level: the path grows by two nodes per hop.
        data.push_str(&format!("#{b}=IFCBOOLEANRESULT(.UNION.,#{c},#90001);\n"));
        data.push_str(&format!("#{c}=IFCCSGSOLID(#{next});\n"));
    }
    data.push_str("#90000=IFCBLOCK($,1.,1.,1.);\n#90001=IFCCARTESIANPOINT((0.,0.,0.));\n");
    let content = wrap_ifc(&data);
    let handle = std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(move || {
            let router = GeometryRouter::new();
            let mut decoder = EntityDecoder::new(&content);
            let item = decoder.decode_by_id(1).expect("decode #1");
            GeometryProgram::item(&item, (0., 0., 0.))
                .drain(&router, &mut decoder)
                .map(|mesh| mesh.positions.len())
                .map_err(|error| error.to_string())
        })
        .expect("spawn small-stack worker");
    let vertices = handle.join().expect("no stack overflow").expect("the chain resolves");
    assert!(vertices > 0, "the innermost block reaches the result");
}
