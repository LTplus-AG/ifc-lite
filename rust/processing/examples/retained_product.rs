// SPDX-License-Identifier: MPL-2.0
//! Explicit native construction transaction; never publishes a partial product.
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{GeometryRouter, MaterialLayerIndex};
use ifc_lite_geometry_runtime::{MeshLimits, SmlibWorker};
use ifc_lite_processing::{
    element::*,
    prepass::{resolve_prepass, PrepassSpans, ResolveOptions},
};
use std::sync::Arc;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("pass an IFC path and product id")?;
    let id: u32 = std::env::args()
        .nth(2)
        .ok_or("pass a product id")?
        .parse()?;
    let content = std::fs::read(path)?;
    let text = std::str::from_utf8(&content)?;
    let mut spans = PrepassSpans::default();
    let source = SourceBundle::scan_with(Arc::new(content.clone()), |id, name, start, end| {
        spans.stash(name, id, start, end);
    });
    let mut decoder = source.decoder();
    let mut router = GeometryRouter::with_units(text, &mut decoder);
    let layers = MaterialLayerIndex::from_content(&content, &mut decoder);
    router.set_material_layer_index(Arc::new(layers));
    let prepass = resolve_prepass(&spans, &mut decoder, ResolveOptions::default());
    let context = ProductionModel::from_source(source.clone()).snapshot(OwnedMeshProductionData {
        void_index: Arc::new(prepass.void_index),
        geometry_style_index: Arc::new(prepass.geometry_style_index),
        indexed_colour_full: Arc::new(prepass.indexed_colour_full),
        element_material_colors: Arc::new(prepass.element_material_colors),
        ..Default::default()
    });
    let entity = decoder.decode_by_id(id)?;
    let job = ElementMeshJob {
        id,
        ifc_type: entity.ifc_type.clone(),
        entity: &entity,
        kind: ElementJobKind::Product,
        element_color: None,
        metadata: None,
    };
    let mut execution = RetainedProductExecution::begin(
        &job,
        &context,
        &MeshProductionOptions::default(),
        &mut decoder,
        &router,
    )?;
    let executable = std::env::var_os("IFCLITE_SMLIB_WORKER").ok_or("set IFCLITE_SMLIB_WORKER")?;
    let mut worker = SmlibWorker::spawn(executable)?;
    while let Some(issued) = execution.issue_next(&mut decoder, &router, &worker)? {
        let completed = issued.execute(&mut worker, 0.001, 15., MeshLimits::default())?;
        execution
            .accept(completed, &mut decoder, &router)
            .map_err(|e| e.reason)?;
    }
    let witness = execution.into_witness()?;
    witness.validate()?;
    println!(
        "{}",
        serde_json::json!({"contract":"common_product_transaction_only",
        "discharged_operations":witness.discharged_count(), "occurrences":witness.plan().values.len(),
        "presentation_bindings":witness.plan().values.iter().map(|value| value.presentation().iter().map(|binding|
            serde_json::json!({"geometry_id":binding.geometry_id,"style_source_id":binding.style_source_id,
                "representation_map":binding.representation_map,"template":binding.template,"placeholder":binding.placeholder,
                "indexed_palette_pending":binding.indexed_palette_pending,
                "texture_pending":binding.texture_pending.as_ref().map(|texture|texture.texture_id)}))
            .collect::<Vec<_>>()).collect::<Vec<_>>(),
        "remaining":witness.plan().remaining.iter().map(|r| format!("{r:?}")).collect::<Vec<_>>(),
        "final_product_available":false})
    );
    Ok(())
}
