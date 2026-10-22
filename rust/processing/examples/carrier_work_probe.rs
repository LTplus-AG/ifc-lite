// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7714 per-product output qualification on the canonical native load path.
//! This is a diagnostic, not a timing or physical-GPU performance cohort.
//! Usage: carrier_work_probe <input.ifc>

#[path = "perf_probe/fingerprint.rs"]
mod fingerprint;

use ifc_lite_processing::process_geometry;
use serde_json::json;
use std::{collections::BTreeMap, error::Error};

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("Usage: carrier_work_probe <input.ifc>")?;
    let content = std::fs::read(path)?;
    let result = process_geometry(&content);
    let mut per_product = BTreeMap::new();
    for mesh in &result.meshes {
        per_product
            .entry(mesh.express_id)
            .or_insert_with(Vec::new)
            .push(json!({
                "item": mesh.geometry_item_id,
                "vertices": mesh.positions.len() / 3,
                "triangles": mesh.indices.len() / 3,
                "fingerprint": fingerprint::mesh_fingerprint(std::slice::from_ref(mesh)),
            }));
    }
    println!(
        "{}",
        serde_json::to_string(&json!({
            "scope": "canonical process_geometry, per-product ordered geometry payload; not timing",
            "fingerprint": fingerprint::mesh_fingerprint(&result.meshes),
            "products": per_product,
            "csgFailures": result.stats.total_csg_failures,
            "productsWithFailures": result.stats.products_with_failures,
            "diagnostics": result.stats.geometry_diagnostics,
        }))?
    );
    Ok(())
}
