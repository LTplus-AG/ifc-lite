// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7914: execution stops suppress output without becoming malformed geometry.
use super::SymbolicAccumulator;
use crate::symbolic::extract_symbolic_data_with_provenance_in_frame;
use ifc_lite_geometry::resource::{self, Cost, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use std::cell::RefCell;

#[derive(Clone, Copy)]
enum StopKind { Cancelled, Refused }

fn trigger(kind: StopKind) -> ProgramStop {
    match kind {
        StopKind::Cancelled => resource::stop(ProgramStop::Cancelled),
        StopKind::Refused => resource::charge(Cost { work: 1, ..Cost::default() }).unwrap_err(),
    }
}

#[derive(Default)]
struct Observer {
    stop_at: Option<u32>,
    kind: Option<StopKind>,
    seen: Vec<u32>,
    staged_at_stop: usize,
    stop: Option<ProgramStop>,
}
thread_local! { static OBSERVER: RefCell<Option<Observer>> = const { RefCell::new(None) }; }

// The real scanner calls this only in test builds. Counting visits separately
// from output proves that terminal handling stops work, not merely emission.
pub(in crate::symbolic) fn on_entity(id: u32, out: &SymbolicAccumulator) {
    if !(501..=503).contains(&id) { return; }
    OBSERVER.with(|slot| {
        if let Some(observer) = slot.borrow_mut().as_mut() {
            observer.seen.push(id);
            if observer.stop_at == Some(id) {
                observer.staged_at_stop = out.len();
                observer.stop = Some(trigger(observer.kind.unwrap()));
            }
        }
    });
}

fn observe<T>(stop_at: Option<u32>, kind: StopKind, run: impl FnOnce() -> T) -> (T, Observer) {
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) { OBSERVER.with(|slot| { slot.borrow_mut().take(); }); }
    }
    OBSERVER.with(|slot| {
        assert!(slot.borrow().is_none());
        *slot.borrow_mut() = Some(Observer { stop_at, kind: Some(kind), ..Observer::default() });
    });
    let _restore = Restore;
    let result = run();
    let observer = OBSERVER.with(|slot| slot.borrow_mut().take().unwrap());
    (result, observer)
}

fn account() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work: Some(0), ..ResourceLimits::default()
    }))
}

// Actual IFC4X3 sampled placements, with ordinary products before and after.
// All products carry a polyline and a directly attributable fill.
fn fixture(grid: bool) -> String {
    let sampled = if grid { "#30=IFCCARTESIANPOINT((0.,0.));
#31=IFCCARTESIANPOINT((10.,0.));#32=IFCPOLYLINE((#30,#31));
#33=IFCGRIDAXIS('U',#32,.T.);#34=IFCCARTESIANPOINT((0.,10.));
#35=IFCPOLYLINE((#30,#34));#36=IFCGRIDAXIS('V',#35,.T.);
#37=IFCVIRTUALGRIDINTERSECTION((#33,#36),(0.,0.));
#10=IFCGRIDPLACEMENT($,#37,$);" } else { "#30=IFCCARTESIANPOINT((0.,0.,0.));
#31=IFCCARTESIANPOINT((10.,0.,0.));#32=IFCPOLYLINE((#30,#31));
#33=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(5.),$,$,$,#32);
#34=IFCAXIS2PLACEMENTLINEAR(#33,$,$);#10=IFCLINEARPLACEMENT($,#34,$);" };
    format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;
#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmQ',$,'P',$,$,$,$,(#100),#7);
#7=IFCUNITASSIGNMENT((#8));#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
{sampled}
#60=IFCLOCALPLACEMENT($,#61);#61=IFCAXIS2PLACEMENT3D(#63,$,$);
#63=IFCCARTESIANPOINT((10.,0.,0.));
#62=IFCLOCALPLACEMENT($,#64);#64=IFCAXIS2PLACEMENT3D(#65,$,$);
#65=IFCCARTESIANPOINT((20.,0.,0.));
#70=IFCPOLYLINE((#80,#81,#82,#80));#71=IFCANNOTATIONFILLAREA(#70,$);
#80=IFCCARTESIANPOINT((0.,0.));#81=IFCCARTESIANPOINT((1.,0.));
#82=IFCCARTESIANPOINT((0.,1.));
#100=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#101,$);
#101=IFCAXIS2PLACEMENT3D(#102,$,$);#102=IFCCARTESIANPOINT((0.,0.,0.));
#220=IFCSHAPEREPRESENTATION(#100,'Plan','GeometricCurveSet',(#70,#71));
#221=IFCPRODUCTDEFINITIONSHAPE($,$,(#220));
#501=IFCANNOTATION('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Before',$,$,#60,#221);
#502=IFCANNOTATION('0M7tQ9Jbj1BAeHd7rqnDmS',$,'Sampled',$,$,#10,#221);
#503=IFCANNOTATION('0M7tQ9Jbj1BAeHd7rqnDmT',$,'After',$,$,#62,#221);
ENDSEC;\nEND-ISO-10303-21;\n")
}

#[test]
fn issue_7914_stopped_public_extraction_never_scans_or_emits() {
    for grid in [false, true] {
        let source = fixture(grid);
        let positive = extract_symbolic_data_with_provenance_in_frame(&source, crate::MeshFrame::RawIfc).unwrap();
        assert_eq!(positive.data().polylines.len(), 3);
        assert_eq!(positive.data().fills.len(), 3);
        assert_eq!(positive.fill_items(), &[Some(71); 3]);
        let expected = [10.0, if grid { 0.0 } else { 5.0 }, 20.0];
        for (line, x) in positive.data().polylines.iter().zip(expected) {
            assert_eq!(line.points[0], x);
        }
        for kind in [StopKind::Cancelled, StopKind::Refused] {
            let account = account();
            let stop = account.scope(|| trigger(kind));
            let (data, observer) = observe(None, kind, || account.scope(|| {
                let data = extract_symbolic_data_with_provenance_in_frame(&source, crate::MeshFrame::RawIfc);
                assert_eq!(resource::check_current(), Err(stop));
                data
            }));
            assert!(observer.seen.is_empty());
            assert_eq!(data.unwrap_err(), stop, "a stop must not look like empty success");
            assert_eq!(account.check(), Err(stop));
        }
    }
}

#[test]
fn issue_7914_mid_scan_stop_discards_prefix_and_provenance_and_stops_visits() {
    for grid in [false, true] {
        for kind in [StopKind::Cancelled, StopKind::Refused] {
            let account = account();
            let (data, observer) = observe(Some(502), kind, || account.scope(|| {
                extract_symbolic_data_with_provenance_in_frame(&fixture(grid), crate::MeshFrame::RawIfc)
            }));
            assert_eq!(observer.seen, [501, 502], "the later product must not be visited");
            assert_eq!(observer.staged_at_stop, 2, "a real prefix must have been emitted first");
            assert_eq!(data.unwrap_err(), observer.stop.unwrap());
            assert_eq!(account.check(), Err(observer.stop.unwrap()));
        }
    }
}

#[test]
fn issue_7914_append_admission_and_final_discard_are_independent() {
    let positive = extract_symbolic_data_with_provenance_in_frame(&fixture(false), crate::MeshFrame::RawIfc).unwrap();
    for kind in [StopKind::Cancelled, StopKind::Refused] {
        let account = account();
        account.scope(|| {
            let mut out = SymbolicAccumulator::new();
            out.push_polyline(positive.data().polylines[0].clone());
            out.push_fill_with_provenance(positive.data().fills[0].clone(), Some(71));
            assert_eq!(out.len(), 2);
            let stop = trigger(kind);
            out.push_polyline(positive.data().polylines[0].clone());
            out.push_fill_with_provenance(positive.data().fills[0].clone(), Some(71));
            assert_eq!(out.len(), 2, "append admission must reject after the stop");
            let final_data = out.into_provenance();
            assert_eq!(final_data.unwrap_err(), stop, "no staged prefix may escape as success");
            assert_eq!(resource::check_current(), Err(stop));
        });
    }
}

#[test]
fn issue_7914_sampled_placement_stop_never_becomes_an_origin_frame() {
    for grid in [false, true] {
        for kind in [StopKind::Cancelled, StopKind::Refused] {
            let source = fixture(grid);
            let mut decoder = ifc_lite_core::EntityDecoder::new(&source);
            let product = decoder.decode_by_id(502).unwrap();
            let account = account();
            account.scope(|| {
                let stop = trigger(kind);
                let frame = crate::symbolic::transform::resolve_object_placement(&product, &mut decoder, 1.0);
                assert!(frame.tx.is_nan() && frame.ty.is_nan(), "a stopped frame cannot draw at origin");
                assert_eq!(resource::check_current(), Err(stop));
            });
            assert_eq!(decoder.refused_records(), 0, "execution is not malformed source");
            assert!(decoder.get_placement_transform_cached(10).is_none());
            let fresh = extract_symbolic_data_with_provenance_in_frame(&source, crate::MeshFrame::RawIfc).unwrap();
            assert_eq!(fresh.data().polylines.len(), 3, "fresh execution must remain valid");
        }
    }
}

#[test]
fn issue_7914_unscoped_cancellation_is_reported_and_does_not_leak() {
    assert!(!resource::is_active());
    for grid in [false, true] {
        let source = fixture(grid);
        let (result, observer) = observe(Some(502), StopKind::Cancelled, || {
            extract_symbolic_data_with_provenance_in_frame(&source, crate::MeshFrame::RawIfc)
        });
        assert_eq!(result.unwrap_err(), ProgramStop::Cancelled);
        assert_eq!(observer.seen, [501, 502]);
        assert_eq!(observer.staged_at_stop, 2);
        assert_eq!(resource::check_current(), Ok(()), "fresh domain must be restored");
        let fresh = extract_symbolic_data_with_provenance_in_frame(&source, crate::MeshFrame::RawIfc).unwrap();
        assert_eq!(fresh.data().polylines.len(), 3);
        assert_eq!(fresh.fill_items(), &[Some(71); 3]);
    }
    let empty = crate::symbolic::extract_symbolic_data(b"ISO-10303-21;HEADER;ENDSEC;DATA;ENDSEC;END-ISO-10303-21;").unwrap();
    assert!(empty.is_empty(), "a genuine no-symbol source remains successful");
}
