// SPDX-License-Identifier: MPL-2.0
//! The owned driver retains real extension reentry and reports source expiry.
use super::*;
use super::session_tests::{SOURCE,assert_same,canonical,job,metadata,options,router};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor,GeometryProcessor,TessellationQuality};
use std::{cell::{Cell,RefCell},rc::{Rc,Weak},sync::Arc};

struct Nested {
    router:Weak<GeometryRouter>,context:Arc<OwnedMeshProductionContext>,
    child:Rc<RefCell<Option<ProducedElementMeshes>>>,
}
impl GeometryProcessor for Nested {
    fn supported_types(&self)->Vec<IfcType> {vec![IfcType::IfcExtrudedAreaSolid]}
    fn process(&self,entity:&DecodedEntity,decoder:&mut EntityDecoder,schema:&IfcSchema,
        quality:TessellationQuality)->ifc_lite_geometry::Result<Mesh> {
        if entity.id==13 {
            let child=decoder.decode_by_id(20).unwrap();
            let result=produce_element_meshes_owned(&job(&child,&metadata(20)),&self.context,&options(),
                decoder,&self.router.upgrade().unwrap()).unwrap();
            *self.child.borrow_mut()=Some(result);
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
}
#[test]
fn owned_public_driver_preserves_lexical_nested_product_with_same_snapshot_and_runtime_owners() {
    let source=ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let model=ProductionModel::from_source(source.clone());let context=model.snapshot(OwnedMeshProductionData::default());
    let mut decoder=source.decoder();let mut geometry_router=router(&mut decoder);
    let child=Rc::new(RefCell::new(None));
    let router=Rc::new_cyclic(|router| {
        geometry_router.register(Box::new(Nested {router:router.clone(),context:context.clone(),child:child.clone()}));
        geometry_router
    });
    let entity=decoder.decode_by_id(10).unwrap();
    let actual=produce_element_meshes_owned(&job(&entity,&metadata(10)),&context,&options(),&mut decoder,&router).unwrap();
    assert_same(&actual,&canonical(10,false));
    assert_same(&child.borrow_mut().take().expect("real nested slab completed"),&canonical(20,false));
    assert!(decoder.try_execution_lease().is_ok());assert!(router.try_execution_lease().is_ok());
}

struct Invalidate {model:ProductionModel,once:Rc<Cell<bool>>,calls:Rc<Cell<usize>>}
impl GeometryProcessor for Invalidate {
    fn supported_types(&self)->Vec<IfcType> {vec![IfcType::IfcExtrudedAreaSolid]}
    fn process(&self,entity:&DecodedEntity,decoder:&mut EntityDecoder,schema:&IfcSchema,
        quality:TessellationQuality)->ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get()+1);
        if self.once.replace(false) {self.model.invalidate_source()}
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
}
#[test]
fn invalidation_inside_actual_geometry_callback_returns_typed_error_and_fresh_snapshot_can_retry() {
    let source=ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let model=ProductionModel::from_source(source.clone());let context=model.snapshot(OwnedMeshProductionData::default());
    let mut decoder=source.decoder();let mut router=router(&mut decoder);
    let calls=Rc::new(Cell::new(0));
    router.register(Box::new(Invalidate {model:model.clone(),once:Rc::new(Cell::new(true)),calls:calls.clone()}));
    let entity=decoder.decode_by_id(10).unwrap();
    assert_eq!(produce_element_meshes_owned(&job(&entity,&metadata(10)),&context,&options(),&mut decoder,&router).err(),
        Some(ProductionContextError::StaleSource));
    assert_eq!(calls.get(),1,"expiry happened during actual geometry, before owned presentation acceptance");
    assert!(decoder.try_execution_lease().is_ok());assert!(router.try_execution_lease().is_ok());
    let fresh=model.snapshot(OwnedMeshProductionData::default());
    let actual=produce_element_meshes_owned(&job(&entity,&metadata(10)),&fresh,&options(),&mut decoder,&router).unwrap();
    assert_same(&actual,&canonical(10,false));
}
