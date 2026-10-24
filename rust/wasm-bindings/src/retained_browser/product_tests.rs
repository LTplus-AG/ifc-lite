// SPDX-License-Identifier: MPL-2.0
//! #7955 J4b: the source-backed common controller consumes actual Worker dependencies.
use super::{BrowserCancellation, BrowserWorker};
use super::receipt::BrowserReceipt;
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{ElementJobKind, ElementMeshJob, MeshProductionOptions,
    ProductionModel, RetainedExecutionError, RuntimeProductExecution, runtime::{
        AsyncRetainedExecutor, Invocation, NumericalLimits, RetainedRuntime,
    }};
use wasm_bindgen_test::*;

// Authored 2 x 4 x 3 metre host, cut by a twice-scaled 2 x 4 x 1 cutter.
// The cutter spans the host's XY footprint and removes 2 m of its height:
// exactly 8 m3 remain. Ignoring the mapping scale would leave 16 m3.
const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCAXIS2PLACEMENT3D(#8,$,$);#8=IFCCARTESIANPOINT((10.,20.,30.));
#9=IFCLOCALPLACEMENT($,#7);#10=IFCWALL('w',$,'Wall',$,$,#9,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));#12=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#13));
#13=IFCBOOLEANRESULT(.DIFFERENCE.,#113,#213);
#113=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#15=IFCDIRECTION((0.,0.,1.));
#213=IFCBOOLEANRESULT(.UNION.,#314,#115);
#114=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);#115=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5);
#314=IFCMAPPEDITEM(#315,#316);#315=IFCREPRESENTATIONMAP(#5,#317);
#316=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,2.,$);
#317=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#114));
ENDSEC;END-ISO-10303-21;";

// Observe actual numerical geometry before the unchanged receipt goes through
// common sealing/acceptance. No callback supplies geometry or receipt authority.
struct Observed {
    worker: BrowserWorker,
    boolean_volumes: Vec<f64>,
}
impl RetainedRuntime for Observed {
    type Receipt = BrowserReceipt;
    fn domain(&self) -> BrowserCancellation { self.worker.cancellation() }
    fn incarnation(&self) -> u64 { self.worker.incarnation() }
}
impl AsyncRetainedExecutor for Observed {
    async fn invoke(&mut self, call: Invocation<'_, Self::Receipt>, limits: NumericalLimits, resources: &ifc_lite_geometry::resource::OwnedResourceContext)
        -> Result<Self::Receipt, RetainedExecutionError> {
        let receipt = self.worker.invoke(call, limits, resources).await?;
        if let BrowserReceipt::Boolean(result) = &receipt {
            self.boolean_volumes.push(volume(&result.mesh));
        }
        Ok(receipt)
    }
}
pub(super) fn volume(mesh: &super::bridge::Mesh) -> f64 {
    let p = |i: u32| { let i = i as usize * 3; [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]] };
    mesh.indices.chunks_exact(3).map(|t| {
        let [a, b, c] = [p(t[0]), p(t[1]), p(t[2])];
        (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.
    }).sum::<f64>().abs()
}

#[wasm_bindgen_test(async)]
async fn retained_browser_common_controller_maps_boolean_operands_and_reuses_semantic_empty() {
    for empty_reuse in [false, true] {
        let text = if empty_reuse {
            SOURCE.replace("#13=IFCBOOLEANRESULT(.DIFFERENCE.,#113,#213)",
                "#13=IFCBOOLEANRESULT(.UNION.,#213,#113)")
                .replace("#213=IFCBOOLEANRESULT(.UNION.,#314,#115)",
                    "#213=IFCBOOLEANRESULT(.DIFFERENCE.,#114,#114)")
        } else { SOURCE.to_owned() };
        let source = SourceBundle::new(text.into_bytes());
        let mut decoder = source.decoder().with_strict_reals();
        let router = GeometryRouter::with_units(source.bytes(), &mut decoder);
        let model = ProductionModel::from_source(source.clone());
        let context = model.snapshot(Default::default());
        let entity = decoder.decode_by_id(10).unwrap();
        let job = ElementMeshJob { id: entity.id, ifc_type: entity.ifc_type.clone(), entity: &entity,
            kind: ElementJobKind::Product, element_color: None, metadata: None };
        let mut observed = Observed { worker: BrowserWorker::new().unwrap(), boolean_volumes: Vec::new() };
        observed.worker.qualify_dependencies().await.unwrap();
        let mut execution = RuntimeProductExecution::<BrowserReceipt>::begin(&job, &context,
            &MeshProductionOptions::default(), &mut decoder, &router).unwrap();
        let limits = NumericalLimits { chord_metres: 0.001, angle_degrees: 5., max_bytes: 16 << 20 };
        while let Some(issued) = execution.issue_next(&mut decoder, &router, &observed).unwrap() {
            let completed = issued.execute_async(&mut observed, limits).await.unwrap();
            execution.accept(completed, &mut decoder, &router).unwrap_or_else(|rejected| panic!("{}", rejected.reason));
        }
        let witness = execution.into_witness().unwrap();
        witness.validate().unwrap();
        assert_eq!(witness.plan().values.len(), 1);
        assert_eq!(witness.plan().values[0].evaluated_empty(), Some(false));
        assert_eq!(observed.boolean_volumes.len(), 2);
        let expected = if empty_reuse { [0., 24.] } else { [64., 8.] };
        for (actual, expected) in observed.boolean_volumes.iter().zip(expected) {
            assert!((actual - expected).abs() <= 1e-7, "source-derived volume {actual} != {expected}");
        }
        assert!(!witness.plan().remaining.is_empty(), "intermediate witness cannot qualify final product publication");
        model.invalidate_source();
        assert!(witness.validate().is_err(), "source invalidation expires the composed transaction");
        observed.worker.retire();
        assert_eq!(observed.worker.cancellation().incarnation(), None);
    }
}
