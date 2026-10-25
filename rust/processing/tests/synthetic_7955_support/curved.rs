// SPDX-License-Identifier: MPL-2.0
use super::*;

/// The current exact layer implementation constructs placement-axis planes,
/// not radial bands. Report material membership honestly, without interpreting
/// a total-volume pass as successful curved layer decomposition.
pub fn report_layer_observation(result: &ProcessingResult, oracle: &Value) {
    let id = integer(&oracle["products"][0]["id"]);
    let mut groups: BTreeMap<Option<u32>, Vec<&MeshData>> = BTreeMap::new();
    for mesh in result.meshes.iter().filter(|m| m.express_id == id) {
        groups.entry(mesh.material_id).or_default().push(mesh);
    }
    let observed: Vec<_> = groups
        .iter()
        .map(|(material, meshes)| {
            serde_json::json!({"material_id":material, "mesh_count":meshes.len(),
            "signed_volume":volume(meshes),
            "geometry_classes":meshes.iter().map(|m|m.geometry_class).collect::<BTreeSet<_>>()})
        })
        .collect();
    eprintln!(
        "LAYER_DECOMPOSITION_OBSERVATION {}",
        serde_json::json!({
            "host":id, "observed":observed,
            "retained_only_oracle_not_asserted":oracle["layer_decomposition"]
        })
    );
}

/// Independent polar integration, rather than the generator's Cartesian
/// antiderivative. This checks the analytic oracle, not material decomposition.
pub fn check_analytic_band_sum(oracle: &Value) {
    let span = number(&oracle["angular_span_radians"]);
    let height = number(&oracle["height"]);
    let half_width = number(&oracle["opening_bounds"][1][1]);
    let cut_height = number(&oracle["opening_bounds"][1][2]);
    let integrate = |a: f64, b: f64| {
        let count = 256_u32;
        let dr = (b - a) / f64::from(count);
        let density = |r: f64| 2. * r * (half_width / r).asin();
        let mut sum = density(a) + density(b);
        for i in 1..count {
            sum += (if i.is_multiple_of(2) { 2. } else { 4. }) * density(a + f64::from(i) * dr);
        }
        cut_height * sum * dr / 3.
    };
    let bands = oracle["bands"].as_array().unwrap();
    assert_eq!(bands.len(), 3);
    let mut sum_before = 0.;
    let mut sum_after = 0.;
    for band in bands {
        let a = number(&band["inner_radius"]);
        let b = number(&band["outer_radius"]);
        let before = height * span * (b * b - a * a) / 2.;
        let after = before - integrate(a, b);
        // Arithmetic consistency of two analytic methods; not mesh acceptance.
        assert!((before - number(&band["before"])).abs() < 1e-9);
        assert!((after - number(&band["after"])).abs() < 1e-9);
        sum_before += before;
        sum_after += after;
    }
    let a = number(&bands[0]["inner_radius"]);
    let b = number(&bands[2]["outer_radius"]);
    let full_before = height * span * (b * b - a * a) / 2.;
    let full_after = full_before - integrate(a, b);
    assert!((sum_before - full_before).abs() < 1e-9);
    assert!((sum_after - full_after).abs() < 1e-9);
    assert!((full_before - number(&oracle["before_total"])).abs() < 1e-9);
    assert!((full_after - number(&oracle["after_total"])).abs() < 1e-9);
}

/// Verify actual cut faces at the two jambs and lintel, then the full cutter
/// box bounds. Curved radial edges are tessellated, so do NOT compare them to
/// analytic circle intersections at the tighter planar-coordinate tolerance.
pub fn check_curved_door(result: &ProcessingResult, oracle: &Value) -> Result<(), String> {
    let tolerance = tolerance("position_absolute");
    let bounds = &oracle["opening_bounds"];
    let planes = [
        (1, number(&bounds[0][1]), 1.),
        (1, number(&bounds[1][1]), -1.),
        (2, number(&bounds[1][2]), -1.),
    ];
    for row in oracle["products"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["cut"] == true)
    {
        let id = integer(&row["id"]);
        let translation = vector(&row["translation"]);
        let mut found = [false; 3];
        for mesh in result.meshes.iter().filter(|m| m.express_id == id) {
            for triangle in mesh.indices.chunks_exact(3) {
                let points = [triangle[0], triangle[1], triangle[2]]
                    .map(|i| sub(position(mesh, i), translation));
                let normal = cross(sub(points[1], points[0]), sub(points[2], points[0]));
                for (i, (axis, coordinate, sign)) in planes.iter().enumerate() {
                    if normal[*axis] * sign > 0.
                        && points
                            .iter()
                            .all(|p| (p[*axis] - coordinate).abs() <= tolerance)
                    {
                        found[i] = true;
                    }
                }
            }
        }
        check(
            found.into_iter().all(|p| p),
            format!("curved door cut planes #{id}: {found:?}"),
        )?;
        let opening = integer(&row["opening_id"]);
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for mesh in result.meshes.iter().filter(|m| m.express_id == opening) {
            for i in 0..mesh.positions.len() / 3 {
                let p = sub(position(mesh, i as u32), translation);
                for k in 0..3 {
                    min[k] = min[k].min(p[k]);
                    max[k] = max[k].max(p[k]);
                }
            }
        }
        for k in 0..3 {
            check(
                (min[k] - number(&bounds[0][k])).abs() <= tolerance
                    && (max[k] - number(&bounds[1][k])).abs() <= tolerance,
                format!("curved door cutter bounds #{opening} axis {k}"),
            )?;
        }
    }
    Ok(())
}
