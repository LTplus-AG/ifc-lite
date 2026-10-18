// SPDX-License-Identifier: MPL-2.0
//! Inspect raw item coverage, then evaluate owned constructions after dropping
//! IFC bytes. This does not publish final product geometry.
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    let path = arguments.next().ok_or("usage: construction_batch model.ifc ITEM_ID ...")?;
    let roots = arguments.map(|id| id.parse::<u32>()).collect::<Result<Vec<_>, _>>()?;
    if roots.is_empty() { return Err("at least one raw representation-item ID is required".into()); }
    let batch = {
        let content = std::fs::read_to_string(path)?;
        GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&content), &roots, 4096)?
    };
    for node in batch.nodes() {
        println!("item={} family={:?} requirement={:?}", node.source_id(), node.family(), node.requirement());
    }
    let evaluated = batch.evaluate()?;
    println!("definitions={} occurrences={} triangles={} diagnostics={}", evaluated.definitions.len(),
        evaluated.occurrences.len(), evaluated.definitions.iter().map(|mesh| mesh.indices.len() / 3).sum::<usize>(),
        evaluated.diagnostics.iter().map(Vec::len).sum::<usize>());
    println!("observed_failures={} reports={:?}", evaluated.observed_diagnostics.len(), evaluated.reports);
    Ok(())
}
