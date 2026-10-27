// SPDX-License-Identifier: MPL-2.0
use super::metrics::{transform, Metrics};
use ifc_lite_retained_native::ShapeOnlyProduct;
pub fn measured(product: &ShapeOnlyProduct) -> Metrics {
    let mut actual = Metrics::default();
    for part in &product.parts {
        let points: Vec<_> = part
            .positions
            .chunks_exact(3)
            .map(|p| transform(&part.world_from_object, [p[0], p[1], p[2]]))
            .collect();
        actual.add_mesh(&points, &part.indices).unwrap();
    }
    actual
}
pub fn exact_bounds(text: &str, id: u32) -> [f64; 6] {
    let exact = ifc_lite_processing::process_geometry(text.as_bytes());
    let mut actual = Metrics::default();
    let mut found = false;
    for mesh in exact.meshes.iter().filter(|m| m.express_id == id) {
        found = true;
        let points: Vec<_> = mesh
            .positions
            .chunks_exact(3)
            .map(|p| {
                exact.frame.to_world([
                    mesh.origin[0] + p[0] as f64,
                    mesh.origin[1] + p[1] as f64,
                    mesh.origin[2] + p[2] as f64,
                ])
            })
            .collect();
        actual.add_mesh(&points, &mesh.indices).unwrap();
    }
    assert!(found, "missing exact product {id}");
    actual.bbox
}
pub fn assert_geometry(product: &ShapeOnlyProduct, volume: f64, bounds: Option<[f64; 6]>) {
    let actual = measured(product);
    assert!(
        (actual.volume - volume).abs() <= volume * 1e-6,
        "{actual:?}, expected volume {volume}"
    );
    assert_eq!(actual.defects, 0, "{actual:?}");
    if let Some(bounds) = bounds {
        assert!(
            super::metrics::bbox_deviation(&actual.bbox, &bounds) <= 1e-4,
            "actual {:?}, expected {bounds:?}",
            actual.bbox
        );
    }
}
