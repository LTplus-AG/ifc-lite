// SPDX-License-Identifier: MPL-2.0
//! The host-opening control over inline IFC: its parametric and planar stages
//! read through the caller's lent host, router, decoder and account, so a stop
//! reached in any nested stage ends the whole gateway.
use super::context;
use crate::processors::BlockProcessor;
use crate::resource::{self, Cost, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use crate::{Error, GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use rustc_hash::FxHashMap;
use std::cell::Cell;
use std::rc::Rc;

/// A 10×1×3 extruded wall, one extruded through-cut (#20, planar) and one
/// block opening (#21, residual), plus a block-bodied product (#40).
const SOURCE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCDIRECTION((0.,0.,1.));
#5=IFCCARTESIANPOINT((0.,0.));
#6=IFCAXIS2PLACEMENT2D(#5,$);
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,#6,10.,1.);
#7=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);
#8=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7));
#9=IFCPRODUCTDEFINITIONSHAPE($,$,(#8));
#10=IFCWALL('host',$,$,$,$,$,#9,$);
#11=IFCRECTANGLEPROFILEDEF(.AREA.,$,#6,1.,0.4);
#12=IFCCARTESIANPOINT((0.,0.,-1.));
#13=IFCAXIS2PLACEMENT3D(#12,$,$);
#14=IFCEXTRUDEDAREASOLID(#11,#13,#3,5.);
#15=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#14));
#16=IFCPRODUCTDEFINITIONSHAPE($,$,(#15));
#20=IFCOPENINGELEMENT('through',$,$,$,$,$,#16,$);
#30=IFCCARTESIANPOINT((3.,-0.2,-1.));
#31=IFCAXIS2PLACEMENT3D(#30,$,$);
#32=IFCBLOCK(#31,1.,0.4,5.);
#33=IFCSHAPEREPRESENTATION($,'Body','CSG',(#32));
#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#21=IFCOPENINGELEMENT('block',$,$,$,$,$,#34,$);";

/// The selected IfcBlock processor, counting each callback and stopping at one.
struct StoppingBlock {
    calls: Rc<Cell<usize>>,
    stop_at: usize,
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
        resource::charge(Cost {
            work: 1,
            ..Cost::default()
        })?
        .retain();
        if call == self.stop_at {
            return Err(Error::ProgramStopped(ProgramStop::Cancelled));
        }
        BlockProcessor::new().process(entity, decoder, schema, quality)
    }
}

fn router(stop_at: usize) -> (GeometryRouter, Rc<Cell<usize>>) {
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(StoppingBlock {
        calls: calls.clone(),
        stop_at,
    }));
    (router, calls)
}

fn classified(router: &GeometryRouter) -> usize {
    let counts = router.take_classification_stats();
    counts.rectangular + counts.diagonal + counts.non_rectangular
}

#[test]
fn the_host_control_captures_planar_and_parametric_data_once() {
    let (router, calls) = router(usize::MAX);
    let mut decoder = EntityDecoder::new(SOURCE);
    let host = decoder.decode_by_id(10).unwrap();
    let mixed = context(&host, &[20, 21], &router, &mut decoder).unwrap();
    assert_eq!((mixed.openings.len(), mixed.merged_openings.len()), (2, 2));
    assert!(
        mixed.param.is_none(),
        "a block opening has no exact extrusion box"
    );
    let cut = mixed.bool2d.expect("the through extrusion is planar");
    assert_eq!(cut.footprints.len(), 1);
    assert_eq!(
        cut.residual.expect("the block is residual").openings.len(),
        1
    );
    assert_eq!(
        calls.get(),
        6,
        "the block's body, bounds and mesh in each classification pass"
    );
    assert_eq!(classified(&router), 2, "only the recording pass counts");

    let through = context(&host, &[20], &router, &mut decoder).unwrap();
    let param = through
        .param
        .expect("rectangular host and through-box share one frame");
    assert_eq!(param.openings.len(), 1);
    let planar = through
        .bool2d
        .expect("planar capture is independent of the parametric one");
    assert!(planar.residual.is_none());
    assert_eq!(
        calls.get(),
        6,
        "no block callback for an all-extrusion host"
    );
}

#[test]
fn a_stop_in_any_nested_stage_ends_the_whole_gateway() {
    // Calls 1..=3 are the recording classifier's block occurrence; 4..=6 are
    // the planar stage's QUIET residual classifier, a nested child control.
    for stop_at in 1..=6 {
        let (router, calls) = router(stop_at);
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        account.scope(|| {
            let mut decoder = EntityDecoder::new(SOURCE);
            let host = decoder.decode_by_id(10).unwrap();
            let voids: FxHashMap<u32, Vec<u32>> = [(10, vec![20, 21])].into_iter().collect();
            let result = router.process_element_with_voids(&host, &mut decoder, &voids);
            assert!(matches!(
                result,
                Err(Error::ProgramStopped(ProgramStop::Cancelled))
            ));
            assert_eq!(calls.get(), stop_at, "no retry, fallback or later opening");
            assert_eq!(resource::check_current(), Err(ProgramStop::Cancelled));
        });
        assert!(
            !router.host_consumed_by_void(10),
            "no cut ran over a partial context"
        );
        let parent_done = stop_at > 3;
        // The completed extrusion occurrence counts in order either way.
        assert_eq!(classified(&router), if parent_done { 2 } else { 1 });
        let diagnostics = router.take_host_opening_diagnostics();
        assert_eq!(diagnostics.len(), usize::from(parent_done));
        if let Some(host) = diagnostics.get(&10) {
            assert_eq!(
                host.openings.len(),
                2,
                "the residual pass published nothing"
            );
            assert_eq!(
                host.tris_after, None,
                "no cut effect over a stopped context"
            );
        }
        assert!(router.take_csg_failures().is_empty());
        assert!(
            account.usage().work >= stop_at as u64,
            "reached callback work stays spent"
        );
    }
}
