//! M7 dual-kernel parity sweep (flip plan M7, real-model corpus).
//!
//! Processes EVERY element-with-voids (IfcRelVoidsElement hosts, propagated to
//! aggregate parts) AND every product whose representation graph transitively
//! contains an IfcBooleanResult / IfcBooleanClippingResult, through the full
//! `GeometryRouter::process_element_with_voids` pipeline, and emits one JSONL
//! record per element with kernel-sensitive invariants:
//!   signed volume, AABB, non-manifold edge counts, triangle count, CSG ms.
//!
//! Run the SAME model through two differently-routed builds and diff the JSONL:
//!   ORACLE  (Manifold C++): default features  + CSG_MANIFOLD=1 UNION_MANIFOLD=1
//!   PURE    (exact kernel): --no-default-features (manifold not even compiled)
//!
//! Routing proof: the header line records cfg!(feature = "manifold-csg") + the
//! env vars + a canonical box−box probe THROUGH the routed ClippingProcessor —
//! Manifold and the pure kernel produce characteristically different
//! triangulations for the same (identical-volume) result.
//!
//!   cargo run --release -p ifc-lite-geometry --example m7_parity_sweep -- <model.ifc> [out.jsonl]

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, ClippingProcessor, GeometryRouter, Mesh};
use rustc_hash::{FxHashMap, FxHashSet};
use std::io::Write;
use std::time::Instant;

/// Ops bitmask: which boolean operators reach this product's representation.
const OP_DIFF: u8 = 1;
const OP_UNION: u8 = 2;
const OP_INTER: u8 = 4;
const OP_CLIP: u8 = 8; // IfcBooleanClippingResult (operator usually DIFFERENCE)

fn vtx(m: &Mesh, i: u32) -> [f64; 3] {
    let b = i as usize * 3;
    [
        m.positions[b] as f64,
        m.positions[b + 1] as f64,
        m.positions[b + 2] as f64,
    ]
}

/// Signed volume via divergence theorem (f64 accumulation over f32 coords).
fn volume(m: &Mesh) -> f64 {
    m.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (vtx(m, t[0]), vtx(m, t[1]), vtx(m, t[2]));
            let cr = [
                b[1] * c[2] - b[2] * c[1],
                b[2] * c[0] - b[0] * c[2],
                b[0] * c[1] - b[1] * c[0],
            ];
            a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
        })
        .sum::<f64>()
        / 6.0
}

/// Signed volume about the mesh's own AABB center. For a CLOSED mesh this equals
/// `volume()` (translation invariance). For an OPEN mesh (boundary cracks) the
/// origin-referenced sum is biased by boundary-loop flux ∝ distance-to-origin —
/// catastrophic on far-from-origin models (TUN32 at 250–410 m read −59.8 m³ from
/// a +0.30 m³ wall with a 2.65 m sliver crack). `vol_c` bounds that bias by the
/// operand's own extent, so it measures the SOLID, not the model's placement.
fn volume_c(m: &Mesh) -> f64 {
    if m.positions.is_empty() {
        return 0.0;
    }
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    for v in m.positions.chunks_exact(3) {
        for k in 0..3 {
            lo[k] = lo[k].min(v[k] as f64);
            hi[k] = hi[k].max(v[k] as f64);
        }
    }
    let o = [
        (lo[0] + hi[0]) * 0.5,
        (lo[1] + hi[1]) * 0.5,
        (lo[2] + hi[2]) * 0.5,
    ];
    m.indices
        .chunks_exact(3)
        .map(|t| {
            let s = |i: u32| {
                let v = vtx(m, i);
                [v[0] - o[0], v[1] - o[1], v[2] - o[2]]
            };
            let (a, b, c) = (s(t[0]), s(t[1]), s(t[2]));
            let cr = [
                b[1] * c[2] - b[2] * c[1],
                b[2] * c[0] - b[0] * c[2],
                b[0] * c[1] - b[1] * c[0],
            ];
            a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
        })
        .sum::<f64>()
        / 6.0
}

fn bbox(m: &Mesh) -> [f64; 6] {
    let mut bb = [f64::MAX, f64::MAX, f64::MAX, f64::MIN, f64::MIN, f64::MIN];
    for v in m.positions.chunks_exact(3) {
        for k in 0..3 {
            bb[k] = bb[k].min(v[k] as f64);
            bb[k + 3] = bb[k + 3].max(v[k] as f64);
        }
    }
    if m.positions.is_empty() {
        bb = [0.0; 6];
    }
    bb
}

/// Edge-manifoldness with vertices welded on a 10 µm grid (outputs carry
/// independent float coords). Returns (open_edges: used once, bad_edges: used != 2).
fn edge_stats(m: &Mesh) -> (u32, u32) {
    let s = 1e5_f64;
    let key = |i: u32| {
        let b = i as usize * 3;
        (
            (m.positions[b] as f64 * s).round() as i64,
            (m.positions[b + 1] as f64 * s).round() as i64,
            (m.positions[b + 2] as f64 * s).round() as i64,
        )
    };
    let mut edges: FxHashMap<((i64, i64, i64), (i64, i64, i64)), i32> = FxHashMap::default();
    for t in m.indices.chunks_exact(3) {
        let k = [key(t[0]), key(t[1]), key(t[2])];
        for (u, v) in [(0usize, 1usize), (1, 2), (2, 0)] {
            if k[u] == k[v] {
                continue; // degenerate (welded) edge — skip, counted by neither
            }
            let e = if k[u] < k[v] { (k[u], k[v]) } else { (k[v], k[u]) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    let mut open = 0u32;
    let mut bad = 0u32;
    for &c in edges.values() {
        if c == 1 {
            open += 1;
        }
        if c != 2 {
            bad += 1;
        }
    }
    (open, bad)
}

/// All hosts with openings (IfcRelVoidsElement), propagated to aggregate parts.
fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
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
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

/// Extract every `#<digits>` reference in an entity span, skipping the leading
/// self id (`#id=`). '#' inside quoted strings is rare and harmless here (it
/// would add a spurious reverse edge, never remove a real one).
fn scan_refs(span: &[u8], self_id: u32, out: &mut Vec<u32>) {
    out.clear();
    let mut i = 0usize;
    // Skip the leading "#<id>" of the definition itself.
    if !span.is_empty() && span[0] == b'#' {
        i = 1;
        while i < span.len() && span[i].is_ascii_digit() {
            i += 1;
        }
    }
    while i < span.len() {
        if span[i] == b'#' {
            let mut j = i + 1;
            let mut v: u64 = 0;
            let mut any = false;
            while j < span.len() && span[j].is_ascii_digit() {
                v = v * 10 + (span[j] - b'0') as u64;
                any = true;
                j += 1;
            }
            if any && v <= u32::MAX as u64 && v as u32 != self_id {
                out.push(v as u32);
            }
            i = j;
        } else {
            i += 1;
        }
    }
}

struct EntityMeta {
    type_name_off: (usize, usize), // offsets into content for the type name
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: m7_parity_sweep <model.ifc> [out.jsonl]");
        std::process::exit(2);
    }
    let path = &args[1];
    let out_path = args.get(2).cloned();

    let t_total = Instant::now();
    let content = std::fs::read_to_string(path).expect("model file readable");
    let bytes = content.as_bytes();

    // ---- Pass 1: scan all entities; reverse-reference map + boolean roots ----
    let t_scan = Instant::now();
    let mut meta: FxHashMap<u32, EntityMeta> = FxHashMap::default();
    let mut rev: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    // boolean root id -> op mask
    let mut bool_roots: FxHashMap<u32, u8> = FxHashMap::default();
    {
        let mut scanner = EntityScanner::new(&content);
        let mut refs: Vec<u32> = Vec::with_capacity(32);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            // Record type-name span (slice of `content` — stable, zero-copy).
            let tn_start = {
                // type_name is a slice of content; recover its offset
                type_name.as_ptr() as usize - content.as_ptr() as usize
            };
            meta.insert(
                id,
                EntityMeta {
                    type_name_off: (tn_start, tn_start + type_name.len()),
                },
            );
            scan_refs(&bytes[start..end], id, &mut refs);
            for &r in &refs {
                rev.entry(r).or_default().push(id);
            }
            let is_clip = type_name == "IFCBOOLEANCLIPPINGRESULT";
            if is_clip || type_name == "IFCBOOLEANRESULT" {
                let span = &content[start..end];
                let mut mask = 0u8;
                if span.contains(".DIFFERENCE.") {
                    mask |= OP_DIFF;
                }
                if span.contains(".UNION.") {
                    mask |= OP_UNION;
                }
                if span.contains(".INTERSECTION.") {
                    mask |= OP_INTER;
                }
                if is_clip {
                    mask |= OP_CLIP;
                }
                bool_roots.insert(id, mask);
            }
        }
    }
    let scan_ms = t_scan.elapsed().as_secs_f64() * 1e3;
    let type_of = |id: u32| -> &str {
        meta.get(&id)
            .map(|m| &content[m.type_name_off.0..m.type_name_off.1])
            .unwrap_or("")
    };

    // ---- Pass 2: worklist dataflow — propagate op masks UP the reverse graph
    // until we hit IFCPRODUCTDEFINITIONSHAPE; its referencing products (attr 6 =
    // Representation) are the boolean-bearing elements. ----
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);

    let mut node_mask: FxHashMap<u32, u8> = FxHashMap::default();
    let mut product_mask: FxHashMap<u32, u8> = FxHashMap::default();
    let mut work: Vec<(u32, u8)> = bool_roots.iter().map(|(&k, &v)| (k, v)).collect();
    while let Some((id, mask)) = work.pop() {
        let cur = node_mask.entry(id).or_insert(0);
        if *cur & mask == mask {
            continue; // no new bits
        }
        *cur |= mask;
        let tn = type_of(id);
        if tn == "IFCPRODUCTDEFINITIONSHAPE" {
            if let Some(parents) = rev.get(&id) {
                for &p in parents {
                    // product = entity whose Representation (attr 6) is this PDS
                    if let Ok(pe) = decoder.decode_by_id(p) {
                        if pe.get_ref(6) == Some(id) {
                            *product_mask.entry(p).or_insert(0) |= mask;
                        }
                    }
                }
            }
            continue; // stop climbing past the product boundary
        }
        if let Some(parents) = rev.get(&id) {
            for &p in parents {
                work.push((p, mask));
            }
        }
    }
    drop(rev);

    // ---- Target set: voids hosts ∪ boolean-bearing products ----
    let void_index = build_void_index(&content);
    let mut targets: FxHashSet<u32> = void_index.keys().copied().collect();
    let mut skipped_openings = 0usize;
    for (&p, _) in &product_mask {
        let tn = type_of(p);
        if tn == "IFCOPENINGELEMENT" || tn == "IFCVOIDINGFEATURE" {
            // consumed by their hosts via the void path; not rendered standalone
            skipped_openings += 1;
            continue;
        }
        targets.insert(p);
    }
    let mut targets: Vec<u32> = targets.into_iter().collect();
    targets.sort_unstable();

    // ---- Kernel fingerprint probe (THROUGH the routed ClippingProcessor) ----
    let probe = {
        use ifc_lite_geometry::kernel::arrangement::box_mesh;
        use ifc_lite_geometry::kernel::mesh_bridge::tris_to_mesh;
        let a = tris_to_mesh(&box_mesh([0., 0., 0.], [2., 2., 2.]));
        let b = tris_to_mesh(&box_mesh([1., 1., 1.], [3., 3., 3.]));
        let cp = ClippingProcessor::new();
        let d = cp.subtract_mesh(&a, &b).unwrap_or_default();
        let u = cp.union_mesh(&a, &b).unwrap_or_default();
        (
            d.triangle_count(),
            volume(&d),
            u.triangle_count(),
            volume(&u),
        )
    };

    let mut out: Box<dyn Write> = match &out_path {
        Some(p) => Box::new(std::io::BufWriter::new(
            std::fs::File::create(p).expect("create out file"),
        )),
        None => Box::new(std::io::stdout().lock()),
    };

    writeln!(
        out,
        "{{\"header\":1,\"file\":\"{}\",\"manifold_feature\":{},\"env_csg_manifold\":{},\"env_union_manifold\":{},\"probe_diff_tris\":{},\"probe_diff_vol\":{:.9},\"probe_union_tris\":{},\"probe_union_vol\":{:.9},\"targets\":{},\"voids_hosts\":{},\"bool_products\":{},\"bool_roots\":{},\"skipped_openings\":{},\"scan_ms\":{:.1}}}",
        path,
        cfg!(feature = "manifold-csg"),
        std::env::var("CSG_MANIFOLD").is_ok(),
        std::env::var("UNION_MANIFOLD").is_ok(),
        probe.0, probe.1, probe.2, probe.3,
        targets.len(),
        void_index.len(),
        product_mask.len(),
        bool_roots.len(),
        skipped_openings,
        scan_ms,
    )
    .unwrap();

    // ---- Process every target through the FULL voids+boolean pipeline ----
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let empty_voids: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut csg_ms_total = 0.0f64;
    let mut n_processed = 0usize;
    let mut n_errors = 0usize;
    let mut n_panics = 0usize;
    for &id in &targets {
        let entity = match decoder.decode_by_id(id) {
            Ok(e) => e,
            Err(_) => {
                n_errors += 1;
                continue;
            }
        };
        let n_voids = void_index.get(&id).map(|v| v.len()).unwrap_or(0);
        let mask = product_mask.get(&id).copied().unwrap_or(0);
        let mut ops = String::new();
        if mask & OP_DIFF != 0 {
            ops.push('D');
        }
        if mask & OP_UNION != 0 {
            ops.push('U');
        }
        if mask & OP_INTER != 0 {
            ops.push('I');
        }
        if mask & OP_CLIP != 0 {
            ops.push('C');
        }

        // Ground truth context (kernel-independent unless the element/opening
        // itself contains CSG): host volume WITHOUT the void cut + sum of the
        // standalone opening volumes. Lets the comparator detect "silent
        // fallback returned the un-cut host" on either side.
        let nocut_vol = if n_voids > 0 {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                router
                    .process_element_with_voids(&entity, &mut decoder, &empty_voids)
                    .map(|m| volume(&m))
                    .unwrap_or(f64::NAN)
            }))
            .unwrap_or(f64::NAN)
        } else {
            f64::NAN // identical to the main call; comparator uses vol
        };
        let mut open_vol = 0.0f64;
        if let Some(openings) = void_index.get(&id) {
            for &oid in openings {
                if let Ok(oe) = decoder.decode_by_id(oid) {
                    let ov = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        router
                            .process_element_with_voids(&oe, &mut decoder, &empty_voids)
                            .map(|m| volume(&m).abs())
                            .unwrap_or(0.0)
                    }))
                    .unwrap_or(0.0);
                    open_vol += ov;
                }
            }
        }
        let _ = router.take_csg_failures(); // discard failures from context calls

        let t0 = Instant::now();
        let mesh_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            router.process_element_with_voids(&entity, &mut decoder, &void_index)
        }));
        let ms = t0.elapsed().as_secs_f64() * 1e3;
        csg_ms_total += ms;

        // Drain per-element kernel fallback records (pure path records
        // KernelOutputInvalid etc.; the manifold env path returns the host
        // silently, which the nocut_vol comparison catches instead).
        let failures: Vec<String> = router
            .take_csg_failures()
            .into_values()
            .flatten()
            .map(|f| format!("{}:{:?}", f.op, f.reason))
            .collect();
        let fail_str = failures.join("|").replace('"', "'");

        match mesh_result {
            Ok(Ok(m)) => {
                let bb = bbox(&m);
                let (open_e, bad_e) = edge_stats(&m);
                writeln!(
                    out,
                    "{{\"id\":{},\"type\":\"{}\",\"voids\":{},\"ops\":\"{}\",\"tris\":{},\"vol\":{:.9},\"vol_c\":{:.9},\"nocut_vol\":{},\"open_vol\":{:.9},\"bbox\":[{:.6},{:.6},{:.6},{:.6},{:.6},{:.6}],\"open_edges\":{},\"bad_edges\":{},\"fails\":\"{}\",\"ms\":{:.3}}}",
                    id, type_of(id), n_voids, ops,
                    m.triangle_count(), volume(&m), volume_c(&m),
                    if nocut_vol.is_nan() { "null".to_string() } else { format!("{nocut_vol:.9}") },
                    open_vol,
                    bb[0], bb[1], bb[2], bb[3], bb[4], bb[5],
                    open_e, bad_e, fail_str, ms,
                )
                .unwrap();
                n_processed += 1;
            }
            Ok(Err(e)) => {
                writeln!(
                    out,
                    "{{\"id\":{},\"type\":\"{}\",\"voids\":{},\"ops\":\"{}\",\"error\":\"{}\",\"fails\":\"{}\",\"ms\":{:.3}}}",
                    id, type_of(id), n_voids, ops,
                    format!("{e:?}").replace('"', "'"),
                    fail_str, ms,
                )
                .unwrap();
                n_errors += 1;
            }
            Err(p) => {
                let msg = p
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown panic".to_string());
                writeln!(
                    out,
                    "{{\"id\":{},\"type\":\"{}\",\"voids\":{},\"ops\":\"{}\",\"panic\":\"{}\",\"ms\":{:.3}}}",
                    id, type_of(id), n_voids, ops,
                    msg.replace('"', "'").replace('\\', "/"),
                    ms,
                )
                .unwrap();
                n_panics += 1;
                n_errors += 1;
            }
        }
    }

    let total_ms = t_total.elapsed().as_secs_f64() * 1e3;
    writeln!(
        out,
        "{{\"footer\":1,\"processed\":{},\"errors\":{},\"panics\":{},\"csg_ms\":{:.1},\"total_ms\":{:.1}}}",
        n_processed, n_errors, n_panics, csg_ms_total, total_ms
    )
    .unwrap();
    eprintln!(
        "[{}] {} targets, {} ok, {} err, csg {:.0}ms, total {:.0}ms",
        if cfg!(feature = "manifold-csg") {
            if std::env::var("CSG_MANIFOLD").is_ok() {
                "MANIFOLD-ORACLE"
            } else {
                "PURE-KERNEL(+manifold compiled)"
            }
        } else {
            "PURE-KERNEL(no-default-features)"
        },
        targets.len(),
        n_processed,
        n_errors,
        csg_ms_total,
        total_ms
    );
}
