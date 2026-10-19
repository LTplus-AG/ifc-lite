// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Untimed, verification-only full ordinary-consumer capture. No router calls.
#[path = "exact_route_capture/bits.rs"]
mod bits;
use ifc_lite_processing::{process_geometry, ProcessingResult};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::io::Write;

fn put<T: Serialize + ?Sized>(out: &mut Map<String, Value>, key: &str, v: &T)
    -> Result<(), serde_json::Error> {
    out.insert(key.into(), bits::value(v)?); Ok(())
}

fn capture(result: ProcessingResult) -> Result<Value, serde_json::Error> {
    // Deliberately exhaustive: a new result field requires a capture decision.
    let ProcessingResult { meshes, instances, mesh_coordinate_space, frame,
        site_transform, building_transform, metadata, stats } = result;
    let mut out = Map::new();
    let mut captured_meshes = Vec::new();
    for mesh in &meshes {
        // All serde-visible fields (including UVs and texture bytes).
        let mut record = Map::new();
        let mut serialized = bits::value(mesh)?;
        for key in ["global_id", "name", "presentation_layer", "material_name", "geometry_item_id",
            "material_id", "properties", "uvs", "texture"] {
            serialized.as_object_mut().unwrap().entry(key).or_insert(Value::Null);
        }
        serialized["geometry_class"] = bits::value(&mesh.geometry_class)?;
        serialized["origin"] = bits::value(&mesh.origin)?;
        if let Some(texture) = serialized["texture"].as_object_mut() {
            for key in ["rgba", "url"] { texture.entry(key).or_insert(Value::Null); }
        }
        record.insert("serialized".into(), serialized);
        // Exhaustive pattern catches new fields even if serde skips them.
        let ifc_lite_processing::MeshData {
            express_id: _, ifc_type: _, global_id: _, name: _, presentation_layer: _,
            positions: _, normals: _, indices: _, color: _, material_name: _,
            geometry_item_id: _, material_id: _, properties: _, uvs: _, texture: _,
            geometry_class, origin, instance, local_bounds, local_to_world,
        } = mesh;
        put(&mut record, "geometry_class", geometry_class)?;
        put(&mut record, "origin", origin)?; // Preserve signed zero skipped by serde.
        put(&mut record, "local_bounds", local_bounds)?;
        put(&mut record, "local_to_world", local_to_world)?;
        let instance = instance.as_ref().map(|i| {
            let ifc_lite_geometry::InstanceMeta { transform, local_transform,
                canonical_transform, rep_identity, instanceable } = i;
            (transform, local_transform, canonical_transform, rep_identity, instanceable)
        });
        put(&mut record, "instance_transform_local_canonical_identity_shareable", &instance)?;
        captured_meshes.push(Value::Object(record));
    }
    out.insert("meshes".into(), Value::Array(captured_meshes));
    let mut captured_instances = Vec::new();
    for i in &instances {
        let ifc_lite_processing::InstanceRecord {
            express_id, ifc_type, global_id, name, presentation_layer, color,
            template_express_id, rep_identity, transform, geometry_item_id,
        } = i;
        captured_instances.push(bits::value(&(express_id, ifc_type, global_id, name,
            presentation_layer, color, template_express_id, rep_identity, transform, geometry_item_id))?);
    }
    out.insert("instances_id_type_guid_name_layer_color_template_identity_transform_item".into(),
        Value::Array(captured_instances));
    put(&mut out, "mesh_coordinate_space", &mesh_coordinate_space)?;
    let frame_parts = match frame {
        ifc_lite_processing::MeshFrame::RawIfc => ("RawIfc", None, None),
        ifc_lite_processing::MeshFrame::ModelRtc { anchor } => ("ModelRtc", Some(anchor), None),
        ifc_lite_processing::MeshFrame::SiteLocal { placement } => ("SiteLocal", None, Some(placement)),
    };
    put(&mut out, "frame_variant_anchor_placement", &frame_parts)?;
    put(&mut out, "frame_world_matrix", &frame.world_matrix())?;
    put(&mut out, "site_transform", &site_transform)?;
    put(&mut out, "building_transform", &building_transform)?;
    let mut metadata = bits::value(&metadata)?;
    for key in ["length_unit_scale", "length_unit_refused", "georeferencing"] {
        metadata.as_object_mut().unwrap().entry(key).or_insert(Value::Null);
    }
    if let Some(georef) = metadata["georeferencing"].as_object_mut() {
        for key in ["crs_name", "geodetic_datum", "vertical_datum", "map_projection", "crs_description",
            "map_zone", "map_unit", "map_unit_scale", "source"] {
            georef.entry(key).or_insert(Value::Null);
        }
    }
    out.insert("metadata".into(), metadata);
    // Retain every statistic, but explicitly separate wall clocks/cache work from
    // semantic equality. Geometry diagnostics, refusals and drops remain compared.
    let mut serialized_stats = bits::value(&stats)?.as_object().unwrap().clone();
    put(&mut serialized_stats, "refused_input_elements", &stats.refused_input_elements)?;
    put(&mut serialized_stats, "refused_prepass_records", &stats.refused_prepass_records)?;
    put(&mut serialized_stats, "geometry_diagnostics", &stats.geometry_diagnostics)?;
    if let Some(hosts) = serialized_stats.get_mut("geometry_diagnostics").and_then(|v| v.get_mut("worstHosts")).and_then(Value::as_array_mut) {
        for host in hosts {
            for key in ["firstFailureLabel", "bbox", "triangleCount"] {
                host.as_object_mut().unwrap().entry(key).or_insert(Value::Null);
            }
        }
    }
    let mut stats = serialized_stats;
    let mut execution = Map::new();
    for name in ["parse_time_ms", "entity_scan_time_ms", "lookup_time_ms", "preprocess_time_ms",
        "geometry_time_ms", "total_time_ms", "faceted_brep_time_ms", "point_cache_hits", "point_cache_misses"] {
        if let Some(v) = stats.remove(name) { execution.insert(name.into(), v); }
    }
    put(&mut out, "stats", &stats)?;
    Ok(serde_json::json!({"scene": out, "execution_only": execution}))
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 { return Err("usage: exact_route_capture FIXTURE OUTPUT.json".into()); }
    // No geometry-policy environment overrides are accepted in this protocol.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("IFC_LITE_") {
            return Err(format!("remove geometry environment override: {}", key.to_string_lossy()).into());
        }
    }
    let content = std::fs::read(&args[0])?;
    let hash = format!("{:x}", Sha256::digest(&content));
    let mut output = capture(process_geometry(&content))?;
    output["protocol"] = Value::String("exact-route-v2".into());
    output["fixture_sha256"] = Value::String(hash);
    output["options"] = Value::String("process_geometry/full_pass/default-opening/default-quality/default-features/no-IFC_LITE-overrides".into());
    // create_new prevents accidentally relabelling or replacing original evidence.
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&args[1])?;
    serde_json::to_writer(&mut file, &output)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}
fn main() {
    if let Err(e) = run() { eprintln!("exact-route capture FAILED (no qualified output): {e}"); std::process::exit(1); }
}
