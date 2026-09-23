// SPDX-License-Identifier: MPL-2.0
// Diagnostic-only opportunity census; no timing claim.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path)?;
        let result = ifc_lite_processing::process_geometry(&bytes);
        println!("{}", serde_json::json!({
            "path":path, "meshes":result.meshes.len(),
            "bool2d":ifc_lite_geometry::take_bool2d_stats(),
            "prism":ifc_lite_geometry::take_prism_stats(),
            "prismDefers":ifc_lite_geometry::take_prism_defers(),
            "csgOps":ifc_lite_geometry::csg::take_csg_census().len(),
        }));
    }
    Ok(())
}
