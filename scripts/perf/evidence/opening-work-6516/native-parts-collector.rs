fn main() {
    let args: Vec<String> = std::env::args().collect();
    let content = std::fs::read(&args[1]).expect("read public fixture");
    let result = ifc_lite_processing::process_geometry(&content);
    let capture = serde_json::json!({
        "entryPoint": "ifc_lite_processing::process_geometry (default options; same as perf_probe)",
        "frame": format!("{:?}", result.frame),
        "coordinateSpace": result.mesh_coordinate_space,
        "siteTransform": result.site_transform,
        "buildingTransform": result.building_transform,
        "metadata": result.metadata,
        "meshes": result.meshes,
    });
    std::fs::write(&args[2], serde_json::to_vec(&capture).expect("serialize capture")).expect("write capture");
}
