// SPDX-License-Identifier: MPL-2.0
//! Terminal-port regressions: actual selected processors and inline IFC geometry.
use super::{Classifier, HostOpenings};
use crate::processors::BlockProcessor;
use crate::resource::{self, Cost, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use crate::{Error, GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use rustc_hash::FxHashMap;
use std::{cell::Cell, rc::Rc, sync::Arc};

#[derive(Clone, Copy)]
enum StopReturn { Typed, Mesh, OrdinaryMiss }
struct StoppingBlock {
    calls: Rc<Cell<usize>>,
    stop_at: Rc<Cell<usize>>,
    mode: StopReturn,
}
impl GeometryProcessor for StoppingBlock {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        let call = self.calls.get() + 1;
        self.calls.set(call);
        resource::charge(Cost { work: 1, ..Cost::default() })?.retain();
        if call != self.stop_at.get() {
            return BlockProcessor::new().process(entity, decoder, schema, quality);
        }
        match self.mode {
            StopReturn::Typed => Err(Error::ProgramStopped(ProgramStop::Cancelled)),
            StopReturn::Mesh => {
                // Real geometry can complete while the authoritative stop becomes sticky.
                let mesh = BlockProcessor::new().process(entity, decoder, schema, quality)?;
                resource::stop(ProgramStop::Cancelled);
                Ok(mesh)
            }
            StopReturn::OrdinaryMiss => {
                resource::stop(ProgramStop::Cancelled);
                Err(Error::geometry("ordinary processor refusal after cancellation"))
            }
        }
    }
}
fn source() -> &'static str {
    "#10=IFCBLOCK($,2.,3.,4.);
#1=IFCWALL('first',$,$,$,$,$,#2,$);
#11=IFCWALL('later',$,$,$,$,$,#2,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#20=IFCOPENINGELEMENT('opening',$,$,$,$,$,#2,$);
#21=IFCOPENINGELEMENT('later-opening',$,$,$,$,$,#2,$);
#30=IFCCARTESIANPOINT((0.,0.,0.));
#31=IFCAXIS2PLACEMENT3D(#30,$,$);
#32=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#33=IFCREPRESENTATIONMAP(#31,#32);
#34=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#30,1.,$);
#35=IFCMAPPEDITEM(#33,#34);"
}
fn router(mode: StopReturn, stop_at: usize) -> (GeometryRouter, Rc<Cell<usize>>, Rc<Cell<usize>>) {
    let calls = Rc::new(Cell::new(0));
    let stop_at = Rc::new(Cell::new(stop_at));
    let mut router = GeometryRouter::new();
    router.register(Box::new(StoppingBlock {
        calls: calls.clone(), stop_at: stop_at.clone(), mode,
    }));
    (router, calls, stop_at)
}
fn account() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
}
fn assert_cancelled<T>(result: Result<T>) {
    assert!(matches!(result, Err(Error::ProgramStopped(ProgramStop::Cancelled))));
}

#[test]
fn terminal_port_selected_source_stop_never_probes_or_retries_the_next_opening() {
    for stop_at in 1..=3 {
        for mode in [StopReturn::Typed, StopReturn::Mesh, StopReturn::OrdinaryMiss] {
            let (router, calls, _) = router(mode, stop_at);
            let account = account();
            account.scope(|| {
                let mut decoder = EntityDecoder::new(source());
                let host = decoder.decode_by_id(1).unwrap();
                assert_cancelled(HostOpenings::new(&host, &[20, 21]).run(&router, &mut decoder));
                assert_eq!(calls.get(), stop_at, "no ordinary/raw/bounds fallback or next opening");
                let counts = router.take_classification_stats();
                assert_eq!(counts.rectangular + counts.diagonal + counts.non_rectangular, 0);
                assert!(router.take_host_opening_diagnostics().is_empty());
                assert!(!router.host_consumed_by_void(1));
                assert_eq!(resource::check_current(), Err(ProgramStop::Cancelled));
            });
            assert!(account.usage().work >= stop_at as u64, "actual callback work remains spent");
        }
    }
}

#[test]
fn terminal_port_later_occurrence_preserves_completed_host_and_prior_classification() {
    let cache = GeometryRouter::new_mapped_item_cache();
    let mut router = GeometryRouter::new();
    router.enable_shared_mapped_item_cache(cache.clone());
    // Warm the canonical cache with actual authored mapped geometry, outside
    // a bounded account and before installing the custom source processor.
    let mut warm_decoder = EntityDecoder::new(source());
    let mapped = warm_decoder.decode_by_id(35).unwrap();
    let mesh = router.process_representation_item(&mapped, &mut warm_decoder).unwrap();
    assert!((crate::mesh_check::signed_volume(&mesh).abs() - 24.).abs() < 1e-6);
    let cached = cache.lock().unwrap().get(&33).unwrap().clone();
    let vertices = cached.positions.clone();
    let indices = cached.indices.clone();
    let calls = Rc::new(Cell::new(0));
    let stop_at = Rc::new(Cell::new(usize::MAX));
    router.register(Box::new(StoppingBlock {
        calls: calls.clone(), stop_at: stop_at.clone(), mode: StopReturn::Typed,
    }));
    let account = account();
    account.scope(|| {
        let mut decoder = EntityDecoder::new(source());
        let first = decoder.decode_by_id(1).unwrap();
        let cuts: FxHashMap<u32, Vec<u32>> = [(1, vec![20])].into_iter().collect();
        let completed = router.process_element_with_voids(&first, &mut decoder, &cuts).unwrap();
        assert!(completed.is_empty(), "the real containing box cutter consumed the host");
        assert!(router.host_consumed_by_void(1));
        let before = calls.get();
        // One completed occurrence reaches body, bounds, item meshes. The next
        // occurrence stops in its body, before any second probe or publication.
        stop_at.set(before + 4);
        let later = decoder.decode_by_id(11).unwrap();
        assert_cancelled(Classifier::new(&later, &[20, 21], true).run(&router, &mut decoder));
        assert_eq!(calls.get(), before + 4);
        let counts = router.take_classification_stats();
        assert_eq!(counts.rectangular + counts.diagonal + counts.non_rectangular, 2);
        let diagnostics = router.take_host_opening_diagnostics();
        assert_eq!(diagnostics[&1].openings.len(), 1);
        assert!(!diagnostics.contains_key(&11), "an interrupted host is not completed");
        assert!(router.host_consumed_by_void(1));
        assert!(!router.host_consumed_by_void(11));
        let retained = cache.lock().unwrap().get(&33).unwrap().clone();
        assert!(Arc::ptr_eq(&cached, &retained), "completed mapped source is not replaced or drained");
        assert_eq!(retained.positions, vertices);
        assert_eq!(retained.indices, indices);
        let spent = account.usage().work;
        assert!(spent >= calls.get() as u64);
        assert_cancelled(HostOpenings::new(&later, &[20]).run(&router, &mut decoder));
        assert_eq!(calls.get(), before + 4, "terminal entry cannot replay source");
        assert_eq!(account.usage().work, spent, "no refund and no retry charge");
    });
}
