// SPDX-License-Identifier: MPL-2.0
//! A terminal RTC hook cannot request the legacy plain-processor fallback.
use crate::resource::{self, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use crate::{Error, GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::{cell::Cell, rc::Rc};

struct StoppingRtcHook {
    rtc_calls: Rc<Cell<usize>>,
    fallback_calls: Rc<Cell<usize>>,
}
impl GeometryProcessor for StoppingRtcHook {
    fn process(
        &self,
        _: &DecodedEntity,
        _: &mut EntityDecoder,
        _: &IfcSchema,
        _: TessellationQuality,
    ) -> Result<Mesh> {
        self.fallback_calls.set(self.fallback_calls.get() + 1);
        Ok(Mesh::new())
    }
    fn process_in_rtc_frame(
        &self,
        _: &DecodedEntity,
        _: &mut EntityDecoder,
        _: &IfcSchema,
        _: TessellationQuality,
        _: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        self.rtc_calls.set(self.rtc_calls.get() + 1);
        // The callback catches/suppresses its own terminal result by returning
        // None; the router still must not invoke a second producer afterward.
        resource::stop(ProgramStop::Cancelled);
        None
    }
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcTriangulatedFaceSet]
    }
}

#[test]
fn resource_rtc_hook_returning_none_after_stop_never_invokes_plain_fallback() {
    let source =
        "#1=IFCCARTESIANPOINTLIST3D(((5000000.,0.,0.),(5000001.,0.,0.),(5000000.,1.,0.)),$);\
        #2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);";
    let mut decoder = EntityDecoder::new(source);
    let item = decoder.decode_by_id(2).unwrap();
    for compatibility in [false, true] {
        let rtc_calls = Rc::new(Cell::new(0));
        let fallback_calls = Rc::new(Cell::new(0));
        let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
        router.set_rtc_offset((5_000_000., 0., 0.));
        router.register(Box::new(StoppingRtcHook {
            rtc_calls: Rc::clone(&rtc_calls),
            fallback_calls: Rc::clone(&fallback_calls),
        }));
        let policy = if compatibility {
            ExecutionPolicy::Compatibility
        } else {
            ExecutionPolicy::Bounded(ResourceLimits::default())
        };
        let account = ExecutionAccount::new(policy);
        let result = account.scope(|| router.process_representation_item(&item, &mut decoder));
        assert!(matches!(
            result,
            Err(Error::ProgramStopped(ProgramStop::Cancelled))
        ));
        assert_eq!(
            rtc_calls.get(),
            1,
            "the real georeferenced item must reach the RTC hook"
        );
        assert_eq!(
            fallback_calls.get(),
            0,
            "terminal None is not permission to retry plain geometry"
        );
    }
}

struct AlignmentFailure {
    typed: bool,
    calls: Rc<Cell<usize>>,
}
impl GeometryProcessor for AlignmentFailure {
    fn process(
        &self,
        _: &DecodedEntity,
        _: &mut EntityDecoder,
        _: &IfcSchema,
        _: TessellationQuality,
    ) -> Result<Mesh> {
        self.calls.set(self.calls.get() + 1);
        if self.typed {
            Err(Error::ProgramStopped(ProgramStop::Cancelled))
        } else {
            Err(Error::geometry("execution cancelled"))
        }
    }
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcAlignment]
    }
}

// Without the typed arm, try_alignment_mesh discards Cancelled and the public
// parts API succeeds with an empty mesh because this alignment has no ordinary
// representation. A source fault with the same text still takes that fallback.
#[test]
fn resource_alignment_typed_stop_bypasses_empty_representation_success() {
    let source = "#1=IFCALIGNMENT('0000000000000000000000',$,'Alignment',$,$,$,$,$,$);";
    for compatibility in [false, true] {
        for typed in [false, true] {
            let calls = Rc::new(Cell::new(0));
            let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
            router.register(Box::new(AlignmentFailure {
                typed,
                calls: Rc::clone(&calls),
            }));
            let mut decoder = EntityDecoder::new(source);
            let alignment = decoder.decode_by_id(1).unwrap();
            let policy = if compatibility {
                ExecutionPolicy::Compatibility
            } else {
                ExecutionPolicy::Bounded(ResourceLimits::default())
            };
            let account = ExecutionAccount::new(policy);
            let result = account.scope(|| router.process_element_parts(&alignment, &mut decoder));
            if typed {
                assert!(matches!(
                    result,
                    Err(Error::ProgramStopped(ProgramStop::Cancelled))
                ));
            } else {
                let parts =
                    result.expect("ordinary source failure retains representation fallback");
                assert_eq!(parts.len(), 1);
                assert!(parts[0].is_empty());
            }
            assert_eq!(calls.get(), 1);
        }
    }
}

// Round 2 port: lower_owned is the selected current-parent hook, so a stop
// there must precede both owned evaluation and the ordinary process fallback.
struct StoppingLowerHook { calls: Rc<Cell<usize>>, fallback: Rc<Cell<usize>>, owned: bool }
impl GeometryProcessor for StoppingLowerHook {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn lower_owned(&self, item: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: TessellationQuality, rtc: Option<(f64, f64, f64)>) -> Option<Result<crate::program::OwnedConstructor>> {
        self.calls.set(self.calls.get() + 1);
        let plan = if self.owned {
            crate::ExtrudedAreaSolidProcessor::new(IfcSchema::new())
                .lower_owned(item, decoder, quality, rtc)
        } else { None };
        if self.owned { assert!(plan.as_ref().is_some_and(|result| result.is_ok())); }
        resource::stop(ProgramStop::Cancelled);
        plan
    }
    fn process(&self, item: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> Result<Mesh> {
        self.fallback.set(self.fallback.get() + 1);
        crate::ExtrudedAreaSolidProcessor::new(schema.clone()).process(item, decoder, schema, quality)
    }
}
#[test]
fn resource_selected_lower_owned_stop_cannot_evaluate_or_fall_back() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
        #3=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);#4=IFCDIRECTION((0.,0.,1.));\
        #5=IFCEXTRUDEDAREASOLID(#3,#2,#4,3.);";
    for owned in [false, true] {
        let mut decoder = EntityDecoder::new(source);
        let item = decoder.decode_by_id(5).unwrap();
        let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
        let calls = Rc::new(Cell::new(0));
        let fallback = Rc::new(Cell::new(0));
        router.register(Box::new(StoppingLowerHook { calls: calls.clone(), fallback: fallback.clone(), owned }));
        let account = ExecutionAccount::new(ExecutionPolicy::Compatibility);
        let result = account.scope(|| router.process_representation_item(&item, &mut decoder));
        assert!(matches!(result, Err(Error::ProgramStopped(ProgramStop::Cancelled))));
        assert_eq!(calls.get(), 1);
        assert_eq!(fallback.get(), 0);
        assert!(router.geometry_hash_cache.borrow().is_empty(), "no stopped constructor cache publication");
    }
}
