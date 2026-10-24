// SPDX-License-Identifier: MPL-2.0
//! #7955 source-backed controller consumes actual module-Worker source receipts.
use super::receipt::BrowserReceipt;
use super::{BrowserCancellation, BrowserWorker};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{document::retained_source::ConstructionRole, GeometryRouter};
use ifc_lite_processing::element::{
    runtime::{
        AsyncRetainedExecutor, Invocation, NumericalLimits, NumericalReceipt, RetainedRuntime,
    },
    ElementJobKind, ElementMeshJob, MeshProductionOptions, ProductionModel, RetainedExecutionError,
    RuntimeProductExecution,
};
use wasm_bindgen_test::*;
const SOURCE:&str="ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCLOCALPLACEMENT($,#5);#10=IFCWALL('w',$,'Wall',$,$,#9,#11,$,$);#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#13));#13=IFCMAPPEDITEM(#81,#82);
#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);#15=IFCDIRECTION((0.,0.,1.));
#113=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);#114=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);
#81=IFCREPRESENTATIONMAP(#5,#83);#82=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,2.,$,3.,0.5);
#83=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113,#114));#84=IFCCARTESIANPOINT((2.,4.,6.));ENDSEC;END-ISO-10303-21;";
struct Observed {
    worker: BrowserWorker,
    constructions: usize,
    affines: usize,
    ids: std::collections::BTreeSet<u32>,
}
impl RetainedRuntime for Observed {
    type Receipt = BrowserReceipt;
    fn source_face_binding(&self) -> bool {
        true
    }
    fn domain(&self) -> BrowserCancellation {
        self.worker.cancellation()
    }
    fn incarnation(&self) -> u64 {
        self.worker.incarnation()
    }
}
impl AsyncRetainedExecutor for Observed {
    async fn invoke(
        &mut self,
        call: Invocation<'_, Self::Receipt>,
        limits: NumericalLimits,
        resources: &ifc_lite_geometry::resource::OwnedResourceContext,
    ) -> Result<Self::Receipt, RetainedExecutionError> {
        let receipt = self.worker.invoke(call, limits, resources).await?;
        let proof = receipt
            .source_correspondence()
            .expect("actual Worker consumed source correspondence");
        self.ids.insert(proof.request().recipe().solid_id());
        assert_eq!(proof.roles().len(), 6);
        let (positions, indices, transform) = match &receipt {
            BrowserReceipt::Construction(value) => {
                self.constructions += 1;
                let mesh = &value.completion().tessellation;
                (&mesh.positions, &mesh.indices, None)
            }
            BrowserReceipt::Affine(value) => {
                self.affines += 1;
                let mesh = value
                    .source_mesh
                    .as_ref()
                    .expect("actual affine Worker mesh");
                (&mesh.positions, &mesh.indices, Some(value.column_major))
            }
            _ => panic!("unexpected source fixture operation"),
        };
        let recipe = &proof.request().payload().bytes;
        let scalar = |offset| f64::from_le_bytes(recipe[offset..offset + 8].try_into().unwrap());
        assert_eq!(proof.triangle_roots().len(), indices.len() / 3);
        for (triangle, &root) in indices.chunks_exact(3).zip(proof.triangle_roots()) {
            for &vertex in triangle {
                let mut p = [
                    positions[vertex as usize * 3],
                    positions[vertex as usize * 3 + 1],
                    positions[vertex as usize * 3 + 2],
                ];
                if let Some(matrix) = transform {
                    // These source fixtures deliberately use diagonal scales,
                    // reflection and translation; invert that authored map.
                    for i in [1, 2, 4, 6, 8, 9] {
                        assert_eq!(matrix[i], 0.);
                    }
                    for axis in 0..3 {
                        p[axis] = (p[axis] - matrix[12 + axis]) / matrix[axis * 5];
                    }
                }
                let residual = match proof.roles()[root as usize] {
                    ConstructionRole::StartCap => p[2],
                    ConstructionRole::EndCap => p[2] - scalar(40),
                    ConstructionRole::SweptSegment(n) => {
                        let at = 64 + n as usize * 104;
                        let ax = scalar(at);
                        let ay = scalar(at + 8);
                        let bx = scalar(at + 24);
                        let by = scalar(at + 32);
                        ((p[0] - ax) * (by - ay) - (p[1] - ay) * (bx - ax))
                            / (bx - ax).hypot(by - ay)
                    }
                };
                assert!(
                    residual.abs() <= 1e-9,
                    "actual Worker triangle matches its original construction feature"
                );
            }
        }
        Ok(receipt)
    }
}
async fn consume_source(source: &str) {
    let source = SourceBundle::new(source.as_bytes().to_vec());
    let mut decoder = source.decoder().with_strict_reals();
    let router = GeometryRouter::with_units(source.bytes(), &mut decoder);
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let job = ElementMeshJob {
        id: entity.id,
        ifc_type: entity.ifc_type.clone(),
        entity: &entity,
        kind: ElementJobKind::Product,
        element_color: None,
        metadata: None,
    };
    let mut observed = Observed {
        worker: BrowserWorker::new().unwrap(),
        constructions: 0,
        affines: 0,
        ids: Default::default(),
    };
    observed.worker.require_source_faces();
    observed.worker.qualify_dependencies().await.unwrap();
    let mut execution = RuntimeProductExecution::<BrowserReceipt>::begin(
        &job,
        &context,
        &MeshProductionOptions::default(),
        &mut decoder,
        &router,
    )
    .unwrap();
    let limits = NumericalLimits {
        chord_metres: 0.001,
        angle_degrees: 5.,
        max_bytes: 16 << 20,
    };
    while let Some(issued) = execution
        .issue_next(&mut decoder, &router, &observed)
        .unwrap()
    {
        let receipt = issued.execute_async(&mut observed, limits).await.unwrap();
        execution
            .accept(receipt, &mut decoder, &router)
            .unwrap_or_else(|e| panic!("{}", e.reason));
    }
    assert_eq!(observed.constructions, 2);
    assert_eq!(observed.affines, 2);
    assert_eq!(observed.ids, std::collections::BTreeSet::from([113, 114]));
    let witness = execution.into_witness().unwrap();
    witness.validate().unwrap();
    model.invalidate_source();
    assert!(
        witness.validate().is_err(),
        "expired owned source cannot retain source-face authority"
    );
    observed.worker.retire();
    assert!(witness.validate().is_err());
}

#[wasm_bindgen_test(async)]
async fn retained_browser_j5_owned_source_binding_is_consumed_for_two_mapped_sources() {
    consume_source(SOURCE).await;
}
#[wasm_bindgen_test(async)]
async fn retained_browser_j5_reflected_mapped_source_binding_is_consumed() {
    let reflected = SOURCE.replace(
        "NONUNIFORM($,$,#84,2.,$,3.,0.5)",
        "NONUNIFORM(#85,#86,#84,2.,#87,3.,0.5)",
    ).replace("ENDSEC;END-ISO", "#85=IFCDIRECTION((-1.,0.,0.));#86=IFCDIRECTION((0.,1.,0.));#87=IFCDIRECTION((0.,0.,1.));ENDSEC;END-ISO");
    consume_source(&reflected).await;
}
