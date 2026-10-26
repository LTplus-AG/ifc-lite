// SPDX-License-Identifier: MPL-2.0
//! #7955: actual source constructions and the common linear protocol.
use super::*;
use ifc_lite_core::SourceBundle;
const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCAXIS2PLACEMENT3D(#8,$,$);#8=IFCCARTESIANPOINT((10.,20.,30.));
#9=IFCLOCALPLACEMENT($,#7);#10=IFCWALL('w',$,'Wall',$,$,#9,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#15=IFCDIRECTION((0.,0.,1.));
#17=IFCAXIS2PLACEMENT3D(#18,$,$);#18=IFCCARTESIANPOINT((-4.,3.,2.));
#19=IFCLOCALPLACEMENT($,#17);#20=IFCSLAB('s',$,'Slab',$,$,#19,#21,$,.FLOOR.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23));
#23=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5);
#50=IFCALIGNMENT('a',$,'Road',$,$,$,$,#53);
#51=IFCCARTESIANPOINT((0.,0.,0.));#52=IFCCARTESIANPOINT((10.,0.,0.));#53=IFCPOLYLINE((#51,#52));
#60=IFCBOILERTYPE('t',$,'Library',$,$,$,(#61,#71),$,$,.NOTDEFINED.);
#61=IFCREPRESENTATIONMAP(#7,#12);#71=IFCREPRESENTATIONMAP(#17,#22);
ENDSEC;END-ISO-10303-21;";
fn contract() -> RetainedContract {
    RetainedContract {
        source_epoch: 7,
        source_revision: 9,
    }
}
fn drive(
    program: &mut RetainedProgram,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> Vec<RetainedPlanOperation> {
    let mut operations = Vec::new();
    while let Some(ticket) = program.request().unwrap() {
        let (reply, reached) = program.admit(ticket, router, decoder).unwrap();
        operations.extend(reached);
        program
            .accept(reply, router)
            .unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    operations
}
#[test]
fn common_retained_reached_construction_resumes_same_request_and_accumulates_distinct_occurrences()
{
    let bytes = SOURCE.replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#13)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 2);
    assert_ne!(
        operations[0].value().definition(),
        operations[1].value().definition()
    );
    for operation in &operations {
        assert!(matches!(
            operation.value().definition(),
            LogicalRetainedDefinition::Source {
                source_id: 13,
                source_epoch: 7,
                source_revision: 9,
                ..
            }
        ));
    }
    let plan = program.finish().unwrap();
    assert_eq!(plan.values.len(), 2);
    assert!(plan
        .values
        .iter()
        .all(LogicalRetainedValue::is_product_placed));
    let world = plan.values[0].world_from_evaluation();
    assert_eq!(
        [world[(0, 3)], world[(1, 3)], world[(2, 3)]],
        [9., 18., 30.]
    );
    let source_frame = plan.values[0].world_from_source().unwrap();
    assert_eq!([source_frame[12], source_frame[13], source_frame[14]], [10., 20., 30.]);
}
#[test]
fn common_retained_later_unsupported_branch_refuses_whole_traversal() {
    let bytes = SOURCE.replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#53)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
    assert!(program.finish().is_err());
}
#[test]
fn exact_execute_refuses_retained_numerical_step_without_taking_it() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let mut refused = 0;
    while let Some(ticket) = program.request().unwrap() {
        if matches!(&program.inner.control, Control::Product(c) if c.retained_ready()) {
            assert_eq!(
                program.inner.execute(ticket.0, &router, &mut decoder).err(),
                Some(ProgramError::UnsupportedRetained)
            );
            assert_eq!(program.validate_ticket(ticket), Ok(()));
            assert_eq!(program.inner.pending, Some((ticket.0, false)));
            assert!(matches!(&program.inner.control, Control::Product(c) if c.retained_ready()));
            refused += 1;
        }
        let (reply, _) = program.admit(ticket, &router, &mut decoder).unwrap();
        program
            .accept(reply, &router)
            .unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(refused, 1);
    assert_eq!(program.finish().unwrap().values.len(), 1);
}
#[test]
fn retained_numerical_rejects_foreign_execution_owners_without_consuming_recipe() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut foreign = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let mut tested = false;
    while let Some(ticket) = program.request().unwrap() {
        if matches!(&program.inner.control, Control::Product(c) if c.retained_ready()) {
            assert_eq!(
                program.admit(ticket, &router, &mut foreign).err(),
                Some(RetainedProgramError::WrongOwner)
            );
            tested = true;
        }
        let (reply, _) = program.admit(ticket, &router, &mut decoder).unwrap();
        program
            .accept(reply, &router)
            .unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert!(tested);
}
#[test]
fn common_retained_foreign_admission_reply_is_returned_intact() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut first = RetainedProgram::product_parts(&entity, contract());
    let mut second = RetainedProgram::product_parts(&entity, contract());
    let ticket = first.request().unwrap().unwrap();
    let (reply, _) = first.admit(ticket, &router, &mut decoder).unwrap();
    let rejected = second.accept(reply, &router).err().unwrap();
    assert_eq!(rejected.error, RetainedProgramError::StaleRequest);
    first
        .accept(rejected.reply, &router)
        .unwrap_or_else(|e| panic!("{:?}", e.error));
    assert_eq!(drive(&mut first, &router, &mut decoder).len(), 1);
}
struct CountedAlignment {
    lower: std::rc::Rc<std::cell::Cell<usize>>,
    process: std::rc::Rc<std::cell::Cell<usize>>,
}
impl crate::GeometryProcessor for CountedAlignment {
    fn supported_types(&self) -> Vec<ifc_lite_core::IfcType> {
        vec![ifc_lite_core::IfcType::IfcAlignment]
    }
    fn lower_owned(
        &self,
        _: &ifc_lite_core::DecodedEntity,
        _: &mut EntityDecoder,
        _: crate::TessellationQuality,
        _: Option<(f64, f64, f64)>,
    ) -> Option<crate::Result<crate::program::OwnedConstructor>> {
        self.lower.set(self.lower.get() + 1);
        None
    }
    fn process(
        &self,
        _: &ifc_lite_core::DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &ifc_lite_core::IfcSchema,
        _quality: crate::TessellationQuality,
    ) -> crate::Result<crate::Mesh> {
        self.process.set(self.process.get() + 1);
        // The real extension repairs the late placement cache and delegates
        // geometry to the actual registered primitive implementation.
        let mut placement = nalgebra::Matrix4::identity();
        placement[(0, 3)] = 7.;
        decoder.cache_placement_transform(20, crate::math::mat4::col_major_array(&placement));
        let block = decoder.decode_by_id(10)?;
        // BlockProcessor::process is exactly this owned lower/evaluate route.
        // Calling the same-named trait method looks recursive to the walk audit.
        Ok(crate::processors::BlockProcessor::new()
            .lower(&block, decoder)?
            .evaluate())
    }
}

#[test]
fn retained_alignment_refuses_before_callbacks_while_exact_keeps_real_extension_and_late_placement()
{
    use std::{cell::Cell, rc::Rc};
    let source = "#1=IFCALIGNMENT('a',$,$,$,$,#20,#999,$,$);
#10=IFCBLOCK($,2.,3.,4.);#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);#22=IFCCARTESIANPOINT((0.,0.,0.));";
    let lower = Rc::new(Cell::new(0));
    let process = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(CountedAlignment {
        lower: lower.clone(),
        process: process.clone(),
    }));
    let mut decoder = EntityDecoder::new(source);
    let root = decoder.decode_by_id(1).unwrap();
    let mut retained = RetainedProgram::product_parts(&root, contract());
    assert!(retained.request().unwrap().is_none());
    assert_eq!(
        lower.get(),
        0,
        "retained refusal precedes even selected alignment lowering"
    );
    assert_eq!(
        process.get(),
        0,
        "no opaque sampled callback under retained contract"
    );
    assert!(
        decoder.get_cached(10).is_none(),
        "no primitive source admitted"
    );
    assert!(
        decoder.get_cached(20).is_none(),
        "no late placement read or callback repair"
    );
    assert!(
        decoder.get_cached(999).is_none(),
        "unsupported prelude never falls through to Body"
    );
    assert!(
        retained.finish().is_err(),
        "refusal is not an empty completed retained plan"
    );

    let mut decoder = EntityDecoder::new(source);
    let root = decoder.decode_by_id(1).unwrap();
    let mut exact = GeometryProgram::product(&root, crate::router::processing::SourceHygiene::IndexOnly);
    while let Some(request) = exact.request().unwrap() {
        let reply = exact.execute(request, &router, &mut decoder).unwrap();
        exact.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(lower.get(), 0, "landed alignment dispatch calls its real extension directly");
    assert_eq!(
        process.get(),
        1,
        "the same selected exact extension still executes once"
    );
    let parts = exact.finish_parts().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].indices.len(), 36);
    assert!((crate::mesh_check::signed_volume(&parts[0]).abs() - 24.).abs() < 1e-6);
    let min_x = parts[0]
        .positions
        .chunks_exact(3)
        .map(|p| p[0])
        .fold(f32::INFINITY, f32::min);
    let max_x = parts[0]
        .positions
        .chunks_exact(3)
        .map(|p| p[0])
        .fold(f32::NEG_INFINITY, f32::max);
    assert_eq!(
        (min_x, max_x),
        (7., 9.),
        "callback's real placement repair is consumed late"
    );
    assert!(
        decoder.get_cached(999).is_none(),
        "successful dedicated alignment retains no Body fallback"
    );
}

// #7955: retained admission must not substitute a built-in for an extension.
#[test]
fn custom_processor_for_extrusion_refuses_retained_capture() {
    use std::{cell::Cell, rc::Rc};
    struct Custom(Rc<Cell<u32>>);
    impl crate::GeometryProcessor for Custom {
        fn supported_types(&self) -> Vec<ifc_lite_core::IfcType> {
            vec![ifc_lite_core::IfcType::IfcExtrudedAreaSolid]
        }
        fn process(
            &self,
            entity: &DecodedEntity,
            decoder: &mut EntityDecoder,
            schema: &ifc_lite_core::IfcSchema,
            quality: crate::TessellationQuality,
        ) -> Result<Mesh> {
            self.0.set(self.0.get() + 1);
            crate::ExtrudedAreaSolidProcessor::new(schema.clone())
                .process(entity, decoder, schema, quality)
        }
    }
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let calls = Rc::new(Cell::new(0));
    router.register(Box::new(Custom(calls.clone())));
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    assert!(drive(&mut program, &router, &mut decoder).is_empty());
    let failure = program.finish().unwrap_err();
    let RetainedFailure::Origin(handle) = failure else { panic!("expected custom origin") };
    assert!(matches!(handle.origin().unwrap().cause,
        crate::program::retained::failure::OriginCause::Processor(Some(crate::router::ProcessorOrigin::Custom))));
    assert_eq!(calls.get(), 0);
    let solid = decoder.decode_by_id(13).unwrap();
    let mesh = router
        .process_representation_item(&solid, &mut decoder)
        .unwrap();
    assert!(!mesh.is_empty());
    assert_eq!(calls.get(), 1);
}

#[test]
fn retained_mapped_cycle_is_refused_without_following_the_cycle() {
    let text = SOURCE.replace("'SweptSolid',(#13)","'MappedRepresentation',(#90)")
        .replace("ENDSEC;END-ISO-10303-21;", "#90=IFCMAPPEDITEM(#61,#91);#91=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);ENDSEC;END-ISO-10303-21;");
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&text, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let first = mapping_tests::stop(&mut program, &router, &mut decoder);
    assert!(matches!(first, RetainedProgramError::Stopped(crate::resource::ProgramStop::ResourceRefused(f))
        if f.dimension == crate::resource::Dimension::Representation && f.requested == 2));
    assert_eq!(program.request().err(), Some(first));
    assert!(program.finish().is_err());
}

#[path = "mapping_tests.rs"]
mod mapping_tests;
#[path = "type_map_tests.rs"]
mod type_map_tests;

#[path = "obligations_tests.rs"]
mod obligations;
#[path = "disk_tests.rs"]
mod disk;
#[path = "protocol_tests.rs"]
mod protocol;
#[path = "structure_tests.rs"]
mod structure;
#[path = "frame_tests.rs"]
mod frames;
#[path = "admission_tests.rs"]
mod admission;

#[path = "mapping_contract_tests.rs"]
mod mapping_contract;

#[path = "mapping_input_tests.rs"]
mod mapping_inputs;
#[path = "affine_tests.rs"]
mod affine_tests;
#[path = "boolean_tests.rs"]
mod boolean_tests;

#[path = "operation_contract_tests.rs"]
mod operation_contract;

#[path = "accept_stop_tests.rs"]
mod accept_stop_tests;

#[path = "finalization_stop_tests.rs"]
mod finalization_stop_tests;

#[path = "outcome_tests.rs"]
mod outcome_tests;

#[path = "origin_tests.rs"]
mod origins;
