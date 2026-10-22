// SPDX-License-Identifier: MPL-2.0
//! Owned opening source capture over actual selected processors and inline IFC.
use super::{classify, item_bounds, item_meshes};
use crate::processors::{BlockProcessor, TriangulatedFaceSetProcessor};
use crate::resource::{self, Cost, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use crate::{Error, GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use rustc_hash::FxHashMap;
use std::sync::Arc;
use std::{cell::Cell, rc::Rc};

const SOURCE: &str = "#10=IFCBLOCK($,2.,3.,4.);
#1=IFCWALL('first',$,$,$,$,$,#2,$);
#11=IFCWALL('later',$,$,$,$,$,#2,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#20=IFCOPENINGELEMENT('opening',$,$,$,$,$,#2,$);
#21=IFCOPENINGELEMENT('later-opening',$,$,$,$,$,#2,$);
#22=IFCOPENINGELEMENT('no-body',$,$,$,$,$,$,$);";

#[derive(Clone, Copy, PartialEq)]
enum Stop {
    /// Returns the typed stop as its result.
    Typed,
    /// Completes real geometry while the stop becomes sticky.
    Mesh,
    /// Records the stop, then reports an ordinary refusal.
    OrdinaryMiss,
    Panic,
}

/// The selected IfcBlock processor, counting each callback and stopping at one.
struct StoppingBlock {
    calls: Rc<Cell<usize>>,
    stop_at: Rc<Cell<usize>>,
    mode: Stop,
}
impl GeometryProcessor for StoppingBlock {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBlock]
    }
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
            Stop::Typed => Err(Error::ProgramStopped(ProgramStop::Cancelled)),
            Stop::Mesh => {
                let mesh = BlockProcessor::new().process(entity, decoder, schema, quality)?;
                resource::stop(ProgramStop::Cancelled);
                Ok(mesh)
            }
            Stop::OrdinaryMiss => {
                resource::stop(ProgramStop::Cancelled);
                Err(Error::geometry("ordinary processor refusal after cancellation"))
            }
            Stop::Panic => panic!("selected opening callback interrupted"),
        }
    }
}

fn router(mode: Stop, stop_at: usize) -> (GeometryRouter, Rc<Cell<usize>>, Rc<Cell<usize>>) {
    let calls = Rc::new(Cell::new(0));
    let stop_at = Rc::new(Cell::new(stop_at));
    let mut router = GeometryRouter::new();
    router.register(Box::new(StoppingBlock { calls: calls.clone(), stop_at: stop_at.clone(), mode }));
    (router, calls, stop_at)
}

fn account() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
}

fn classified(router: &GeometryRouter) -> usize {
    let counts = router.take_classification_stats();
    counts.rectangular + counts.diagonal + counts.non_rectangular
}

fn assert_cancelled<T>(result: Result<T>) {
    assert!(matches!(result, Err(Error::ProgramStopped(ProgramStop::Cancelled))));
}

#[test]
fn occurrences_use_selected_callbacks_and_quiet_mode_publishes_nothing() {
    let (router, calls, _) = router(Stop::Typed, usize::MAX);
    let mut decoder = EntityDecoder::new(SOURCE);
    let host = decoder.decode_by_id(1).unwrap();
    let recorded = classify(&host, &[20, 20], true, &router, &mut decoder).unwrap();
    assert_eq!(recorded.len(), 2, "repeated source ids remain two occurrences");
    assert_eq!(calls.get(), 6, "body, bounds and mesh each reach the selected processor");
    let quiet = classify(&host, &[20, 20], false, &router, &mut decoder).unwrap();
    assert_eq!(quiet.len(), 2);
    assert_eq!(calls.get(), 12, "quiet residual probes repeat callbacks, never memoize by id");
    assert_eq!(classified(&router), 2, "only the recording pass counts");
    let diagnostics = router.take_host_opening_diagnostics();
    assert_eq!(diagnostics.len(), 1);
    let openings = &diagnostics[&1].openings;
    assert_eq!(openings.iter().map(|o| o.opening_id).collect::<Vec<_>>(), [20, 20]);
    assert!(openings.iter().all(|o| o.vertex_count > 0));
}

#[test]
fn a_host_with_no_classified_opening_publishes_zero_telemetry() {
    let (router, calls, _) = router(Stop::Typed, usize::MAX);
    let mut decoder = EntityDecoder::new(SOURCE);
    let host = decoder.decode_by_id(1).unwrap();
    // An undecodable id, an opening without a body, and no ids at all.
    for ids in [&[999u32][..], &[22], &[]] {
        assert!(classify(&host, ids, true, &router, &mut decoder).unwrap().is_empty());
    }
    assert_eq!(calls.get(), 0);
    let counts = router.take_classification_stats();
    assert_eq!((counts.rectangular, counts.diagonal, counts.non_rectangular), (0, 0, 0));
    assert!(router.take_host_opening_diagnostics().is_empty(), "no empty host bucket");
}

#[test]
fn a_reached_stop_never_probes_or_retries_the_next_opening() {
    // Calls 1..=3 are the first occurrence's body, bounds and mesh children.
    for stop_at in 1..=3 {
        for mode in [Stop::Typed, Stop::Mesh, Stop::OrdinaryMiss] {
            let (router, calls, _) = router(mode, stop_at);
            let account = account();
            account.scope(|| {
                let mut decoder = EntityDecoder::new(SOURCE);
                let host = decoder.decode_by_id(1).unwrap();
                assert_cancelled(classify(&host, &[20, 21], true, &router, &mut decoder));
                assert_eq!(calls.get(), stop_at, "no fallback, retry or next opening");
                assert_eq!(classified(&router), 0);
                assert!(router.take_host_opening_diagnostics().is_empty());
                assert_eq!(resource::check_current(), Err(ProgramStop::Cancelled));
            });
            assert!(account.usage().work >= stop_at as u64, "reached callback work stays spent");
        }
    }
}

#[test]
fn a_later_stop_keeps_earlier_classification_and_publishes_no_host_diagnostic() {
    for mode in [Stop::Typed, Stop::Mesh, Stop::OrdinaryMiss] {
        // Opening 20 completes (calls 1..=3); 21 stops in its body.
        let (router, calls, _) = router(mode, 4);
        let account = account();
        account.scope(|| {
            let mut decoder = EntityDecoder::new(SOURCE);
            let host = decoder.decode_by_id(11).unwrap();
            assert_cancelled(classify(&host, &[20, 21], true, &router, &mut decoder));
            assert_eq!(calls.get(), 4);
            assert_eq!(classified(&router), 1, "the completed occurrence was published in order");
            assert!(router.take_host_opening_diagnostics().is_empty(), "an interrupted host is not");
        });
    }
}

#[test]
fn an_unwinding_probe_keeps_earlier_classification_and_publishes_no_host_diagnostic() {
    // Opening 20 completes; 21's bounds child (call 5) unwinds.
    let (router, calls, _) = router(Stop::Panic, 5);
    let mut decoder = EntityDecoder::new(SOURCE);
    let host = decoder.decode_by_id(11).unwrap();
    let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        classify(&host, &[20, 21], true, &router, &mut decoder)
    }));
    assert!(unwound.is_err());
    assert_eq!(calls.get(), 5);
    assert_eq!(classified(&router), 1);
    assert!(router.take_host_opening_diagnostics().is_empty());
}

#[test]
fn the_void_gateways_return_a_reached_classifier_stop() {
    for styled in [false, true] {
        // Call 1 is the host body; call 2 the opening body.
        let (router, calls, _) = router(Stop::Typed, 2);
        account().scope(|| {
            let mut decoder = EntityDecoder::new(SOURCE);
            let host = decoder.decode_by_id(1).unwrap();
            let voids: FxHashMap<u32, Vec<u32>> = [(1, vec![20])].into_iter().collect();
            if styled {
                assert_cancelled(router.process_element_with_submeshes_and_voids(&host, &mut decoder, &voids));
            } else {
                assert_cancelled(router.process_element_with_voids(&host, &mut decoder, &voids));
            }
            assert_eq!(calls.get(), 2);
            assert!(!router.host_consumed_by_void(1), "no cut ran over a partial context");
            assert_eq!(classified(&router), 0);
            assert!(router.take_host_opening_diagnostics().is_empty());
        });
    }
}

#[test]
fn requested_opening_id_survives_a_compatibility_cache_alias() {
    let router = GeometryRouter::new();
    let mut decoder = EntityDecoder::new(SOURCE);
    let actual = Arc::new(decoder.decode_by_id(21).unwrap());
    let cache: FxHashMap<_, _> = [(20, actual)].into_iter().collect();
    decoder.inject_shared_cache(&cache);
    let host = decoder.decode_by_id(1).unwrap();
    let voids = [(1, vec![20, 20])].into_iter().collect();
    let result = router.process_element_with_voids(&host, &mut decoder, &voids).unwrap();
    assert!(result.is_empty(), "the actual containing opening consumes the host");
    assert!(router.host_consumed_by_void(1));
    let diagnostics = router.take_host_opening_diagnostics();
    let openings = &diagnostics[&1].openings;
    assert_eq!(openings.iter().map(|entry| entry.opening_id).collect::<Vec<_>>(), [20, 20]);
    assert_eq!(decoder.decode_by_id(20).unwrap().id, 21, "attribution never rewrites the source");
}

#[test]
fn mesh_and_bounds_probes_place_the_same_parts() {
    let (router, _, _) = router(Stop::Typed, usize::MAX);
    let mut decoder = EntityDecoder::new(SOURCE);
    let opening = decoder.decode_by_id(20).unwrap();
    let meshes = item_meshes(&opening, &router, &mut decoder).unwrap();
    let bounds = item_bounds(&opening, &router, &mut decoder).unwrap();
    assert_eq!((meshes.len(), bounds.len()), (1, 1));
    let (min, max) = meshes[0].bounds();
    let (lo, hi, direction) = bounds[0];
    assert_eq!([lo.x, lo.y, lo.z], [min.x as f64, min.y as f64, min.z as f64]);
    assert_eq!([hi.x, hi.y, hi.z], [max.x as f64, max.y as f64, max.z as f64]);
    assert_eq!(direction, None, "a block has no authored extrusion direction");
    let no_body = decoder.decode_by_id(22).unwrap();
    assert!(item_meshes(&no_body, &router, &mut decoder).unwrap().is_empty());
    assert!(item_bounds(&no_body, &router, &mut decoder).unwrap().is_empty());
}

#[derive(Clone, Copy)]
enum RawReply {
    Typed,
    Mesh,
    Missing,
}
/// A raw-coordinate face set whose RTC-frame callback stops.
struct RawStop {
    calls: Rc<Cell<usize>>,
    ordinary: Rc<Cell<usize>>,
    reply: RawReply,
}
impl GeometryProcessor for RawStop {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcTriangulatedFaceSet]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        self.ordinary.set(self.ordinary.get() + 1);
        TriangulatedFaceSetProcessor::new().process(entity, decoder, schema, quality)
    }
    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
        rtc: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        self.calls.set(self.calls.get() + 1);
        match self.reply {
            RawReply::Typed => Some(Err(Error::ProgramStopped(ProgramStop::Cancelled))),
            RawReply::Mesh => {
                let mesh = TriangulatedFaceSetProcessor::new()
                    .process_in_rtc_frame(entity, decoder, schema, quality, rtc);
                resource::stop(ProgramStop::Cancelled);
                mesh
            }
            RawReply::Missing => {
                resource::stop(ProgramStop::Cancelled);
                None
            }
        }
    }
}

#[test]
fn a_raw_rtc_callback_stop_never_reaches_ordinary_recovery_or_the_next_item() {
    let source = "#1=IFCCARTESIANPOINTLIST3D(((5000000.,5000000.,0.),(5000001.,5000000.,0.),(5000000.,5000001.,0.)),$);
#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);
#3=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#2,#2));
#4=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#5=IFCOPENINGELEMENT('opening',$,$,$,$,$,#4,$);";
    for reply in [RawReply::Typed, RawReply::Mesh, RawReply::Missing] {
        let calls = Rc::new(Cell::new(0));
        let ordinary = Rc::new(Cell::new(0));
        let mut router = GeometryRouter::with_rtc((5_000_000., 5_000_000., 0.));
        router.register(Box::new(RawStop { calls: calls.clone(), ordinary: ordinary.clone(), reply }));
        account().scope(|| {
            let mut decoder = EntityDecoder::new(source);
            let opening = decoder.decode_by_id(5).unwrap();
            assert_cancelled(router.get_opening_item_meshes_world(&opening, &mut decoder));
            assert_eq!(calls.get(), 1, "only the first reached raw callback runs");
            assert_eq!(ordinary.get(), 0, "a sticky stop cannot select the ordinary callback");
        });
    }
}
