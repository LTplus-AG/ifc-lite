// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! End-to-end production void-cut test.
//!
//! This test mimics the *exact* path that `IfcAPI::process_geometry_batch`
//! exercises in production:
//!   1. Parse the IFC bytes
//!   2. Build `void_index` from `IfcRelVoidsElement` (no manual ID injection)
//!   3. Drive each host element through `process_element_with_voids`
//!   4. Ray-cast through the opening footprint along the wall thickness axis
//!      to assert the wall actually has a hole. A SOLID UNCUT wall fails.
//!
//! Two fixtures are checked — both are reported regression cases:
//!   - `tests/models/various/issue-604-door.ifc` (issue #604, PR #605 head)
//!   - `tests/models/ara3d/AC-20-Smiley-West-10-Bldg.ifc` (issue #584)
//!
//! These tests are gated on the fixtures being present so CI without
//! large model downloads does not flake.

use ifc_lite_core::{EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::fs;
use std::path::PathBuf;

/// Resolve a fixture path relative to the workspace root.
fn fixture_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(relative)
}

/// Load a fixture if present; return `None` so callers can skip gracefully.
fn load_fixture(relative: &str) -> Option<String> {
    let path = fixture_path(relative);
    fs::read_to_string(&path).ok()
}

/// Find the express ID of an entity by GUID (attribute index 0).
fn find_entity_by_guid(content: &str, guid: &str) -> Option<u32> {
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, _type_name, start, end)) = scanner.next_entity() {
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            if let Some(attr) = entity.get(0) {
                if let Some(g) = attr.as_string() {
                    if g == guid {
                        return Some(id);
                    }
                }
            }
        }
    }
    None
}

/// Build the void index the same way production does in
/// `process_geometry_batch` and `build_pre_pass_streaming`.
fn build_void_index_like_production(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    // Combined (non-streaming) path also propagates to parts, so we
    // mirror that. The streaming path SKIPS this — we run both modes.
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

/// Ray-triangle intersection (Möller–Trumbore).
fn ray_hits_triangle(
    ray_origin: [f32; 3],
    ray_dir: [f32; 3],
    v0: [f32; 3],
    v1: [f32; 3],
    v2: [f32; 3],
) -> Option<f32> {
    let edge1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    let edge2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    let h = [
        ray_dir[1] * edge2[2] - ray_dir[2] * edge2[1],
        ray_dir[2] * edge2[0] - ray_dir[0] * edge2[2],
        ray_dir[0] * edge2[1] - ray_dir[1] * edge2[0],
    ];
    let a = edge1[0] * h[0] + edge1[1] * h[1] + edge1[2] * h[2];
    if a.abs() < 1e-7 {
        return None;
    }
    let f = 1.0 / a;
    let s = [
        ray_origin[0] - v0[0],
        ray_origin[1] - v0[1],
        ray_origin[2] - v0[2],
    ];
    let u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = [
        s[1] * edge1[2] - s[2] * edge1[1],
        s[2] * edge1[0] - s[0] * edge1[2],
        s[0] * edge1[1] - s[1] * edge1[0],
    ];
    let v = f * (ray_dir[0] * q[0] + ray_dir[1] * q[1] + ray_dir[2] * q[2]);
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = f * (edge2[0] * q[0] + edge2[1] * q[1] + edge2[2] * q[2]);
    if t > 1e-5 {
        Some(t)
    } else {
        None
    }
}

/// Count how many wall triangles a ray pierces. A perfectly cut wall
/// at the opening footprint should return 0.
fn count_ray_hits(mesh: &Mesh, ray_origin: [f32; 3], ray_dir: [f32; 3]) -> usize {
    let mut hits = 0;
    for tri in mesh.indices.chunks_exact(3) {
        let i0 = tri[0] as usize * 3;
        let i1 = tri[1] as usize * 3;
        let i2 = tri[2] as usize * 3;
        if i0 + 2 >= mesh.positions.len()
            || i1 + 2 >= mesh.positions.len()
            || i2 + 2 >= mesh.positions.len()
        {
            continue;
        }
        let v0 = [
            mesh.positions[i0],
            mesh.positions[i0 + 1],
            mesh.positions[i0 + 2],
        ];
        let v1 = [
            mesh.positions[i1],
            mesh.positions[i1 + 1],
            mesh.positions[i1 + 2],
        ];
        let v2 = [
            mesh.positions[i2],
            mesh.positions[i2 + 1],
            mesh.positions[i2 + 2],
        ];
        if ray_hits_triangle(ray_origin, ray_dir, v0, v1, v2).is_some() {
            hits += 1;
        }
    }
    hits
}

/// Compute the AABB of an opening as seen by the production void path —
/// `process_element` on the opening then take its bounds.
fn opening_world_aabb(
    router: &GeometryRouter,
    opening_id: u32,
    decoder: &mut EntityDecoder,
) -> Option<([f32; 3], [f32; 3])> {
    let opening = decoder.decode_by_id(opening_id).ok()?;
    let mesh = router.process_element(&opening, decoder).ok()?;
    if mesh.is_empty() {
        return None;
    }
    let (min, max) = mesh.bounds();
    Some(([min.x, min.y, min.z], [max.x, max.y, max.z]))
}

/// Cast a 3×3 grid of rays through the opening footprint along the wall's
/// thickness axis. The thickness axis is whichever wall AABB axis has
/// the smallest extent. Returns the total number of wall-triangle hits
/// across the 9 rays. A correctly cut wall returns 0.
fn count_hits_through_opening(
    wall_mesh: &Mesh,
    opening_min: [f32; 3],
    opening_max: [f32; 3],
) -> usize {
    let (wall_min, wall_max) = wall_mesh.bounds();
    let extents = [
        wall_max.x - wall_min.x,
        wall_max.y - wall_min.y,
        wall_max.z - wall_min.z,
    ];
    // Thickness axis = smallest wall extent.
    let mut thickness_axis = 0;
    for i in 1..3 {
        if extents[i] < extents[thickness_axis] {
            thickness_axis = i;
        }
    }

    // Pick the two non-thickness axes for the 3×3 grid inside the opening.
    let grid_axes: [usize; 2] = match thickness_axis {
        0 => [1, 2],
        1 => [0, 2],
        _ => [0, 1],
    };
    // Inset by 10% on each side so we sample inside the opening interior.
    let inset = 0.10;
    let lo_a = opening_min[grid_axes[0]] + inset
        * (opening_max[grid_axes[0]] - opening_min[grid_axes[0]]);
    let hi_a = opening_max[grid_axes[0]] - inset
        * (opening_max[grid_axes[0]] - opening_min[grid_axes[0]]);
    let lo_b = opening_min[grid_axes[1]] + inset
        * (opening_max[grid_axes[1]] - opening_min[grid_axes[1]]);
    let hi_b = opening_max[grid_axes[1]] - inset
        * (opening_max[grid_axes[1]] - opening_min[grid_axes[1]]);

    // Cast from outside the wall on the negative thickness side, towards
    // the positive side. Wall extent + slack ensures we start outside.
    let slack = 1.0;
    let mut origin = [0f32, 0f32, 0f32];
    origin[thickness_axis] = match thickness_axis {
        0 => wall_min.x - slack,
        1 => wall_min.y - slack,
        _ => wall_min.z - slack,
    };
    let mut dir = [0f32, 0f32, 0f32];
    dir[thickness_axis] = 1.0;

    let mut total_hits = 0;
    for ai in 0..3 {
        let a = lo_a + (hi_a - lo_a) * (ai as f32 / 2.0);
        for bi in 0..3 {
            let b = lo_b + (hi_b - lo_b) * (bi as f32 / 2.0);
            origin[grid_axes[0]] = a;
            origin[grid_axes[1]] = b;
            total_hits += count_ray_hits(wall_mesh, origin, dir);
        }
    }
    total_hits
}

/// Drive a single host wall through the production code path
/// (`process_element_with_voids`) and return the resulting mesh.
fn process_host_like_production(
    content: &str,
    host_id: u32,
    void_index: &FxHashMap<u32, Vec<u32>>,
) -> Option<Mesh> {
    use ifc_lite_core::build_entity_index;
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let entity = decoder.decode_by_id(host_id).ok()?;
    let router = GeometryRouter::with_scale(1.0);
    router
        .process_element_with_voids(&entity, &mut decoder, void_index)
        .ok()
}

/// Reproducer for issue #604 — a single-wall fixture with a single door.
#[test]
fn door_604_wall_55_has_a_hole() {
    let content = match load_fixture("tests/models/various/issue-604-door.ifc") {
        Some(c) => c,
        None => {
            eprintln!("door.ifc fixture missing — skipping production void test");
            return;
        }
    };

    let void_index = build_void_index_like_production(&content);
    assert!(
        void_index.contains_key(&55),
        "wall #55 should be in void_index built from IfcRelVoidsElement"
    );
    let opening_ids = void_index.get(&55).unwrap().clone();
    assert_eq!(opening_ids, vec![2438], "expected opening #2438 for wall #55");

    let wall_mesh = process_host_like_production(&content, 55, &void_index)
        .expect("wall #55 should produce a mesh");
    assert!(
        !wall_mesh.is_empty(),
        "wall #55 produced an empty mesh — pre-existing regression"
    );

    // Compute the opening AABB through the production opening path.
    use ifc_lite_core::build_entity_index;
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_scale(1.0);
    let (op_min, op_max) = opening_world_aabb(&router, 2438, &mut decoder)
        .expect("opening #2438 should produce a mesh + bounds");

    let hits = count_hits_through_opening(&wall_mesh, op_min, op_max);
    assert_eq!(
        hits, 0,
        "wall #55 still has triangles inside opening #2438 footprint — \
         void cut was NOT applied. wall_tris={} opening_aabb=[{:?}..{:?}]",
        wall_mesh.triangle_count(),
        op_min,
        op_max,
    );
}

/// Reproducer for issue #584 — the user's host wall in Smiley-West.
/// The user's wall GUID `0NQVcwUgj2fup5UuFaDTfC` maps to express ID #137010
/// with two voids (#137081, #137149).
#[test]
fn smiley_584_wall_0nqvcw_has_holes() {
    let content =
        match load_fixture("tests/models/ara3d/AC-20-Smiley-West-10-Bldg.ifc") {
            Some(c) => c,
            None => {
                eprintln!(
                    "AC-20-Smiley-West-10-Bldg.ifc fixture missing — \
                     skipping production void test"
                );
                return;
            }
        };

    let host_id = find_entity_by_guid(&content, "0NQVcwUgj2fup5UuFaDTfC")
        .expect("user's host wall GUID should be present in Smiley-West");

    let void_index = build_void_index_like_production(&content);
    let opening_ids = void_index
        .get(&host_id)
        .cloned()
        .expect("user's host wall must have voids in IfcRelVoidsElement scan");
    assert!(
        !opening_ids.is_empty(),
        "user's host wall should have at least one opening in IfcRelVoidsElement"
    );

    let wall_mesh = process_host_like_production(&content, host_id, &void_index)
        .expect("user's host wall should produce a mesh");
    assert!(
        !wall_mesh.is_empty(),
        "user's host wall produced an empty mesh — pre-existing regression"
    );

    // Check every opening has a hole.
    use ifc_lite_core::build_entity_index;
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_scale(1.0);

    let mut total_hits = 0usize;
    let mut checked = 0usize;
    for &opening_id in &opening_ids {
        let (op_min, op_max) = match opening_world_aabb(&router, opening_id, &mut decoder) {
            Some(b) => b,
            None => continue,
        };
        let hits = count_hits_through_opening(&wall_mesh, op_min, op_max);
        eprintln!(
            "  opening #{}: {} ray-hits inside footprint",
            opening_id, hits
        );
        total_hits += hits;
        checked += 1;
    }
    assert!(checked > 0, "no opening footprints could be sampled");
    assert_eq!(
        total_hits, 0,
        "wall (express #{}) still has triangles inside opening footprints — \
         void cut was NOT applied. wall_tris={} openings={:?}",
        host_id,
        wall_mesh.triangle_count(),
        opening_ids,
    );
}

/// Sweep ALL host walls in Smiley-West and report how many fail the
/// "wall has a hole" test. This is the production-coverage canary —
/// PR #626's "0 fallbacks" claim should mean `failed == 0` here.
#[test]
fn smiley_584_all_host_walls_have_holes() {
    let content =
        match load_fixture("tests/models/ara3d/AC-20-Smiley-West-10-Bldg.ifc") {
            Some(c) => c,
            None => {
                eprintln!(
                    "AC-20-Smiley-West-10-Bldg.ifc fixture missing — \
                     skipping production void sweep"
                );
                return;
            }
        };

    let void_index = build_void_index_like_production(&content);
    use ifc_lite_core::build_entity_index;
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_scale(1.0);

    let mut total_hosts = 0usize;
    let mut failed_hosts: Vec<(u32, usize, usize)> = Vec::new();
    let mut empty_meshes = 0usize;
    let mut skipped_no_opening_mesh = 0usize;

    for (&host_id, opening_ids) in void_index.iter() {
        let entity = match decoder.decode_by_id(host_id) {
            Ok(e) => e,
            Err(_) => continue,
        };
        // Only process host elements with their own representation; the
        // production code does the same gate.
        let has_repr = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
        if !has_repr {
            continue;
        }
        total_hosts += 1;

        let wall_mesh = match router.process_element_with_voids(&entity, &mut decoder, &void_index)
        {
            Ok(m) => m,
            Err(_) => continue,
        };
        if wall_mesh.is_empty() {
            empty_meshes += 1;
            continue;
        }

        let mut host_total_hits = 0usize;
        let mut host_checked = 0usize;
        for &opening_id in opening_ids {
            let (op_min, op_max) = match opening_world_aabb(&router, opening_id, &mut decoder) {
                Some(b) => b,
                None => {
                    skipped_no_opening_mesh += 1;
                    continue;
                }
            };
            let hits = count_hits_through_opening(&wall_mesh, op_min, op_max);
            host_total_hits += hits;
            host_checked += 1;
        }
        if host_checked > 0 && host_total_hits > 0 {
            failed_hosts.push((host_id, host_total_hits, host_checked));
        }
    }

    eprintln!(
        "[smiley sweep] hosts={} failed={} empty={} skipped_opening={}",
        total_hosts,
        failed_hosts.len(),
        empty_meshes,
        skipped_no_opening_mesh,
    );
    if !failed_hosts.is_empty() {
        eprintln!("first 20 failing hosts (express_id, total_hits, openings_checked):");
        for (id, hits, n) in failed_hosts.iter().take(20) {
            eprintln!("  #{}: {} hits across {} openings", id, hits, n);
        }
    }

    assert_eq!(
        failed_hosts.len(),
        0,
        "{}/{} host walls in Smiley-West are still uncut around their openings — \
         the production void path is not being applied",
        failed_hosts.len(),
        total_hosts,
    );
}
