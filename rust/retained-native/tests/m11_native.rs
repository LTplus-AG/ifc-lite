// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
mod support;
use ifc_lite_geometry::program::transactions::Requirement;
use ifc_lite_processing::element::retained_runtime::ProductOutcome;

#[test]
fn m11_0_7955_real_sdk_keeps_face_partition_and_discharged_normals() {
    let Some(outcomes) = support::native(support::BOX) else { return; };
    let mut count = 0;
    for outcome in &outcomes {
        if let ProductOutcome::Published(product) = outcome {
            count += 1;
            assert!(!product.obligations.0.contains(&Requirement::SurfaceNormals));
            for part in &product.parts {
                assert_eq!(part.revision_local_faces.len(), part.indices.len() / 3);
                assert!(!part.revision_local_faces.is_empty());
                assert!(part.faces.is_some() && part.instance_key.is_none());
                assert_eq!(part.normals.as_ref().unwrap().len(), part.indices.len()*3);
                assert!(part.appearance.is_some(), "M11-A resolves every part");
            }
        }
    }
    assert!(count > 0);
    println!("sdk witness executed: m11_0_faces_normals");
}

// ---- M11-A: IfcAppearance. Exact is the colour authority for committed models (same resolver,
// same keys); the synthetic fixture's expected colours are hand-authored in its generator.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{ModelOptions, ShapeOnlyProduct};
use std::collections::{BTreeMap, BTreeSet};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const FZK: &str = "apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc";
const F_B_MAPPED: &str = "tests/fixtures/synthetic-retained/f-b-mapped.ifc";
const APPEARANCE: &str = "tests/fixtures/synthetic-retained/f-m11a-appearance.ifc";
const F_I: &str = "tests/fixtures/synthetic-retained/f-i-presentation.ifc";
type Key = (u32, Option<u32>);
type Look = ([u32; 4], Option<String>);

fn repo(path: &str) -> Vec<u8> {
    std::fs::read(format!("{ROOT}/{path}")).unwrap_or_else(|e| panic!("{path}: {e}"))
}
fn retained(path: &str, ids: Option<&[u32]>) -> Option<Vec<ProductOutcome>> {
    let worker = support::worker_path()?;
    let mut all = Vec::new();
    let options = ModelOptions { ids: ids.map(|ids| ids.iter().copied().collect()), ..Default::default() };
    ifc_lite_retained_native::run_model_native(SourceBundle::new(repo(path)), std::path::Path::new(&worker), &options,
        |outcome| all.push(outcome)).unwrap();
    Some(all)
}
fn bits(rgba: [f32; 4]) -> [u32; 4] { rgba.map(f32::to_bits) }
fn exact_looks(path: &str) -> BTreeMap<Key, BTreeSet<Look>> {
    let mut looks: BTreeMap<Key, BTreeSet<Look>> = BTreeMap::new();
    for mesh in ifc_lite_processing::process_geometry(&repo(path)).meshes {
        looks.entry((mesh.express_id, mesh.geometry_item_id)).or_default().insert((bits(mesh.color), mesh.material_name));
    }
    looks
}
fn look(part: &ifc_lite_processing::element::retained_runtime::ShapePart) -> Look {
    let appearance = part.appearance.as_ref().expect("every published part has an appearance");
    (bits(appearance.rgba), appearance.material_name.clone())
}
/// `(model, id, published?, code)` for every committed coverage row.
fn universe() -> BTreeMap<String, Vec<(u32, bool, String)>> {
    let mut rows: BTreeMap<String, Vec<(u32, bool, String)>> = BTreeMap::new();
    let mut files = vec![format!("{ROOT}/tests/manifests/cli-retained-coverage.tsv")];
    let mut fragments: Vec<_> = std::fs::read_dir(format!("{ROOT}/tests/manifests/cli-retained-coverage.d")).unwrap()
        .map(|entry| entry.unwrap().path()).filter(|path| path.extension().is_some_and(|e| e == "tsv")).collect();
    fragments.sort();
    files.extend(fragments.into_iter().map(|p| p.to_string_lossy().into_owned()));
    for file in files {
        for line in std::fs::read_to_string(&file).unwrap().lines().filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("model\t")) {
            let cells: Vec<_> = line.split('\t').collect();
            rows.entry(cells[0].to_owned()).or_default().push((cells[1].parse().unwrap(), cells[2] == "published", cells[3].to_owned()));
        }
    }
    rows
}
fn published(outcomes: &[ProductOutcome]) -> impl Iterator<Item = &ShapeOnlyProduct> {
    outcomes.iter().filter_map(|o| match o { ProductOutcome::Published(p) => Some(p), _ => None })
}

#[test]
fn m11_a_every_committed_published_row_resolves_and_matches_exact_where_exact_has_the_key() {
    if support::worker_path().is_none() { return; }
    let (mut rows, mut unmatched, mut styled_products) = (0usize, Vec::new(), BTreeSet::new());
    for (model, coverage) in universe() {
        let ids: Vec<u32> = coverage.iter().map(|(id, ..)| *id).collect();
        let outcomes = retained(&model, Some(&ids)).unwrap();
        let exact = exact_looks(&model);
        for (id, is_published, code) in &coverage {
            let outcome = outcomes.iter().find(|o| match o {
                ProductOutcome::Published(p) => p.product_id == *id,
                ProductOutcome::Refused { product_id, .. } => product_id == id,
            }).unwrap_or_else(|| panic!("{model} #{id}: no outcome"));
            match outcome {
                ProductOutcome::Published(product) => {
                    assert!(is_published, "{model} #{id} published but the coverage row says {code}");
                    rows += 1;
                    assert!(!product.obligations.0.contains(&Requirement::IfcAppearance), "{model} #{id}");
                    for part in &product.parts {
                        let ours = look(part);
                        let item = part.appearance.as_ref().unwrap().geometry_item_id;
                        if part.appearance.as_ref().unwrap().style_id.is_some() { styled_products.insert((model.clone(), *id)); }
                        match exact.get(&(*id, item)) {
                            Some(theirs) => assert!(theirs.contains(&ours), "{model} #{id} item {item:?}: retained {ours:?} exact {theirs:?}"),
                            None => {
                                // Exact keys this mesh differently (or not at all): fall back to the product's own looks.
                                let keys: Vec<_> = exact.keys().filter(|(p, _)| p == id).map(|(_, k)| *k).collect();
                                let any = exact.iter().filter(|((p, _), _)| p == id).any(|(_, looks)| looks.iter().any(|look| look.0 == ours.0));
                                unmatched.push(format!("{model} #{id} item {item:?} exact keys {keys:?} product-level {}", if keys.is_empty() { "no-exact-mesh" } else if any { "equal" } else { "DIFFERENT" }));
                            }
                        }
                    }
                }
                ProductOutcome::Refused { refusal, .. } => {
                    assert!(!is_published, "{model} #{id} refused {} but the coverage row says published", refusal.code());
                    assert_eq!(refusal.code(), code, "{model} #{id}");
                    assert_ne!(refusal.code(), "appearance_unsupported", "{model} #{id}: census says 0 pending");
                }
            }
        }
    }
    let expected = universe().values().flatten().filter(|(_, is_published, _)| *is_published).count();
    assert_eq!(rows, expected, "IfcAppearance resolved on every committed published row");
    assert!(rows >= 131);
    let fzk: Vec<_> = styled_products.iter().filter(|(model, _)| model == FZK).collect();
    assert_eq!(fzk.len(), 14, "FZK-Haus has 14 products with a direct IfcStyledItem colour: {fzk:?}");
    // Exact keys these meshes differently (cached mapped path: no item; layered walls: per material; repeated single-solid
    // maps: the map's solid), so the product's own exact colours stand in: every RGBA must be among them, bit for bit.
    // The material name is compared only under a shared key (exact names a style only when it keys the styled item).
    let different: Vec<_> = unmatched.iter().filter(|row| row.ends_with("DIFFERENT")).collect();
    assert!(different.is_empty(), "retained colour absent from exact's meshes of the same product: {different:#?}");
    println!("M11-A unmatched (retained key absent from exact, product-level colour checked): {} {unmatched:?}", unmatched.len());
    println!("sdk witness executed: m11_a_universe");
}

#[test]
fn m11_a_synthetic_fixture_meets_its_hand_authored_colours() {
    let Some(outcomes) = retained(APPEARANCE, None) else { return; };
    let oracle: serde_json::Value = serde_json::from_slice(&repo("tests/fixtures/synthetic-retained/f-m11a-appearance.oracle.json")).unwrap();
    let tolerance = serde_json::from_str::<serde_json::Value>(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m11-a.json"))
        .unwrap()["appearanceSyntheticRgbaAbsolute"].as_f64().unwrap() as f32;
    let mut failures = Vec::new();
    for expected in oracle["products"].as_array().unwrap() {
        let (role, id) = (expected["role"].as_str().unwrap(), expected["id"].as_u64().unwrap() as u32);
        let Some(product) = published(&outcomes).find(|p| p.product_id == id) else { failures.push(format!("{role} #{id}: not published")); continue; };
        let parts = expected["parts"].as_array().unwrap();
        if product.parts.len() != parts.len() { failures.push(format!("{role}: {} parts, expected {}", product.parts.len(), parts.len())); continue; }
        if product.obligations.0.contains(&Requirement::IfcAppearance) { failures.push(format!("{role}: IfcAppearance still unmet")); }
        for (part, want) in product.parts.iter().zip(parts) {
            let got = part.appearance.as_ref().unwrap();
            let rgba_ok = got.rgba.iter().zip(want["rgba"].as_array().unwrap()).all(|(g, w)| (g - w.as_f64().unwrap() as f32).abs() <= tolerance);
            if !rgba_ok { failures.push(format!("{role}: rgba {:?} vs {:?}", got.rgba, want["rgba"])); }
            if got.material_name.as_deref() != want["materialName"].as_str() { failures.push(format!("{role}: name {:?} vs {}", got.material_name, want["materialName"])); }
            if want.get("geometryItemId").is_some_and(|item| got.geometry_item_id.map(u64::from) != item.as_u64()) { failures.push(format!("{role}: item {:?} vs {}", got.geometry_item_id, want["geometryItemId"])); }
            if u64::from(got.geometry_class) != want["geometryClass"].as_u64().unwrap() { failures.push(format!("{role}: class {}", got.geometry_class)); }
        }
    }
    let typed = &oracle["typeMap"];
    match published(&outcomes).find(|p| u64::from(p.product_id) == typed["type"].as_u64().unwrap()) {
        Some(product) => {
            let got = product.parts[0].appearance.as_ref().unwrap();
            let rgba_ok = got.rgba.iter().zip(typed["rgba"].as_array().unwrap()).all(|(g, w)| (g - w.as_f64().unwrap() as f32).abs() <= tolerance);
            if !rgba_ok || u64::from(got.geometry_class) != typed["geometryClass"].as_u64().unwrap() || got.geometry_item_id.is_some() {
                failures.push(format!("g-type: {got:?}"));
            }
        }
        None => failures.push("g-type: not published".into()),
    }
    assert!(failures.is_empty(), "hand-authored appearance violations: {failures:#?}");
    // The same fixture must also agree bitwise with exact (same resolver, same keys).
    let exact = exact_looks(APPEARANCE);
    for product in published(&outcomes) {
        for part in &product.parts {
            let item = part.appearance.as_ref().unwrap().geometry_item_id;
            if let Some(theirs) = exact.get(&(product.product_id, item)) {
                assert!(theirs.contains(&look(part)), "#{} item {item:?}: {:?} vs {theirs:?}", product.product_id, look(part));
            }
        }
    }
    println!("sdk witness executed: m11_a_synthetic");
}

#[test]
fn m11_a_shared_f_i_fixture_meets_its_hand_derived_colours() {
    // README.md of the shared fixture derives these by hand (dyadic components, exact in f32): (a) styled
    // translucent extrusion, (b) wall coloured only through its material, (c) nine occurrences of one styled map
    // (two rotated, one at 2.6e6 m), (d) host of a voided window whose reveals keep the host colour, (g) a
    // type-styled mapped product. (a), (b), (c) and (g) must publish; (d) is checked wherever it does.
    let Some(outcomes) = retained(F_I, None) else { return; };
    let tolerance = serde_json::from_str::<serde_json::Value>(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m11-a.json"))
        .unwrap()["appearanceSyntheticRgbaAbsolute"].as_f64().unwrap() as f32;
    let mut cases: Vec<(&str, u32, [f32; 4], bool)> = vec![
        ("a-styled-translucent", 110, [0.5, 0.25, 0.125, 0.7], true),
        ("b-material-only-wall", 213, [0.125, 0.75, 0.25, 1.0], true),
        ("d-arc-wall host", 425, [0.875, 0.625, 0.375, 1.0], false),
        ("d-arc-wall opening (fixed display colour)", 433, [1.0, 0.42, 0.29, 0.4], false),
        ("g-type-styled", 713, [0.625, 0.125, 0.875, 1.0], true),
    ];
    cases.extend([311, 321, 331, 341, 351, 361, 371, 381, 391].map(|id| ("c-mapped occurrence", id, [0.25, 0.5, 0.75, 1.0], true)));
    let mut failures = Vec::new();
    for (name, id, want, required) in cases {
        let Some(product) = published(&outcomes).find(|p| p.product_id == id) else {
            if required { failures.push(format!("{name} #{id}: not published")); }
            continue;
        };
        for part in &product.parts {
            let got = part.appearance.as_ref().unwrap().rgba;
            if got.iter().zip(want).any(|(g, w)| (g - w).abs() > tolerance) { failures.push(format!("{name} #{id}: {got:?} vs {want:?}")); }
        }
        if product.obligations.0.contains(&Requirement::IfcAppearance) { failures.push(format!("{name} #{id}: IfcAppearance unmet")); }
    }
    // Same resolver: every published RGBA is among exact's colours for its product, bit for bit. The material name can
    // differ and is reported: exact keys a repeated single-solid styled map by the map's solid (#308, #706) and names the
    // style there, while retained keys the IfcMappedItem (no don't-bake plan) where only the colour is chased.
    let exact = exact_looks(F_I);
    let mut name_only = Vec::new();
    for product in published(&outcomes) {
        let theirs: Vec<_> = exact.iter().filter(|((p, _), _)| *p == product.product_id).flat_map(|(key, looks)| looks.iter().map(move |l| (key.1, l))).collect();
        for part in &product.parts {
            let ours = look(part);
            if theirs.is_empty() { continue; }
            if !theirs.iter().any(|(_, theirs)| theirs.0 == ours.0) {
                failures.push(format!("#{}: retained {:?} is not among exact's colours", product.product_id, ours.0.map(f32::from_bits)));
            } else if !theirs.iter().any(|(_, theirs)| **theirs == ours) {
                name_only.push(format!("#{} item {:?} name {:?}; exact {:?}", product.product_id, part.appearance.as_ref().unwrap().geometry_item_id, ours.1,
                    theirs.iter().map(|(item, l)| (*item, l.1.clone())).collect::<Vec<_>>()));
            }
        }
    }
    println!("M11-A f-i material-name differences (colours bitwise equal; report-only): {name_only:#?}");
    assert!(failures.is_empty(), "f-i appearance violations: {failures:#?}");
    println!("M11-A f-i published products: {:?}", published(&outcomes).map(|p| p.product_id).collect::<Vec<_>>());
    println!("sdk witness executed: m11_a_f_i");
}

#[test]
fn m11_a_palette_and_texture_products_stay_refused_not_published_as_plain_colour() {
    // f-b-mapped #172 (IfcIndexedColourMap) and #183 (IfcIndexedTriangleTextureMap) have tessellated bodies,
    // which retained refuses upstream. The only product that could reach appearance with one of them
    // is therefore absent: explicit absence, never a plain-colour publication.
    let Some(outcomes) = retained(F_B_MAPPED, None) else { return; };
    for id in [172, 183] {
        assert_eq!(support::refusal(&outcomes, id).code(), "operation_unsupported", "#{id}");
    }
    assert!(published(&outcomes).all(|p| p.product_id != 172 && p.product_id != 183));
    for product in published(&outcomes) {
        assert!(product.parts.iter().all(|part| part.appearance.is_some()));
    }
    println!("sdk witness executed: m11_a_palette_texture_absence");
}

#[test]
fn m11_a_stage_native_browser_reference() {
    // The 14 FZK-Haus products with a direct IfcStyledItem plus the whole synthetic fixture: the
    // browser module Worker must resolve the same bits (IFCLITE_M11A_REFERENCE, staged by CI).
    let Some(fzk_all) = retained(FZK, None) else { return; };
    let fzk_ids: Vec<u32> = published(&fzk_all).filter(|p| p.parts.iter().any(|part| part.appearance.as_ref().is_some_and(|a| a.style_id.is_some())))
        .map(|p| p.product_id).collect();
    assert_eq!(fzk_ids.len(), 14);
    let synthetic = retained(APPEARANCE, None).unwrap();
    let shared = retained(F_I, None).unwrap();
    let rows = |outcomes: &[ProductOutcome], only: Option<&[u32]>| outcomes.iter().filter_map(|outcome| match outcome {
        ProductOutcome::Published(p) if only.is_none_or(|ids| ids.contains(&p.product_id)) => Some(serde_json::json!({
            "id": p.product_id, "code": "published", "parts": p.parts.iter().map(|part| { let a = part.appearance.as_ref().unwrap();
                serde_json::json!({"rgbaBits": bits(a.rgba), "materialName": a.material_name, "geometryItemId": a.geometry_item_id}) }).collect::<Vec<_>>() })),
        ProductOutcome::Refused { product_id, refusal, .. } if only.is_none() => Some(serde_json::json!({"id": product_id, "code": refusal.code(), "parts": null})),
        _ => None,
    }).collect::<Vec<_>>();
    if let Some(path) = std::env::var_os("IFCLITE_M11A_REFERENCE") {
        let document = serde_json::json!([
            {"path": APPEARANCE, "rows": rows(&synthetic, None)},
            {"path": F_I, "rows": rows(&shared, None)},
            {"path": FZK, "rows": rows(&fzk_all, Some(&fzk_ids))},
        ]);
        std::fs::write(path, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
    }
    println!("sdk witness executed: m11_a_reference");
}
