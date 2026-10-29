// SPDX-License-Identifier: MPL-2.0
//! #7955: drive exact's canonical producer with the rich material-key map used
//! by retained and the browser layer path, without an SMLib or retained call.
use ifc_lite_core::{EntityScanner, IfcType, SourceBundle};
use ifc_lite_geometry::{GeometryRouter, MaterialLayerIndex};
use ifc_lite_processing::{element::*, prepass::*, style::*};
use std::sync::Arc;

pub fn produce(text: &str) -> Vec<ifc_lite_processing::MeshData> {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(source.bytes());
    while let Some((id, name, start, end)) = scanner.next_entity() { spans.stash(name, id, start, end); }
    let mut resolved = resolve_prepass(&spans, &mut decoder, Default::default());
    let styles = build_material_style_index(&resolved.material_def_reprs, &resolved.orphan_styled_items, &mut decoder);
    for (material, color) in flatten_material_color_index(&styles) {
        // Read the selected source style's name; do not author an expected name
        // into exact's input. These fixtures have one surface style per material.
        let mut material_name = None;
        for repr in &resolved.material_def_reprs[&material] {
            for item in decoder.decode_by_id(*repr).unwrap().get_refs(3).unwrap() {
                for style in decoder.decode_by_id(item).unwrap().get_refs(1).unwrap() {
                    let style = decoder.decode_by_id(style).unwrap();
                    assert_eq!(style.ifc_type, IfcType::IfcSurfaceStyle);
                    material_name = style.get_string(0).map(str::to_owned);
                }
            }
        }
        resolved.geometry_style_index.insert(material, GeometryStyleInfo { color, shading_color: None, material_name });
    }
    let fallback = element_material_fallback_color(&resolved.element_material_colors[&22]).unwrap();
    let model = ProductionModel::from_source(source.clone()).snapshot(OwnedMeshProductionData {
        geometry_style_index: Arc::new(resolved.geometry_style_index),
        element_material_colors: Arc::new(resolved.element_material_colors),
        ..Default::default()
    });
    let mut router = GeometryRouter::with_units(source.bytes(), &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    router.set_material_layer_index(Arc::new(MaterialLayerIndex::from_content(source.bytes(), &mut decoder)));
    let entity = decoder.decode_by_id(22).unwrap();
    let job = ElementMeshJob { id: 22, ifc_type: IfcType::IfcWall, entity: &entity,
        kind: ElementJobKind::Product, element_color: Some(fallback), metadata: None };
    produce_element_meshes(&job, &model.borrowed(), &Default::default(), &mut decoder, &router).meshes
}
