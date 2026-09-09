// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Read-only native geometry evidence for occurrence appearance conversion.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() >= 3, "Usage: evaluated_policy_probe <ifc> <product-id>...");
    let content = std::fs::read(&args[1]).expect("read IFC");
    let ids: Vec<u32> = args[2..].iter().map(|s| s.parse().expect("product id")).collect();
    let result = ifc_lite_processing::process_geometry(&content);
    let meshes: Vec<_> = result.meshes.iter().filter(|mesh| ids.contains(&mesh.express_id)).collect();
    println!("{}", serde_json::to_string(&meshes).expect("serialize meshes"));
}
