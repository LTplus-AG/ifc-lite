// SPDX-License-Identifier: MPL-2.0
//! Owned product execution across source lifetimes, independent worker owners
//! and short TLS scopes, proved through real IFC constructions and assembly.
use super::*;
use super::owned_session::OwnedProductExecution;
use ifc_lite_geometry::kernel::budget;

#[derive(Default)]
pub(super) struct Context {
    openings: FxHashMap<u32, Vec<u32>>,
    styles: FxHashMap<u32, GeometryStyleInfo>,
    palettes: FxHashMap<u32, FullIndexedColourMap>,
    materials: FxHashMap<u32, Vec<[f32;4]>>,
    textures: FxHashMap<u32, ResolvedTextureMap>,
}
impl Context {
    pub(super) fn borrowed(&self) -> MeshProductionContext<'_> {
        MeshProductionContext { void_index:&self.openings, geometry_style_index:&self.styles,
            indexed_colour_full:&self.palettes, element_material_colors:&self.materials,
            texture_index:&self.textures, site_local_rotation:None }
    }
}
pub(super) const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCAXIS2PLACEMENT3D(#8,$,$);#8=IFCCARTESIANPOINT((10.,20.,30.));
#9=IFCLOCALPLACEMENT($,#7);#10=IFCWALL('w',$,'Wall',$,$,#9,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#15=IFCDIRECTION((0.,0.,1.));
#17=IFCAXIS2PLACEMENT3D(#18,$,$);#18=IFCCARTESIANPOINT((-4.,3.,2.));
#19=IFCLOCALPLACEMENT($,#17);#20=IFCSLAB('s',$,'Slab',$,$,#19,#21,$,.FLOOR.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23));
#23=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5);
#50=IFCALIGNMENT('a',$,'Road',$,$,$,$,#53);
#51=IFCCARTESIANPOINT((0.,0.,0.));#52=IFCCARTESIANPOINT((10.,0.,0.));#53=IFCPOLYLINE((#51,#52));
#60=IFCBOILERTYPE('t',$,'Library',$,$,$,(#61,#71),$,$,.NOTDEFINED.);
#61=IFCREPRESENTATIONMAP(#7,#12);#71=IFCREPRESENTATIONMAP(#17,#22);
ENDSEC;END-ISO-10303-21;";
pub(super) fn router(decoder:&mut EntityDecoder) -> GeometryRouter {
    let mut router=GeometryRouter::with_units(SOURCE,decoder);
    decoder.seed_unit_scales(router.unit_scale(),1.);
    router.set_rtc_offset((8.,16.,0.));
    router
}
pub(super) fn options() -> MeshProductionOptions {
    MeshProductionOptions { geometry_hash:Some(GeometryHashConfig { tolerance:1e-5,world_rtc:[8.,16.,0.] }) }
}
pub(super) fn metadata(id:u32)->ElementMeshMetadata {
    ElementMeshMetadata { global_id:Some(format!("owned-{id}")),name:Some(format!("product {id}")),
        presentation_layer:Some("layer A".into()),
        space_zone_properties:Some([("Reference".into(),"owned property".into())].into()) }
}
pub(super) fn job<'a>(entity:&'a DecodedEntity,metadata:&'a ElementMeshMetadata)->ElementMeshJob<'a> {
    ElementMeshJob { id:entity.id,ifc_type:entity.ifc_type.clone(),entity,kind:ElementJobKind::Product,
        element_color:Some(if entity.id==20 {[0.7,0.2,0.1,1.]}else{[0.1,0.4,0.8,1.]}),metadata:Some(metadata) }
}
pub(super) fn canonical(id:u32,types:bool)->ProducedElementMeshes {
    let mut decoder=EntityDecoder::new(SOURCE);
    let router=router(&mut decoder);
    let entity=decoder.decode_by_id(id).unwrap();
    let metadata=metadata(id);
    let mut job=job(&entity,&metadata);
    if types { job.kind=ElementJobKind::TypeProduct { rep_maps:plan_type_geometry(
        &[61,71],&FxHashSet::default(),false,TypeGeometryMode::EmitTagged) }; }
    produce_element_meshes(&job,&Context::default().borrowed(),&options(),&mut decoder,&router)
}
pub(super) fn assert_same(actual:&ProducedElementMeshes,expected:&ProducedElementMeshes) {
    assert!(!actual.meshes.is_empty(),"fixture must produce real geometry");
    assert_eq!(actual.meshes.len(),expected.meshes.len());
    for (actual,expected) in actual.meshes.iter().zip(&expected.meshes) {
        assert_eq!(actual.positions,expected.positions);
        assert_eq!(actual.normals,expected.normals);
        assert_eq!(actual.indices,expected.indices);
        assert_eq!(actual.origin,expected.origin);
        assert_eq!(actual.local_bounds,expected.local_bounds);
        assert_eq!(actual.local_to_world,expected.local_to_world);
        assert_eq!(actual.express_id,expected.express_id);
        assert_eq!(actual.ifc_type,expected.ifc_type);
        assert_eq!(actual.geometry_item_id,expected.geometry_item_id);
        assert_eq!(actual.geometry_class,expected.geometry_class);
        assert_eq!(actual.color,expected.color);
        assert_eq!(actual.global_id,expected.global_id);
        assert_eq!(actual.name,expected.name);
        assert_eq!(actual.presentation_layer,expected.presentation_layer);
        assert_eq!(actual.properties,expected.properties);
    }
    assert_eq!(actual.geometry_hash,expected.geometry_hash);
    assert_eq!(actual.geometry_aabb,expected.geometry_aabb);
    assert_eq!(actual.geometry_volume,expected.geometry_volume);
    assert_eq!(actual.geometry_closure,expected.geometry_closure);
    assert_eq!(actual.csg_failures,expected.csg_failures);
    assert_eq!(actual.degenerate_triangles_dropped,expected.degenerate_triangles_dropped);
    assert!(actual.instance_occurrences.is_empty()&&expected.instance_occurrences.is_empty());
}
fn finish(mut session:OwnedProductExecution)->ProducedElementMeshes {
    // Same source model and configuration, with independent source storage,
    // decoder and router owned by the destination worker.
    let source=SOURCE.to_owned();
    let mut decoder=EntityDecoder::new(&source);
    let router=router(&mut decoder);
    while session.advance(&mut decoder,&router).unwrap() {}
    session.finish(&decoder,&router).unwrap()
}

#[test]
fn owned_product_hasher_and_metadata_resume_after_original_source_disposal_on_another_worker() {
    let session={
        let source=SOURCE.to_owned();
        let mut decoder=EntityDecoder::new(&source);
        let router=router(&mut decoder);
        let entity=decoder.decode_by_id(50).unwrap();
        let metadata=metadata(50);
        let context=ProductionModel::new().snapshot(OwnedMeshProductionData::default());
        // Transfer after planning, before any numerical router work. Cache or
        // pending-diagnostic migration is deliberately outside this fixture.
        OwnedProductExecution::new(&job(&entity,&metadata),&context,
            &options(),&mut decoder,&router).unwrap()
    };
    let actual=std::thread::spawn(move||finish(session)).join().unwrap();
    assert!(actual.geometry_hash.is_some(),"the resumed product really executes its owned hasher");
    assert_same(&actual,&canonical(50,false));
    assert!(actual.meshes.iter().all(|mesh|mesh.name.as_deref()==Some("product 50")));
}

#[test]
fn owned_representation_maps_survive_job_disposal_and_worker_transfer() {
    let session={
        let source=SOURCE.to_owned();
        let mut decoder=EntityDecoder::new(&source);
        let router=router(&mut decoder);
        let entity=decoder.decode_by_id(60).unwrap();
        let metadata=metadata(60);
        let mut job=job(&entity,&metadata);
        job.kind=ElementJobKind::TypeProduct { rep_maps:plan_type_geometry(
            &[61,71],&FxHashSet::default(),false,TypeGeometryMode::EmitTagged) };
        let context=ProductionModel::new().snapshot(OwnedMeshProductionData::default());
        // All maps remain dormant: this tests input ownership without claiming
        // that an executing router's caches or diagnostics can migrate.
        OwnedProductExecution::new(&job,&context,&options(),&mut decoder,&router).unwrap()
    };
    let actual=std::thread::spawn(move||finish(session)).join().unwrap();
    assert_same(&actual,&canonical(60,true));
    assert_eq!(actual.meshes.len(),2,"both owned maps must survive job disposal");
    assert!(actual.meshes.iter().all(|mesh|mesh.geometry_class==1&&mesh.global_id.as_deref()==Some("owned-60")));
    assert!(actual.geometry_hash.is_none(),"type library geometry remains excluded from product hashes");
}

fn clean_collapsed_mesh() {
    let mut mesh=Mesh::new();
    mesh.positions=vec![0.,0.,0.,1.,0.,0.,1.,0.,0.];
    mesh.normals=vec![0.,0.,1.,0.,0.,1.,0.,0.,1.];
    mesh.indices=vec![0,1,2];
    degenerate::clean(&mut mesh);
}
#[test]
fn independent_product_sessions_interleave_without_crossing_style_hash_frame_or_ambient_counters() {
    let expected_wall=canonical(10,false);
    let expected_slab=canonical(20,false);
    let _budget=budget::enter_element();
    let _degenerate=degenerate::begin_element();
    for _ in 0..3 { budget::note_escalation(); }
    clean_collapsed_mesh();
    let ambient_budget=budget::element_count();
    let ambient_dropped=degenerate::dropped_this_element();
    let assert_ambient=|| {
        assert_eq!(budget::element_count(),ambient_budget);
        assert_eq!(degenerate::dropped_this_element(),ambient_dropped);
    };
    let context=ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    let mut first_decoder=EntityDecoder::new(SOURCE);
    let first_router=router(&mut first_decoder);
    let mut second_decoder=EntityDecoder::new(SOURCE);
    let second_router=router(&mut second_decoder);
    let wall=first_decoder.decode_by_id(10).unwrap();
    let slab=second_decoder.decode_by_id(20).unwrap();
    let wall_metadata=metadata(10);
    let slab_metadata=metadata(20);
    let mut first=OwnedProductExecution::new(&job(&wall,&wall_metadata),&context,
        &options(),&mut first_decoder,&first_router).unwrap();
    assert_ambient();
    let mut second=OwnedProductExecution::new(&job(&slab,&slab_metadata),&context,
        &options(),&mut second_decoder,&second_router).unwrap();
    assert_ambient();
    loop {
        let a=first.advance(&mut first_decoder,&first_router).unwrap();
        assert_ambient();
        let b=second.advance(&mut second_decoder,&second_router).unwrap();
        assert_ambient();
        if !a&&!b { break; }
    }
    let wall=first.finish(&first_decoder,&first_router).unwrap();
    let slab=second.finish(&second_decoder,&second_router).unwrap();
    assert_same(&wall,&expected_wall);
    assert_same(&slab,&expected_slab);
    assert!((wall.geometry_volume.expect("closed 2 x 4 x 3 wall")-24.).abs()<1e-5);
    assert!((slab.geometry_volume.expect("closed 2 x 4 x 0.5 slab")-4.).abs()<1e-5);
    assert_ne!(wall.meshes[0].color,slab.meshes[0].color);
    assert_ne!(wall.geometry_hash,slab.geometry_hash);
    assert_ne!(wall.geometry_aabb,slab.geometry_aabb);
    assert_ambient();
}
