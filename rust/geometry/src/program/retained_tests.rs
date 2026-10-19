// SPDX-License-Identifier: MPL-2.0
//! Continuation invariant for the retained migration (no runtime execution claim).
use super::inner::ProgramStage;
use super::*;
use crate::GeometryRouter;
use ifc_lite_core::EntityDecoder;

const SOURCE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#10=IFCWALL('w',$,'Wall',$,$,$,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION(#3,'Body','SweptSolid',(#13,#13));
#13=IFCEXTRUDEDAREASOLID(#14,#2,#15,3.000000000123);
#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);#15=IFCDIRECTION((0.,0.,1.));
#16=IFCBLOCK(#2,1.,1.,1.);";
fn program(decoder: &mut EntityDecoder<'_>) -> GeometryProgram {
    GeometryProgram::retained_parts(
        decoder.decode_by_id(10).unwrap(),
        RetainedContract {
            source_epoch: 7,
            source_revision: 11,
        },
    )
}
#[test]
fn common_retained_reached_construction_resumes_same_request_and_accumulates_distinct_occurrences()
{
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::new();
    let mut program = program(&mut decoder);
    let mut slots = Vec::new();
    while let Some(request) = program.request().unwrap() {
        if request.stage() == ProgramStage::Numerical {
            // The ordinary exact entry must refuse without consuming the recipe.
            assert_eq!(
                program.execute(request, &router, &mut decoder).err(),
                Some(ProgramError::UnsupportedRetained)
            );
        }
        let (reply, operation) = program
            .admit_retained_with_inputs(request, &router, &mut decoder, None, None)
            .unwrap();
        assert_eq!(program.request().err(), Some(ProgramError::Outstanding));
        if let Some(operation) = operation {
            let source = operation
                .construction()
                .extrusion()
                .expect("original analytic source");
            assert_eq!(source.source.depth, Some(3.000000000123));
            assert_eq!((source.source_epoch, source.source_revision), (7, 11));
            assert!(source
                .source
                .source
                .as_ref()
                .unwrap()
                .records
                .contains_key(&13));
            slots.push(operation.value().slot());
        }
        program.accept(reply, &router).unwrap();
    }
    let plan = program.finish_retained().unwrap();
    assert_eq!(slots.len(), 2);
    assert_ne!(
        slots[0], slots[1],
        "repeated STEP id is two common occurrences"
    );
    assert_eq!(plan.values.iter().map(|v|v.placements().last().unwrap().input).collect::<Vec<_>>(),slots);
    assert_ne!(plan.values[0].slot(),plan.values[1].slot());
    assert!(plan.remaining.contains(&RetainedRequirement::IfcAppearance));
    assert!(plan
        .remaining
        .contains(&RetainedRequirement::OpeningClosure));
    assert!(!plan.remaining.contains(&RetainedRequirement::ProductPlacement));
    assert!(plan.values.iter().all(LogicalRetainedValue::is_product_placed));
}
#[test]
fn common_retained_later_unsupported_branch_refuses_whole_traversal() {
    let source = SOURCE.replace("(#13,#13)", "(#13,#16)");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let mut program = program(&mut decoder);
    let mut constructions = 0;
    while let Some(request) = program.request().unwrap() {
        let (reply, operation) = program
            .admit_retained_with_inputs(request, &router, &mut decoder, None, None)
            .unwrap();
        constructions += usize::from(operation.is_some());
        program.accept(reply, &router).unwrap();
    }
    assert_eq!(
        constructions, 1,
        "no sampled block relabelled as analytic input"
    );
    assert!(
        program.finish_retained().is_err(),
        "first leaf is no product completion"
    );
}
#[test]
fn common_retained_foreign_admission_reply_is_returned_intact() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::new();
    let mut first = program(&mut decoder);
    let mut foreign = program(&mut decoder);
    let request = first.request().unwrap().unwrap();
    let (reply, _) = first
        .admit_retained_with_inputs(request, &router, &mut decoder, None, None)
        .unwrap();
    let rejected = foreign.accept(reply, &router).unwrap_err();
    assert_eq!(rejected.error, ProgramError::StaleRequest);
    first.accept(rejected.reply, &router).unwrap();
    assert!(first.request().unwrap().is_some());
}

#[test]
fn retained_numerical_rejects_foreign_execution_owners_without_consuming_recipe() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut foreign_decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::new();
    let foreign_router = GeometryRouter::new();
    let mut program = program(&mut decoder);
    let mut operations = 0;
    while let Some(request) = program.request().unwrap() {
        if request.stage() == ProgramStage::Numerical {
            assert_eq!(program.admit_retained_with_inputs(request, &router,
                &mut foreign_decoder, None, None).err(), Some(ProgramError::WrongOwner));
            assert_eq!(program.admit_retained_with_inputs(request, &foreign_router,
                &mut decoder, None, None).err(), Some(ProgramError::WrongOwner));
        }
        let (reply, operation) = program.admit_retained_with_inputs(request, &router,
            &mut decoder, None, None).unwrap();
        operations += usize::from(operation.is_some());
        program.accept(reply, &router).unwrap();
    }
    assert_eq!(operations, 2);
    assert_eq!(program.finish_retained().unwrap().values.len(), 2);
}

struct CountedAlignment {
    lower: std::rc::Rc<std::cell::Cell<usize>>,
    process: std::rc::Rc<std::cell::Cell<usize>>,
}
impl crate::GeometryProcessor for CountedAlignment {
    fn supported_types(&self) -> Vec<ifc_lite_core::IfcType> {
        vec![ifc_lite_core::IfcType::IfcAlignment]
    }
    fn lower_owned(&self, _: &ifc_lite_core::DecodedEntity, _: &mut EntityDecoder,
        _: crate::TessellationQuality, _: Option<(f64, f64, f64)>) -> Option<crate::Result<OwnedConstructor>> {
        self.lower.set(self.lower.get() + 1);
        None
    }
    fn process(&self, _: &ifc_lite_core::DecodedEntity, decoder: &mut EntityDecoder,
        _schema: &ifc_lite_core::IfcSchema, _quality: crate::TessellationQuality) -> crate::Result<crate::Mesh> {
        self.process.set(self.process.get() + 1);
        // The real extension repairs the late placement cache and delegates
        // geometry to the actual registered primitive implementation.
        let mut placement = nalgebra::Matrix4::identity();
        placement[(0, 3)] = 7.;
        decoder.cache_placement_transform(20, crate::math::mat4::col_major_array(&placement));
        let block = decoder.decode_by_id(10)?;
        // BlockProcessor::process is exactly this owned lower/evaluate route.
        // Calling the same-named trait method looks recursive to the walk audit.
        Ok(crate::processors::BlockProcessor::new().lower(&block, decoder)?.evaluate())
    }
}

#[test]
fn retained_alignment_refuses_before_callbacks_while_exact_keeps_real_extension_and_late_placement() {
    use std::{cell::Cell, rc::Rc};
    let source = "#1=IFCALIGNMENT('a',$,$,$,$,#20,#999,$,$);
#10=IFCBLOCK($,2.,3.,4.);#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);#22=IFCCARTESIANPOINT((0.,0.,0.));";
    let lower = Rc::new(Cell::new(0));
    let process = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(CountedAlignment { lower: lower.clone(), process: process.clone() }));
    let mut decoder = EntityDecoder::new(source);
    let mut retained = GeometryProgram::retained_parts(decoder.decode_by_id(1).unwrap(),
        RetainedContract { source_epoch: 1, source_revision: 1 });
    let reached = retained.request().unwrap().unwrap();
    assert_eq!(reached.stage(), ProgramStage::Source);
    assert_eq!(retained.admit_retained_with_inputs(reached, &router, &mut decoder, None, None).err(),
        Some(ProgramError::UnsupportedRetained));
    assert_eq!(lower.get(), 0, "retained refusal precedes even selected alignment lowering");
    assert_eq!(process.get(), 0, "no opaque sampled callback under retained contract");
    assert!(decoder.get_cached(10).is_none(), "no primitive source admitted");
    assert!(decoder.get_cached(20).is_none(), "no late placement read or callback repair");
    assert!(decoder.get_cached(999).is_none(), "unsupported prelude never falls through to Body");
    assert!(retained.finish_retained().is_err(), "refusal is not an empty completed retained plan");

    let mut decoder = EntityDecoder::new(source);
    let mut exact = GeometryProgram::parts(decoder.decode_by_id(1).unwrap());
    while let Some(request) = exact.request().unwrap() {
        let reply = exact.execute(request, &router, &mut decoder).unwrap();
        exact.accept(reply, &router).unwrap();
    }
    assert_eq!(lower.get(), 1);
    assert_eq!(process.get(), 1, "the same selected exact extension still executes once");
    let parts = exact.finish_parts().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].indices.len(), 36);
    assert!((crate::mesh_check::signed_volume(&parts[0]).abs() - 24.).abs() < 1e-6);
    let min_x = parts[0].positions.chunks_exact(3).map(|p| p[0]).fold(f32::INFINITY, f32::min);
    let max_x = parts[0].positions.chunks_exact(3).map(|p| p[0]).fold(f32::NEG_INFINITY, f32::max);
    assert_eq!((min_x, max_x), (7., 9.), "callback's real placement repair is consumed late");
    assert!(decoder.get_cached(999).is_none(), "successful dedicated alignment retains no Body fallback");
}
