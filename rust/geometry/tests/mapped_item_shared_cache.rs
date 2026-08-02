// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 byte-identity gate for the model-wide shared `IfcMappedItem` source
//! cache.
//!
//! On main, a fresh `GeometryRouter` is built per element, so its per-router
//! RefCell `mapped_item_cache` only dedups mapped sources WITHIN one element — a
//! source shared by many owning elements is re-meshed once per element. #1623
//! promotes that cache to a model-wide `SharedMappedItemCache` so each source is
//! meshed ONCE. The hard gate is that a cross-router cache HIT (a second router
//! reusing a source another router meshed and inserted) is byte-for-byte identical
//! to the un-shared per-router build.
//!
//! This drives the exact cross-router scenario the promotion introduces:
//!
//! - BASELINE — one router with NO shared cache (the RefCell fallback, i.e. the
//!   pre-#1623 code path), meshing every mapped product.
//! - WARM — a router sharing one cache meshes every product (all MISSES: it
//!   builds each source and inserts it into the shared cache).
//! - HIT — a SECOND, fresh router sharing the SAME cache meshes every product;
//!   every source is now served from the WARM router's insert (a pure
//!   cross-router hit).
//!
//! It asserts HIT == BASELINE, vertex for vertex, index for index, normal for
//! normal, plus the mapped `instance_meta`. `mapped_shared_unique_count()` proves
//! the shared cache actually captured sources, so the hit path is genuinely
//! exercised (not silently disabled — in which case HIT would trivially equal
//! BASELINE via the RefCell).
//!
//! Fixtures are the buildingSMART IFC 4.3 Annex E mapped-geometric-shape samples;
//! a missing fixture skips (run `pnpm fixtures`), never fails.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{GeometryRouter, Mesh};

const FIXTURES: &[&str] = &[
    "tests/models/buildingsmart/annex_e/mapped-geometric-shape/mapped-shape-with-transformation.ifc",
    "tests/models/buildingsmart/annex_e/mapped-geometric-shape/mapped-shape-without-transformation.ifc",
    "tests/models/buildingsmart/annex_e/mapped-geometric-shape/mapped-shape-with-multiple-items.ifc",
];

/// Repo root = first ancestor holding both `rust/` and `apps/` (mirrors the
/// module-size ratchet's `repo_root`). `None` in a packaged/standalone context.
fn repo_root() -> Option<std::path::PathBuf> {
    let mut dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    loop {
        if dir.join("rust").is_dir() && dir.join("apps").is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Exact fingerprint of a meshed product: geometry bytes plus the mapped
/// `instance_meta` fields that carry the per-occurrence transform. Any drift
/// between the shared-cache hit and the RefCell baseline shows up here.
#[derive(PartialEq, Debug)]
struct MeshFingerprint {
    positions: Vec<u32>,
    normals: Vec<u32>,
    indices: Vec<u32>,
    rep_identity: Option<u128>,
    local_transform: Option<Vec<u64>>,
}

fn fingerprint(mesh: &Mesh) -> MeshFingerprint {
    MeshFingerprint {
        positions: mesh.positions.iter().map(|f| f.to_bits()).collect(),
        normals: mesh.normals.iter().map(|f| f.to_bits()).collect(),
        indices: mesh.indices.clone(),
        rep_identity: mesh.instance_meta.as_ref().map(|m| m.rep_identity),
        local_transform: mesh
            .instance_meta
            .as_ref()
            .and_then(|m| m.local_transform.as_ref())
            .map(|t| t.iter().map(|f| f.to_bits()).collect()),
    }
}

/// Every entity id whose `process_element` yields non-empty geometry. Broad
/// decode-and-mesh sweep (the fixtures are tiny) — non-products early-return empty
/// and are dropped.
fn geometry_product_ids(content: &str, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Vec<u32> {
    let mut ids = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, _name, _, _)) = scanner.next_entity() {
        let Ok(entity) = decoder.decode_by_id(id) else {
            continue;
        };
        if let Ok(mesh) = router.process_element(&entity, decoder) {
            if !mesh.positions.is_empty() {
                ids.push(id);
            }
        }
    }
    ids
}

fn fresh_router_with_shared<'a>(
    content: &'a str,
    shared: &ifc_lite_geometry::SharedMappedItemCache,
) -> (GeometryRouter, EntityDecoder<'a>) {
    let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));
    let mut router = GeometryRouter::with_units(content, &mut decoder);
    router.enable_shared_mapped_item_cache(shared.clone());
    (router, decoder)
}

fn assert_cross_router_hit_is_byte_identical(rel_path: &str) {
    let Some(root) = repo_root() else {
        eprintln!("repo root not found (packaged context) - skipping {rel_path}");
        return;
    };
    let path = root.join(rel_path);
    let Ok(content) = std::fs::read_to_string(&path) else {
        eprintln!("skipping: fixture {rel_path} not present - run `pnpm fixtures`");
        return;
    };

    // BASELINE: no shared cache -> the per-router RefCell path (pre-#1623).
    let mut base_decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
    let base_router = GeometryRouter::with_units(&content, &mut base_decoder);
    let product_ids = geometry_product_ids(&content, &base_router, &mut base_decoder);
    assert!(
        !product_ids.is_empty(),
        "fixture {rel_path} produced no geometry - it may no longer exercise the mapped path"
    );
    let baseline: Vec<MeshFingerprint> = product_ids
        .iter()
        .map(|id| {
            let entity = base_decoder.decode_by_id(*id).expect("decode baseline product");
            let mesh = base_router
                .process_element(&entity, &mut base_decoder)
                .expect("mesh baseline product");
            fingerprint(&mesh)
        })
        .collect();

    // WARM: router A sharing one cache meshes every product (all misses -> inserts).
    let shared = GeometryRouter::new_mapped_item_cache();
    {
        let (warm_router, mut warm_decoder) = fresh_router_with_shared(&content, &shared);
        for id in &product_ids {
            let entity = warm_decoder.decode_by_id(*id).expect("decode warm product");
            let _ = warm_router
                .process_element(&entity, &mut warm_decoder)
                .expect("mesh warm product");
        }
        assert!(
            warm_router.mapped_shared_unique_count() > 0,
            "shared mapped cache stayed empty for {rel_path} - the shared cache was not exercised, \
             so the hit path below would be a no-op"
        );
    }

    // HIT: a SECOND fresh router sharing the SAME cache meshes every product. Every
    // source is now served from router A's insert - a pure cross-router hit.
    let (hit_router, mut hit_decoder) = fresh_router_with_shared(&content, &shared);
    for (i, id) in product_ids.iter().enumerate() {
        let entity = hit_decoder.decode_by_id(*id).expect("decode hit product");
        let mesh = hit_router
            .process_element(&entity, &mut hit_decoder)
            .expect("mesh hit product");
        assert_eq!(
            fingerprint(&mesh),
            baseline[i],
            "shared-cache cross-router HIT diverged from the RefCell baseline for product #{id} \
             in {rel_path} (#1623 must be byte-identical)"
        );
    }
}

#[test]
fn shared_mapped_cache_hit_is_byte_identical_to_per_router_baseline() {
    for fixture in FIXTURES {
        assert_cross_router_hit_is_byte_identical(fixture);
    }
}
