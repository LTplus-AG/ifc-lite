// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Geometry oracle for `scripts/cache-native-conformance.mjs` (#9584): dumps
//! what the canonical `ifc_lite_processing::process` emits for one IFC, so the
//! script can compare the meshes the TS reader decodes from the native cache
//! against the pipeline's own output rather than against the writer's.
//!
//! Deliberately independent of the writer: this uses no `ifc_lite_cache` item
//! and applies no frame conversion. Everything is dumped exactly as the
//! pipeline emits it (IFC Z-up, the pass's own frame), in the sink's event
//! order: `on_finishes` before the `on_batch` it belongs to, and
//! `on_color_update` where the pass sends it. The script does the documented
//! Z-up to Y-up conversion itself.
//!
//! The request is the pass the cache is defined over (crate docs): one full
//! pass, material-layer slicing on, finishes on, the first-frame property and
//! presentation-layer resolution off.
//!
//! Beside it, `streamMeta` is the load-time metadata the browser pre-pass
//! publishes for the same file (`stream_meta::resolve_stream_meta` +
//! `resolve_site_origin`, the single homes of `lengthUnitScale`,
//! `siteOrigin` and `buildingRotation` on that path), so the cache's
//! CoordinateInfo is checked against the producer the browser reads, not
//! against the writer's own derivation.
//!
//! Floats are written as little-endian hex so every bit (NaN payloads, -0)
//! survives JSON.
//!
//!   cargo run -p ifc-lite-cache --example processing_oracle -- <in.ifc> <out.json>

use std::fmt::Write as _;

use ifc_lite_core::{build_entity_index, find_project_id, EntityDecoder, EntityScanner};
use ifc_lite_processing::stream_meta::{resolve_site_origin, resolve_stream_meta, MetaMode};
use ifc_lite_processing::style::SpecularMaterial;
use ifc_lite_processing::{process, MeshData, ProcessingRequest, ProcessingSink};

fn hex(bytes: impl IntoIterator<Item = u8>) -> String {
    let mut out = String::new();
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    format!("\"{out}\"")
}

fn f32s(values: &[f32]) -> String {
    hex(values.iter().flat_map(|v| v.to_le_bytes()))
}

fn f64s(values: &[f64]) -> String {
    hex(values.iter().flat_map(|v| v.to_le_bytes()))
}

fn opt<T>(value: Option<T>, encode: impl FnOnce(T) -> String) -> String {
    value.map_or_else(|| "null".to_owned(), encode)
}

fn mesh_json(mesh: &MeshData) -> String {
    format!(
        "{{\"expressId\":{},\"ifcType\":{},\"geometryClass\":{},\"geometryItemId\":{},\"materialId\":{},\
\"color\":{},\"origin\":{},\"positions\":{},\"normals\":{},\"indices\":{},\"localBounds\":{},\"localToWorld\":{},\
\"unencoded\":{{\"globalId\":{},\"name\":{},\"presentationLayer\":{},\"materialName\":{},\"properties\":{},\
\"uvs\":{},\"texture\":{},\"instance\":{},\"presentation\":{}}}}}",
        mesh.express_id,
        hex(mesh.ifc_type.bytes()),
        mesh.geometry_class,
        opt(mesh.geometry_item_id, |v| v.to_string()),
        opt(mesh.material_id, |v| v.to_string()),
        f32s(&mesh.color),
        f64s(&mesh.origin),
        f32s(&mesh.positions),
        f32s(&mesh.normals),
        hex(mesh.indices.iter().flat_map(|v| v.to_le_bytes())),
        opt(mesh.local_bounds, |b| f32s(&b)),
        opt(mesh.local_to_world, |m| f64s(&m)),
        mesh.global_id.is_some(),
        mesh.name.is_some(),
        mesh.presentation_layer.is_some(),
        mesh.material_name.is_some(),
        mesh.properties.is_some(),
        mesh.uvs.is_some(),
        mesh.texture.is_some(),
        mesh.instance.is_some(),
        mesh.presentation.is_some(),
    )
}

/// The sink's events, as JSON array items, in arrival order.
#[derive(Default)]
struct Events(Vec<String>);

impl ProcessingSink for Events {
    fn on_batch(&mut self, meshes: &[MeshData], _processed: usize, _total: usize) {
        let items: Vec<String> = meshes.iter().map(mesh_json).collect();
        self.0.push(format!("{{\"event\":\"batch\",\"meshes\":[{}]}}", items.join(",")));
    }

    fn on_color_update(&mut self, updates: &[(u32, [f32; 4])]) {
        let items: Vec<String> = updates.iter().map(|(id, rgba)| format!("[{id},{}]", f32s(rgba))).collect();
        self.0.push(format!("{{\"event\":\"colorUpdate\",\"updates\":[{}]}}", items.join(",")));
    }

    fn on_finishes(&mut self, finishes: &[Option<SpecularMaterial>]) {
        let items: Vec<String> = finishes
            .iter()
            .map(|finish| {
                opt(finish.as_ref(), |f| {
                    format!(
                        "{{\"metallic\":{},\"roughness\":{}}}",
                        opt(f.metallic, |v| f32s(&[v])),
                        opt(f.roughness, |v| f32s(&[v]))
                    )
                })
            })
            .collect();
        self.0.push(format!("{{\"event\":\"finishes\",\"finishes\":[{}]}}", items.join(",")));
    }
}

/// `StreamMeta` + `siteOrigin` as the browser's single-pass pre-pass resolves
/// them: full index, the project and the first `IfcSite` in file order.
fn stream_meta_json(source: &[u8]) -> String {
    let mut scanner = EntityScanner::new(source);
    let mut site = None;
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name.eq_ignore_ascii_case("IFCSITE") {
            site = Some((id, start, end));
            break;
        }
    }
    let mut decoder = EntityDecoder::with_index(source, build_entity_index(source));
    let meta = resolve_stream_meta(MetaMode::SmallFileSingle, source, find_project_id(source), site, &mut decoder);
    let site_origin = resolve_site_origin(&meta, site, &mut decoder);
    let (x, y, z) = meta.frame.rtc_offset();
    format!(
        "{{\"lengthUnitScale\":{},\"lengthUnitRefused\":{},\"rtcOffset\":{},\"needsShift\":{},\
\"buildingRotation\":{},\"siteOrigin\":{}}}",
        f64s(&[meta.length_unit_scale]),
        meta.length_unit_refused.is_some(),
        f64s(&[x, y, z]),
        meta.frame.needs_shift(),
        opt(meta.building_rotation, |v| f64s(&[v])),
        opt(site_origin, |o| f64s(&o)),
    )
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [input, output] = args.as_slice() else {
        eprintln!("usage: processing_oracle <in.ifc> <out.json>");
        std::process::exit(2);
    };
    let source = std::fs::read(input).unwrap_or_else(|error| panic!("read {input}: {error}"));
    let features = ifc_lite_processing::Features::default()
        .properties(false)
        .presentation_layers(false)
        .finishes(true);
    let request = ProcessingRequest::full_pass()
        .layer_slicing(true)
        .retain_meshes(true)
        .features(features);
    let mut events = Events::default();
    let result = process(&source, &request, &mut events);

    let frame = result.frame;
    let (x, y, z) = frame.rtc_offset();
    let metadata = &result.metadata;
    let json = format!(
        "{{\"schemaVersion\":{},\"entityCount\":{},\"retainedMeshes\":{},\"instances\":{},\
\"frame\":{{\"rtcOffset\":{},\"needsShift\":{},\"worldMatrix\":{}}},\
\"originShift\":{},\"isGeoReferenced\":{},\"lengthUnitScale\":{},\"lengthUnitRefused\":{},\
\"siteTransform\":{},\"buildingTransform\":{},\"georeferencing\":{},\"streamMeta\":{},\"events\":[{}]}}",
        hex(ifc_lite_processing::detect_schema_version(&source).bytes()),
        metadata.entity_count,
        result.meshes.len(),
        result.instances.len(),
        f64s(&[x, y, z]),
        frame.needs_shift(),
        f64s(&frame.world_matrix()),
        f64s(&metadata.coordinate_info.origin_shift),
        metadata.coordinate_info.is_geo_referenced,
        opt(metadata.length_unit_scale, |v| f64s(&[v])),
        opt(metadata.length_unit_refused, |v| v.to_string()),
        opt(result.site_transform.as_deref(), f64s),
        opt(result.building_transform.as_deref(), f64s),
        metadata.georeferencing.is_some(),
        stream_meta_json(&source),
        events.0.join(","),
    );
    std::fs::write(output, json).unwrap_or_else(|error| panic!("write {output}: {error}"));
}
