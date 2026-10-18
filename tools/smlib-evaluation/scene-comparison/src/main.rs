// SPDX-License-Identifier: MPL-2.0
//! Public-consumer comparison only; no alternate geometry construction.
mod bits;
mod mesh;
mod records;
mod sink;
use ifc_lite_processing::{process,Batching,Features,ProcessingRequest};
use records::Records;
use serde_json::json;
use std::path::Path;

fn main() {
    let args:Vec<_>=std::env::args().collect();
    assert_eq!(args.len(),4,"usage: scene-probe INPUT.ifc OUTPUT_DIRECTORY full|stream|instanced|fastfirst");
    let input=std::fs::read(&args[1]).expect("read actual fixture");
    assert!(input.starts_with(b"ISO-10303-21"),"this probe accepts STEP; IFCX has its own actual consumer lane");
    let output=Path::new(&args[2]);
    let request=match args[3].as_str() {
        "full"=>ProcessingRequest::full_pass(),
        "stream"=>ProcessingRequest::default().batching(Batching::new(2,3))
            .features(Features::default().quick_metadata_bootstrap(true)),
        "fastfirst"=>ProcessingRequest::default().batching(Batching::new(2,3).fast_first(true))
            .features(Features::default().presentation_layers(false).quick_metadata_bootstrap(true)),
        "instanced"=>ProcessingRequest::default().batching(Batching::new(2,3)).instancing(true)
            .features(Features::default().quick_metadata_bootstrap(true)),
        _=>panic!("unknown request mode"),
    };
    let mut records=Records::new(output);
    records.emit("request","resolved",&json!({"opening_filter":format!("{:?}",request.opening_filter),
        "quality":format!("{:?}",request.quality),"initial_batch":request.batching.initial,
        "throughput_batch":request.batching.throughput,"fast_first":request.batching.fast_first,
        "properties":request.features.properties,"presentation_layers":request.features.presentation_layers,
        "quick_bootstrap":request.features.quick_metadata_bootstrap,"retain_meshes":request.retain_meshes,
        "instancing":request.instancing,"entity_filter":request.entity_ids.is_some(),
        "injected_index":request.entity_index.is_some(),"cancel":request.cancel.is_some(),
        "rayon_num_threads":std::env::var("RAYON_NUM_THREADS").ok(),
        "instance_env":std::env::var("IFC_LITE_INSTANCING").ok(),
        "rigid_instance_env":std::env::var("IFC_LITE_RIGID_INSTANCING").ok()}));
    ifc_lite_geometry::csg::reset_csg_census();
    let (result,color_updates)={
        let mut sink=sink::Sink {records:&mut records,sequence:0,color_updates:0};
        let result=process(&input,&request,&mut sink);
        (result,sink.color_updates)
    };
    let mut census=ifc_lite_geometry::csg::take_csg_census();
    census.sort_by_key(|r|(r.op,r.a_tris,r.b_tris));
    records.emit("execution","csg_census_multiset",&census.iter().map(|r|(r.op,r.a_tris,r.b_tris)).collect::<Vec<_>>());
    records.emit("scene.frame","frame",&sink::Frame::from(result.frame));
    records.emit("scene.frame","coordinate_space",&result.mesh_coordinate_space);
    records.emit("scene.frame","site_transform",&result.site_transform);
    records.emit("scene.frame","building_transform",&result.building_transform);
    records.emit("scene.metadata","model",&result.metadata);
    for (index,mesh) in result.meshes.iter().enumerate() {
        records.emit("scene.mesh",index,&mesh::CompleteMesh::from(mesh));
    }
    for (index,instance) in result.instances.iter().enumerate() {
        assert!(result.meshes.iter().any(|m|m.express_id==instance.template_express_id),"missing actual template");
        records.emit("scene.instance",index,&mesh::Occurrence::from(instance));
    }
    records.emit("execution","stats",&result.stats);
    let mut semantic=result.stats.clone();
    semantic.parse_time_ms=0;semantic.entity_scan_time_ms=0;semantic.lookup_time_ms=0;
    semantic.preprocess_time_ms=0;semantic.geometry_time_ms=0;semantic.total_time_ms=0;
    semantic.faceted_brep_time_ms=0;semantic.point_cache_hits=0;semantic.point_cache_misses=0;semantic.from_cache=false;
    records.emit("scene.diagnostics","stats",&semantic);
    let symbolic=ifc_lite_processing::extract_symbolic_data_with_provenance_in_frame(&input,result.frame);
    records.emit("scene.symbolic","data",&symbolic);
    // Production JSON intentionally maps NaN sentinels to null. Retain the raw
    // fields as a sidecar so different NaNs/zero/absence cannot collapse here.
    let data=symbolic.data();
    records.emit("scene.symbolic","raw_sentinels",&(
        data.grid_axes.iter().map(|x|x.world_y).collect::<Vec<_>>(),
        data.polylines.iter().map(|x|x.world_y).collect::<Vec<_>>(),
        data.circles.iter().map(|x|x.world_y).collect::<Vec<_>>(),
        data.texts.iter().map(|x|x.world_y).collect::<Vec<_>>(),
        data.fills.iter().map(|x|(x.world_y,x.hatch_angle_secondary)).collect::<Vec<_>>()));
    let model=ifc_lite_processing::data_model::extract_data_model(&input);
    records.emit("scene.data_model","entities",&model.entities);
    records.emit("scene.data_model","property_sets",&model.property_sets);
    records.emit("scene.data_model","quantity_sets",&model.quantity_sets);
    records.emit("scene.data_model","relationships",&model.relationships);
    records.emit("scene.data_model","classifications",&model.classifications);
    records.emit("scene.data_model","materials",&model.materials);
    records.emit("scene.data_model","documents",&model.documents);
    records.emit("scene.data_model","spatial_hierarchy",&model.spatial_hierarchy);
    records.emit("scene.data_model","refused",&model.refused);
    let witnesses=json!({"color_updates":color_updates,"meshes":result.meshes.len(),"instances":result.instances.len(),
        "vertices":result.stats.total_vertices,"triangles":result.stats.total_triangles,
        "uv_meshes":result.meshes.iter().filter(|m|m.uvs.is_some()).count(),
        "pixel_textures":result.meshes.iter().filter(|m|m.texture.as_ref().is_some_and(|t|t.rgba.is_some())).count(),
        "url_textures":result.meshes.iter().filter(|m|m.texture.as_ref().is_some_and(|t|t.url.is_some())).count(),
        "layer_meshes":result.meshes.iter().filter(|m|m.geometry_class==3).count(),
        "type_meshes":result.meshes.iter().filter(|m|m.geometry_class==1||m.geometry_class==2).count(),
        "texts":data.texts.len(),"fills":data.fills.len(),"polylines":data.polylines.len(),
        "property_sets":model.property_sets.len(),"materials":model.materials.len()});
    records.finish(output,json!({"schema":"ifc-lite-scene-comparison-v1","input":args[1],
        "input_sha256":records::digest(&input),"mode":args[3],"witnesses":witnesses,
        "capabilities":{"full_processing_result":true,"data_model":true,"symbolic_in_result_frame":true,
            "stream_events":true,"scene_float_policy":"exact IEEE bits; vector order retained; map keys ordered",
            "canonical_element_hashes":"unavailable at full-pass public boundary",
            "per_occurrence_refusal_trace":"unavailable at full-pass public boundary",
            "source_material_definition_graph":"not exposed by ProcessingResult; extracted associations retained",
            "external_image_resolution":"not performed by native STEP consumer",
            "ifcx":"separate actual importer lane"}}));
}

#[cfg(test)]
mod collector_tests;
