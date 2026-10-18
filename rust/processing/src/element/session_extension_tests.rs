// SPDX-License-Identifier: MPL-2.0
//! A registered constructor's router mode remains element-owned between polls.
use super::*;
use super::session::ProductState;
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{GeometryProcessor, Result, TessellationQuality};
use std::{cell::RefCell, rc::{Rc,Weak}};

struct PreserveOrderBlock {
    router:Weak<GeometryRouter>,
    prior:Rc<RefCell<Vec<bool>>>,
}
impl GeometryProcessor for PreserveOrderBlock {
    fn supported_types(&self)->Vec<IfcType> { vec![IfcType::IfcBlock] }
    fn process(&self,entity:&DecodedEntity,decoder:&mut EntityDecoder,
        _schema:&IfcSchema,quality:TessellationQuality)->Result<Mesh> {
        let router=self.router.upgrade().expect("registered constructor's router is alive");
        self.prior.borrow_mut().push(router.set_preserve_triangle_order(true));
        // Delegate to a fresh built-in router, so this is real construction
        // without recursively invoking the registered extension.
        let mut builtin = GeometryRouter::new();
        builtin.set_tessellation_quality(quality);
        builtin.process_representation_item(entity, decoder)
    }
}

#[test]
fn registered_processor_mode_mutations_survive_between_type_maps_while_ambient_mode_is_restored() {
    let source="ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBOILERTYPE('t',$,'Library',$,$,$,(#11,#21),$,$,.NOTDEFINED.);
#11=IFCREPRESENTATIONMAP(#5,#12);#12=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#13));
#13=IFCBLOCK(#5,2.,3.,4.);
#21=IFCREPRESENTATIONMAP(#5,#22);#22=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#23));
#23=IFCBLOCK(#5,1.,2.,3.);
ENDSEC;END-ISO-10303-21;";
    let mut decoder=EntityDecoder::new(source);
    let prior=Rc::new(RefCell::new(Vec::new()));
    let router=Rc::new_cyclic(|weak:&Weak<GeometryRouter>| {
        let mut router=GeometryRouter::with_units(source,&mut decoder);
        decoder.seed_unit_scales(router.unit_scale(),1.);
        router.register(Box::new(PreserveOrderBlock { router:weak.clone(),prior:prior.clone() }));
        router
    });
    // Ambient configuration belongs to the caller, while an element starts
    // with its own inferred order mode (false for this palette-free source).
    router.set_preserve_triangle_order(true);
    let openings=FxHashMap::default();
    let styles=FxHashMap::default();
    let palettes=FxHashMap::default();
    let materials=FxHashMap::default();
    let textures=FxHashMap::default();
    let context=MeshProductionContext { void_index:&openings,geometry_style_index:&styles,
        indexed_colour_full:&palettes,element_material_colors:&materials,
        texture_index:&textures,site_local_rotation:None };
    let entity=decoder.decode_by_id(10).unwrap();
    let job=ElementMeshJob { id:10,ifc_type:entity.ifc_type.clone(),entity:&entity,
        kind:ElementJobKind::TypeProduct { rep_maps:plan_type_geometry(
            &[11,21],&FxHashSet::default(),false,TypeGeometryMode::EmitTagged) },
        element_color:None,metadata:None };
    let mut session=ProductState::new(&job,&context,&MeshProductionOptions::default(),
        &mut decoder,&router);
    assert!(router.set_preserve_triangle_order(true),"planning restores ambient mode");
    assert!(session.advance(&context,&mut decoder,&router));
    assert_eq!(&*prior.borrow(),&[false]);
    assert!(router.set_preserve_triangle_order(true),"first map restores ambient mode");
    assert!(session.advance(&context,&mut decoder,&router));
    assert_eq!(&*prior.borrow(),&[false,true],"second map sees the first constructor's element-local mutation");
    assert!(router.set_preserve_triangle_order(true),"second map restores ambient mode");
    while session.advance(&context,&mut decoder,&router) {
        assert!(router.set_preserve_triangle_order(true));
    }
    let produced=session.finish(&decoder,&router);
    assert!(router.set_preserve_triangle_order(true),"publication restores ambient mode");
    assert_eq!(produced.meshes.len(),2);
    assert!(produced.meshes.iter().all(|mesh|mesh.indices.len()==36&&mesh.geometry_class==1));
    let volumes:Vec<_>=produced.meshes.iter().map(|mesh| {
        mesh.indices.chunks_exact(3).map(|triangle| {
            let p=|index:u32| {
                let offset=index as usize*3;
                nalgebra::Vector3::new(f64::from(mesh.positions[offset]),
                    f64::from(mesh.positions[offset+1]),f64::from(mesh.positions[offset+2]))
            };
            p(triangle[0]).dot(&p(triangle[1]).cross(&p(triangle[2])))/6.
        }).sum::<f64>().abs()
    }).collect();
    assert!((volumes[0]-24.).abs()<1e-6);
    assert!((volumes[1]-6.).abs()<1e-6);
    assert!(produced.csg_failures.is_empty());
    assert_eq!(prior.borrow().len(),2,"each distinct source block executes exactly once");
}
