// SPDX-License-Identifier: MPL-2.0
//! P1 source-driven native witnesses. SDK absence is an explicit skip, never proof.
use super::*;
use super::tests::{execution,worker};
use super::super::session_tests::{SOURCE,router};
use super::super::{OwnedMeshProductionData,ProductionModel};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry_runtime::MeshLimits;

fn context() -> (ProductionModel,Arc<OwnedMeshProductionContext>) {
    let source=SOURCE.replace("'SweptSolid',(#13)","'MappedRepresentation',(#93,#94)")
        .replace("ENDSEC;END-ISO-10303-21;","
        #90=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
        #91=IFCREPRESENTATIONMAP(#5,#90);
        #92=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#95,1.,$);
        #93=IFCMAPPEDITEM(#91,#92);#94=IFCMAPPEDITEM(#91,#96);
        #95=IFCCARTESIANPOINT((2.,3.,4.));
        #96=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#97,1.,$);
        #97=IFCCARTESIANPOINT((-2.,3.,4.));ENDSEC;END-ISO-10303-21;");
    let model=ProductionModel::from_source(SourceBundle::new(source.into_bytes()));
    let context=model.snapshot(OwnedMeshProductionData::default());
    (model,context)
}

#[test]
fn p1_native_reached_cache_reuses_one_immutable_realization_for_distinct_placed_occurrences() {
    let Some(mut worker)=worker() else {return};
    let (_,context)=context();
    let mut decoder=context.source().unwrap().decoder();
    let mut router=router(&mut decoder);
    // P1 styled sharing begins at the actual template/placeholder admission.
    router.enable_output_instancing(Arc::new([(91,(2,93))].into_iter().collect()));
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();
    let receipt=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    let solid=receipt.realization().solid();
    assert!((worker.volume(solid,1e-8).unwrap()-24.).abs()<1e-6);
    execution.accept(receipt,&mut decoder,&router).unwrap();
    assert!(execution.issue_next(&worker,&mut decoder,&router).unwrap().is_none());
    assert_eq!(execution.discharged_count(),1);
    let plan=execution.traversal_plan().unwrap();
    assert_eq!(plan.values.len(),2);
    assert_eq!(plan.values[0].definition(),plan.values[1].definition());
    assert_ne!(plan.values[0].slot(),plan.values[1].slot());
    let a=plan.values[0].world_from_evaluation()*nalgebra::Vector4::new(0.,0.,0.,1.);
    let b=plan.values[1].world_from_evaluation()*nalgebra::Vector4::new(0.,0.,0.,1.);
    for (actual,expected) in [(a,[11.,21.,34.,1.]),(b,[7.,21.,34.,1.])] {
        for axis in 0..4 {assert!((actual[axis]-expected[axis]).abs()<1e-10);}
    }
    assert_eq!(execution.ledger[0].receipt.realization().solid(),solid);
    assert!((worker.volume(solid,1e-8).unwrap()-24.).abs()<1e-6,
        "logical occurrence placement never mutates shared source BRep");
}

#[test]
fn p1_mapped_foreign_receipt_and_expired_original_source_reject_before_take() {
    let Some(mut worker)=worker() else {return};
    let (model_a,context_a)=context();
    let (_,context_b)=context();
    let mut decoder_a=context_a.source().unwrap().decoder();
    let mut decoder_b=context_b.source().unwrap().decoder();
    let router_a=router(&mut decoder_a);let router_b=router(&mut decoder_b);
    let mut first=execution(&context_a,&mut decoder_a,&router_a);
    let mut foreign=execution(&context_b,&mut decoder_b,&router_b);
    let issued_a=first.issue_next(&worker,&mut decoder_a,&router_a).unwrap().unwrap();
    let issued_b=foreign.issue_next(&worker,&mut decoder_b,&router_b).unwrap().unwrap();
    let receipt_a=issued_a.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    let receipt_b=issued_b.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    let rejected=first.accept(receipt_b,&mut decoder_a,&router_a).unwrap_err();
    assert!(first.pending.as_ref().unwrap().reply.is_some());
    assert!(foreign.pending.as_ref().unwrap().reply.is_some());
    assert!(rejected.work.realization().validate_live().is_ok());
    assert_ne!(worker.incarnation(),0,"foreign receipt cannot retire captured worker");
    foreign.accept(rejected.work,&mut decoder_b,&router_b).unwrap();
    model_a.invalidate_source();
    let rejected=first.accept(receipt_a,&mut decoder_a,&router_a).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Source));
    assert!(first.pending.as_ref().unwrap().reply.is_some());
    assert_eq!(first.discharged_count(),0);
    // Current cancellation retires its worker domain. This is NOT an independent
    // lifetime witness; managed native object release remains a runtime gate.
}

fn products_source(count:u32)->String {
    let mut additions=String::new();
    for index in 0..count {
        let id=100+index*10;
        additions.push_str(&format!("#{id}=IFCWALL('p{index}',$,'Placed product {index}',$,$,#{placement},#{shape},$,$);
            #{shape}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));
            #{rep}=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#{item}));
            #{item}=IFCMAPPEDITEM(#61,$);#{placement}=IFCLOCALPLACEMENT($,#{axis});
            #{axis}=IFCAXIS2PLACEMENT3D(#{point},$,$);#{point}=IFCCARTESIANPOINT(({x}.,0.,0.));
            #{relation}=IFCRELDEFINESBYTYPE('r{index}',$,$,$,(#{id}),#60);",
            shape=id+1,rep=id+2,item=id+3,placement=id+4,axis=id+5,point=id+6,x=index*20,relation=1000+index));
    }
    SOURCE.replace("ENDSEC;END-ISO-10303-21;",&format!("{additions}ENDSEC;END-ISO-10303-21;"))
}

#[test]
fn p1_type_product_uses_actual_one_and_three_products_and_orphan_mode_consumers() {
    use super::super::{ElementJobKind,TypeGeometryMode,plan_type_geometry};
    use ifc_lite_geometry::program::{RetainedPlacementStage,LogicalRetainedValue};
    for products in [0,1,3] {
        for mode in [TypeGeometryMode::SuppressInstanced,TypeGeometryMode::EmitTagged] {
            let Some(mut worker)=worker() else {return};
            let source=products_source(products);
            let model=ProductionModel::from_source(SourceBundle::new(source.into_bytes()));
            let context=model.snapshot(OwnedMeshProductionData::default());
            let mut decoder=context.source().unwrap().decoder();
            let mut referenced=rustc_hash::FxHashSet::default();
            let mut type_products=rustc_hash::FxHashSet::default();
            let mut product_slots=Vec::new();let mut product_definitions=Vec::new();
            // Keep accepted source receipts alive throughout this scenario. The
            // managed native Drop integration is a separately qualified layer.
            let mut completed=Vec::new();
            for index in 0..products {
                let id=100+index*10;
                let mapped=decoder.decode_by_id(id+3).unwrap();
                let map=mapped.get_ref(ifc_lite_core::slot::IfcMappedItem::MAPPING_SOURCE.index()).unwrap();
                referenced.insert(map);
                let relation=decoder.decode_by_id(1000+index).unwrap();
                let related=decoder.resolve_ref_list(relation.get(ifc_lite_core::slot::IfcRelDefinesByType::RELATED_OBJECTS.index()).unwrap()).unwrap();
                assert_eq!(related.len(),1);assert_eq!(related[0].id,id);
                assert_eq!(relation.get_ref(ifc_lite_core::slot::IfcRelDefinesByType::RELATING_TYPE.index()),Some(60));type_products.insert(id);
                // Each dormant execution retains its exclusive source owner.
                // Bind independent pairs to the SAME authenticated bundle; keep
                // the pairs alive with their ledgers rather than releasing them.
                let mut product_decoder=context.source().unwrap().decoder();
                let mut product_router=router(&mut product_decoder);
                product_router.enable_output_instancing(Arc::new([(61,(products,103))].into_iter().collect()));
                let entity=product_decoder.decode_by_id(id).unwrap();let metadata=super::super::session_tests::metadata(id);
                let job=super::super::session_tests::job(&entity,&metadata);
                let mut execution=RetainedProductExecution::new(&job,&context,&super::super::session_tests::options(),&mut product_decoder,&product_router).unwrap();
                let mut issued_count=0;
                while let Some(issued)=execution.issue_next(&worker,&mut product_decoder,&product_router).unwrap() {
                    let receipt=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
                    assert!((worker.volume(receipt.realization().solid(),1e-8).unwrap()-24.).abs()<1e-6);
                    execution.accept(receipt,&mut product_decoder,&product_router).unwrap();issued_count+=1;
                }
                assert_eq!(issued_count,1,"one source construction per product-scoped admitted definition");
                assert_eq!(execution.discharged_count(),1);
                let plan=execution.traversal_plan().unwrap();assert_eq!(plan.values.len(),1);
                let value=&plan.values[0];assert!(value.is_product_placed());
                assert!(matches!(value.placements().last().unwrap().stage,RetainedPlacementStage::Product {product_id} if product_id==id));
                let frame=value.world_from_evaluation();
                for (axis,expected) in [(0,9.+f64::from(index)*20.),(1,18.),(2,30.)] {
                    assert!((frame[(axis,3)]-expected).abs()<1e-10,"actual product placement and mapping origin");
                }
                let binding=value.presentation().last().unwrap();
                assert_eq!(binding.geometry_id,13);assert_eq!(binding.style_source_id,id+3);
                assert_eq!(binding.representation_map,Some(61));
                assert_eq!(binding.placeholder,products>=2 && index>0);
                product_slots.push(value.slot());product_definitions.push(value.definition().clone());
                assert_eq!(product_router.mapped_shared_unique_count(),0,"logical templates never enter exact mesh cache");
                completed.push((execution,product_decoder,product_router));
            }
            assert_eq!(type_products.len(),products as usize);
            assert_eq!(product_slots.iter().collect::<std::collections::HashSet<_>>().len(),products as usize);
            assert_eq!(product_definitions.iter().collect::<std::collections::HashSet<_>>().len(),products as usize,
                "distinct product scopes cannot pretend to share one admitted receipt");
            let instantiated=!type_products.is_empty();
            let maps=plan_type_geometry(&[61,71],&referenced,instantiated,mode);
            let expected_maps:Vec<_>=if !instantiated {vec![(61,1),(71,1)]}
                else if mode==TypeGeometryMode::EmitTagged {vec![(71,2)]} else {Vec::new()};
            assert_eq!(maps,expected_maps,"referenced map61 only draws through actual products");
            let mut type_decoder=context.source().unwrap().decoder();let mut type_router=router(&mut type_decoder);
            type_router.enable_output_instancing(Arc::new([(61,(products,103))].into_iter().collect()));
            let entity=type_decoder.decode_by_id(60).unwrap();let metadata=super::super::session_tests::metadata(60);
            let mut job=super::super::session_tests::job(&entity,&metadata);
            job.kind=ElementJobKind::TypeProduct {rep_maps:maps};
            let mut execution=RetainedProductExecution::new(&job,&context,&super::super::session_tests::options(),&mut type_decoder,&type_router).unwrap();
            let mut actual=0;let mut direct_volume=0.;
            while let Some(issued)=execution.issue_next(&worker,&mut type_decoder,&type_router).unwrap() {
                let receipt=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
                direct_volume+=worker.volume(receipt.realization().solid(),1e-8).unwrap();
                execution.accept(receipt,&mut type_decoder,&type_router).unwrap();actual+=1;
            }
            assert_eq!(actual,expected_maps.len());assert_eq!(execution.discharged_count(),expected_maps.len());
            let expected_volume=if !instantiated {28.} else if mode==TypeGeometryMode::EmitTagged {4.} else {0.};
            assert!((direct_volume-expected_volume).abs()<1e-6,"actual direct geometry executes once, independent of product count");
            let plan=execution.traversal_plan().unwrap();assert_eq!(plan.values.len(),expected_maps.len());
            for (value,(map,class)) in plan.values.iter().zip(&expected_maps) {
                let binding=value.presentation().last().unwrap();assert_eq!(binding.type_product,Some((60,*class)));
                assert!(!value.is_product_placed());assert!(value.presentation().iter().all(|p|!p.placeholder));
                assert!(matches!(value.placements().last().unwrap().stage,RetainedPlacementStage::TypeMap {representation_map} if representation_map==*map));
                assert!(!product_slots.contains(&value.slot()));
                let expected=if *map==61 {[9.,18.,30.]} else {[-5.,1.,2.]};
                let frame=value.world_from_evaluation();for axis in 0..3 {assert!((frame[(axis,3)]-expected[axis]).abs()<1e-10);}
                assert_eq!(binding.fallback_color,Some([0.1,0.4,0.8,1.]));
            }
            assert_eq!(plan.values.iter().map(LogicalRetainedValue::slot).collect::<std::collections::HashSet<_>>().len(),expected_maps.len());
            assert_eq!(completed.iter().map(|(execution,_,_)|execution.discharged_count()).sum::<usize>(),products as usize);
            completed.push((execution,type_decoder,type_router));
            for (execution,decoder,router) in &completed {
                context.validate_decoder(decoder).unwrap();
                assert!(decoder.try_execution_lease().is_err());assert!(router.try_execution_lease().is_err(),
                    "final-net obligations retain each independent exclusive owner");
                for definition in &execution.ledger {definition.receipt.realization.validate_live().unwrap();}
            }
        }
    }
}
