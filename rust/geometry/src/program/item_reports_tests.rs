// SPDX-License-Identifier: MPL-2.0
//! The lexical execute-unwind guard consumes accepted source evidence once.
use super::*;
use crate::GeometryProcessor;

#[test]
fn execute_unwind_retains_actual_refused_face_source_without_duplicate_cancel_log() {
    let _=crate::processors::take_face_refused();
    let router=GeometryRouter::new();
    let mut decoder=EntityDecoder::new("#1=IFCADVANCEDBREP(#2);#2=IFCCLOSEDSHELL((#30));
#30=IFCADVANCEDFACE((),#31,.T.);
#31=IFCBSPLINESURFACEWITHKNOTS(1000000,1,((#999)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);");
    let mut source=ItemSource::new(decoder.decode_by_id(1).unwrap(),(0.,0.,0.));
    let mut ready=loop { match source.execute(&router,&mut decoder) {
        ItemStep::Source(next)=>source=next,
        ItemStep::Ready(ready)=>break ready,
        _=>panic!("actual refused advanced face lowers an owned constructor"),
    }};
    let executor_log=ready.detach_reports();
    // This is the lexical guard used by ReadyItem::execute, with the actual
    // admitted source log. Simulate its arithmetic scope unwinding; no panic
    // is translated into an ordinary geometry error.
    let unwind=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::processors::diagnostic_capture::capture(|| {
            let _guard=DetachedUnwindReports(ready.detached_reports.take());
            let mut numerical=EntityDecoder::new("#1=IFCADVANCEDBREP(#2);#2=IFCCLOSEDSHELL((#30));
#30=IFCFACESURFACE((),#31,.T.);
#31=IFCBSPLINESURFACEWITHKNOTS(1000000,1,((#999)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);");
            let entity=numerical.decode_by_id(1).unwrap();
            let mesh=crate::AdvancedBrepProcessor::new().process(&entity,&mut numerical,
                &ifc_lite_core::IfcSchema::new(),crate::TessellationQuality::Medium).unwrap();
            assert!(mesh.is_empty());
            panic!("arithmetic unwind invariant");
        });
    }));
    assert!(unwind.is_err());
    assert_eq!(crate::processors::take_face_refused(),[ifc_lite_core::IfcType::IfcAdvancedFace,
        ifc_lite_core::IfcType::IfcFaceSurface], "accepted source precedes reports from the unwinding operation");
    assert!(executor_log.take().face_refused.is_empty());
    drop(ready);
    assert!(crate::processors::take_face_refused().is_empty());
}
