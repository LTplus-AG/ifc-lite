// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// A self-referential clipping result: `#10`'s FirstOperand is `#10` again,
/// with `#20` an `IfcPolygonalBoundedHalfSpace` cutter. Before the visited-id
/// guard, `collect_polygonal_chain` walked `current = first` forever.
const CYCLIC_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,#20);
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

/// Wrap a DATA-section body in a minimal STEP file.
fn wrap_ifc(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Run `collect_polygonal_chain` starting at `root_id` in a worker thread with
/// a timeout, so a regressed infinite walk fails the test instead of hanging
/// the suite. Returns `(base_id, cutter_ids)`.
fn collect_with_timeout(content: String, root_id: u32) -> (u32, Vec<u32>) {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let mut decoder = EntityDecoder::new(&content);
        let entity = decoder.decode_by_id(root_id).expect("decode root");
        let processor = BooleanClippingProcessor::new();
        let result = processor.collect_polygonal_chain(entity, &mut decoder);
        let _ = tx.send(result.map(|(base, cutters)| {
            (base.id, cutters.iter().map(|c| c.id).collect::<Vec<_>>())
        }));
    });
    // Variant-matched rather than `is_ok()`: `recv_timeout` returns Err for
    // Disconnected as well as Timeout, so a PANIC in the worker drops `tx` and
    // would report as "did not terminate" — a confident wrong diagnosis
    // pointing at a guard that is fine (#2945). The split lives in
    // `test_support::recv_or_diagnose`, which pins both directions.
    let value = crate::test_support::recv_or_diagnose(
        &rx,
        std::time::Duration::from_secs(10),
        "collect_polygonal_chain hung (walk did not terminate)",
        "collect_polygonal_chain's worker PANICKED (not a hang); \
         its panic is printed above",
    );
    let _ = handle.join();
    value.expect("collect_polygonal_chain returned Err")
}

#[test]
fn collect_polygonal_chain_terminates_on_cyclic_first_operand() {
    // Run in a worker thread so a regression (infinite loop + unbounded
    // `chain.push`) is observed as a timeout instead of hanging the suite.
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let content = CYCLIC_IFC.to_string();
        let mut decoder = EntityDecoder::new(&content);
        let entity = decoder.decode_by_id(10).expect("decode #10");
        let processor = BooleanClippingProcessor::new();
        let result = processor.collect_polygonal_chain(entity, &mut decoder);
        let _ = tx.send(result.map(|(base, cutters)| (base.id, cutters.len())));
    });

    // Variant-matched, not `is_ok()`: see `collect_with_timeout` (#2945).
    let value = crate::test_support::recv_or_diagnose(
        &rx,
        std::time::Duration::from_secs(5),
        "collect_polygonal_chain hung on a cyclic FirstOperand chain",
        "collect_polygonal_chain's worker PANICKED on the cyclic fixture \
         (not a hang); its panic is printed above",
    );
    let _ = handle.join();

    let (base_id, cutter_count) = value.expect("collect_polygonal_chain returned Err");
    // The walk bottoms out on the repeated entity and collects the single
    // PBHS cutter it saw before detecting the cycle.
    assert_eq!(base_id, 10, "cycle should bottom out on the repeated entity");
    assert_eq!(
        cutter_count, 1,
        "exactly one PBHS cutter collected before the cycle breaks"
    );
}

/// A 2-cycle where the repeated id is the ROOT: `#10 → #30 → #10`. The walk
/// must break when it re-reaches `#10`, having collected one cutter per node.
#[test]
fn collect_polygonal_chain_terminates_on_two_cycle_via_root() {
    let content = wrap_ifc(
        "#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#30,#20);\n\
#30=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#10,#40);\n\
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n\
#40=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n",
    );
    let (base_id, cutters) = collect_with_timeout(content, 10);
    assert_eq!(base_id, 10, "2-cycle should bottom out on the repeated ROOT");
    // Reversed (innermost-first): #30's cutter #40, then #10's cutter #20.
    assert_eq!(cutters, vec![40, 20]);
}

/// A cycle on an INTERIOR node: `#10 → #30 → #30`. The repeat is detected at
/// `#30`, not the root.
#[test]
fn collect_polygonal_chain_terminates_on_interior_self_loop() {
    let content = wrap_ifc(
        "#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#30,#20);\n\
#30=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#30,#40);\n\
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n\
#40=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n",
    );
    let (base_id, cutters) = collect_with_timeout(content, 10);
    assert_eq!(base_id, 30, "interior self-loop should bottom out on #30");
    assert_eq!(cutters, vec![40, 20]);
}

/// A legitimate 1000-deep left-spine chain with NO cycle must still be walked
/// to the bottom — the visited-set guard must not cap finite depth (the walk
/// is iterative precisely so deep chains bypass MAX_BOOLEAN_DEPTH, #960).
#[test]
fn collect_polygonal_chain_walks_thousand_deep_chain() {
    const DEPTH: u32 = 1000;
    let mut data = String::new();
    for i in 1..=DEPTH {
        let first = if i == DEPTH { 20000 } else { i + 1 };
        data.push_str(&format!(
            "#{i}=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#{first},#{cutter});\n",
            cutter = 10000 + i
        ));
    }
    for i in 1..=DEPTH {
        data.push_str(&format!(
            "#{}=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n",
            10000 + i
        ));
    }
    data.push_str("#20000=IFCEXTRUDEDAREASOLID($,$,$,$);\n");

    let (base_id, cutters) = collect_with_timeout(wrap_ifc(&data), 1);
    assert_eq!(base_id, 20000, "deep chain must bottom out on the base solid");
    assert_eq!(cutters.len() as u32, DEPTH, "every cutter must be collected");
    // Innermost-first ordering: the deepest node's cutter comes first.
    assert_eq!(cutters[0], 10000 + DEPTH);
    assert_eq!(*cutters.last().unwrap(), 10001);
}

/// A dangling FirstOperand (`#999` does not exist) must stop the walk cleanly
/// at the node that references it — no panic, no hang.
#[test]
fn collect_polygonal_chain_stops_on_dangling_first_operand() {
    let content = wrap_ifc(
        "#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#999,#20);\n\
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n",
    );
    let (base_id, cutters) = collect_with_timeout(content, 10);
    assert_eq!(
        base_id, 10,
        "walk should stop at the node whose FirstOperand dangles"
    );
    assert_eq!(cutters, vec![20]);
}

/// A `$` (null) FirstOperand must also stop the walk cleanly.
#[test]
fn collect_polygonal_chain_stops_on_null_first_operand() {
    let content = wrap_ifc(
        "#10=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,$,#20);\n\
#20=IFCPOLYGONALBOUNDEDHALFSPACE($,$,$,$);\n",
    );
    let (base_id, cutters) = collect_with_timeout(content, 10);
    assert_eq!(base_id, 10);
    assert_eq!(cutters, vec![20]);
}

/// A left-deep DIFFERENCE chain LONGER than `MAX_BOOLEAN_DEPTH` whose
/// cutters are plain solids (no PBHS batching applies) must still resolve:
/// chain length is walked iteratively and only operand nesting counts
/// against the depth cap. Revit exports building-element-part chains up to
/// 42 nodes deep; the recursive walk errored at 10 and the element's
/// geometry vanished.
///
/// Fixture: a 1000-unit cube minus the SAME slab cutter (z = 600..1600,
/// oversized in plan) subtracted 14 times in a left-deep chain. The
/// repeated subtract is idempotent, so the correct result is the cube
/// truncated at z = 600 — and any depth-cap error would surface as Err.
#[test]
fn deep_left_difference_chain_resolves_past_depth_cap() {
    const CHAIN: u32 = 14;
    // Compile-time guarantee the fixture actually exceeds the cap.
    const _: () = assert!(CHAIN > MAX_BOOLEAN_DEPTH);
    let mut data = String::from(
        "#100=IFCCARTESIANPOINT((0.,0.));\n\
#101=IFCAXIS2PLACEMENT2D(#100,$);\n\
#102=IFCRECTANGLEPROFILEDEF(.AREA.,$,#101,1000.,1000.);\n\
#103=IFCCARTESIANPOINT((0.,0.,0.));\n\
#104=IFCAXIS2PLACEMENT3D(#103,$,$);\n\
#105=IFCDIRECTION((0.,0.,1.));\n\
#106=IFCEXTRUDEDAREASOLID(#102,#104,#105,1000.);\n\
#202=IFCRECTANGLEPROFILEDEF(.AREA.,$,#101,4000.,4000.);\n\
#203=IFCCARTESIANPOINT((0.,0.,600.));\n\
#204=IFCAXIS2PLACEMENT3D(#203,$,$);\n\
#206=IFCEXTRUDEDAREASOLID(#202,#204,#105,1000.);\n",
    );
    for i in 0..CHAIN {
        let first = if i == 0 { 106 } else { 300 + i - 1 };
        data.push_str(&format!(
            "#{}=IFCBOOLEANRESULT(.DIFFERENCE.,#{first},#206);\n",
            300 + i
        ));
    }
    let content = wrap_ifc(&data);
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder
        .decode_by_id(300 + CHAIN - 1)
        .expect("decode chain root");
    let processor = BooleanClippingProcessor::new();
    let schema = IfcSchema::new();
    let mesh = processor
        .process(&entity, &mut decoder, &schema, TessellationQuality::Medium)
        .expect("a deep left chain must not hit the operand-nesting depth cap");
    assert!(!mesh.is_empty(), "the chain's base solid must survive");
    let (lo, hi) = mesh.bounds();
    assert!(
        (hi.z - 600.0).abs() < 1.0,
        "cutter truncates the cube at z=600; got max z = {}",
        hi.z
    );
    assert!(lo.z.abs() < 1.0, "cube base must stay at z=0; got {}", lo.z);
}

/// Exact f32-bit key for a vertex, so a sub-micron displacement of a shared
/// vertex splits the pair it was supposed to form instead of being rounded back
/// together. That exactness is what makes these instruments right for a seam.
/// Both buffers must be whole triplets. `chunks_exact` DISCARDS a ragged tail,
/// so a mesh with a stray coordinate or a two-index triangle would be silently
/// truncated and could then satisfy all three instruments below — a shorter
/// mesh than the one under test, certified as the one under test.
fn assert_mesh_buffer_layout(mesh: &Mesh) {
    assert_eq!(
        mesh.positions.len() % 3,
        0,
        "positions must be whole xyz triplets; got {}",
        mesh.positions.len()
    );
    assert_eq!(
        mesh.indices.len() % 3,
        0,
        "indices must be whole triangles; got {}",
        mesh.indices.len()
    );
}

fn vertex_keys(mesh: &Mesh) -> Vec<[u32; 3]> {
    assert_mesh_buffer_layout(mesh);
    mesh.positions
        .chunks_exact(3)
        .map(|p| [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()])
        .collect()
}

/// Edges that are not manifold-paired. A watertight, orientable surface uses
/// every undirected edge exactly twice, once in each direction; anything else —
/// a crack (one incidence), a bowtie or T-junction (three or more), or two
/// same-way incidences — is reported here.
///
/// Counting the two directions SEPARATELY matters: a net-signed tally lets an
/// edge with two forward and two reverse incidences cancel to zero, so a
/// non-manifold seam would be certified watertight (see
/// `watertightness_instruments_reject_the_defects_they_guard`).
fn open_edge_count(mesh: &Mesh) -> usize {
    use std::collections::HashMap;
    let keys = vertex_keys(mesh);
    let mut edges: HashMap<([u32; 3], [u32; 3]), (u32, u32)> = HashMap::new();
    for t in mesh.indices.chunks_exact(3) {
        let k = [
            keys[t[0] as usize],
            keys[t[1] as usize],
            keys[t[2] as usize],
        ];
        for (u, v) in [(0, 1), (1, 2), (2, 0)] {
            let incidence = if k[u] <= k[v] {
                &mut edges.entry((k[u], k[v])).or_default().0
            } else {
                &mut edges.entry((k[v], k[u])).or_default().1
            };
            *incidence += 1;
        }
    }
    edges
        .values()
        .filter(|&&(forward, reverse)| forward != 1 || reverse != 1)
        .count()
}

/// Triangles that repeat the same three vertices, counted without regard to
/// winding. A coincident pair with opposite winding is a zero-thickness
/// duplicate surface: it contributes nothing to the signed volume and pairs its
/// own edges perfectly, so neither of the other two instruments sees it.
fn duplicate_face_count(mesh: &Mesh) -> usize {
    use std::collections::HashMap;
    let keys = vertex_keys(mesh);
    let mut faces: HashMap<[[u32; 3]; 3], usize> = HashMap::new();
    for t in mesh.indices.chunks_exact(3) {
        let mut k = [
            keys[t[0] as usize],
            keys[t[1] as usize],
            keys[t[2] as usize],
        ];
        k.sort_unstable();
        *faces.entry(k).or_insert(0) += 1;
    }
    faces.values().map(|&n| n - 1).sum()
}

/// SIGNED volume of a closed triangle soup (divergence theorem). The sign is
/// kept deliberately: outward winding is the geometry contract, and taking
/// `abs()` here would let a wholly inverted result report the expected
/// magnitude.
fn mesh_volume(mesh: &Mesh) -> f64 {
    assert_mesh_buffer_layout(mesh);
    let v = |i: u32| {
        let b = i as usize * 3;
        [
            mesh.positions[b] as f64,
            mesh.positions[b + 1] as f64,
            mesh.positions[b + 2] as f64,
        ]
    };
    let mut s = 0.0;
    for t in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
        s += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    s / 6.0
}

/// A deep left-nested DIFFERENCE spine whose cutters SHARE SEAMS must come out
/// watertight AND compact, hop by hop (#2433).
///
/// #2433 proposed evaluating such a spine as ONE arrangement — staying in the
/// kernel's f64 `Vec<Tri>` across the whole chain and crossing the `Mesh`
/// boundary once at the end — on the theory that the per-hop
/// `f32 -> f64+snap -> f32` round trip in `mesh_bridge` re-jitters and re-cracks
/// the previous hop's seams. Measurement refuted that: dropping the round trip
/// leaves the open-edge count unchanged (the cracks are already present in the
/// f64 arrangement output, before any narrowing), while dropping the per-hop
/// `Mesh` step also drops the `consolidate_coplanar` that runs inside
/// `ClippingProcessor::subtract_mesh`. That consolidation is what keeps the
/// accumulator from fragmenting: on the real depth-12 spine that motivated the
/// issue it holds the result at 60 triangles instead of 702, and the resulting
/// operand growth cost three orders of magnitude of wall time.
///
/// So the per-hop `Mesh` boundary is not overhead to be collapsed — it is where
/// the accumulator is reduced. This test pins that: the fixture is 12 cutters on
/// an off-snap-grid pitch (0.37 m against a 2^-16 m grid), each overlapping its
/// predecessor so hop N+1 always lands on hop N's fresh seam — the exact regime
/// the issue argued was damaged.
#[test]
fn deep_seam_sharing_difference_spine_stays_watertight_and_compact() {
    const CHAIN: usize = 12;
    const _: () = assert!(CHAIN > MAX_BOOLEAN_DEPTH as usize);
    // 12 x 0.3 x 3 m wall host.
    let mut data = String::from(
        "#100=IFCCARTESIANPOINT((0.,0.));\n\
#101=IFCAXIS2PLACEMENT2D(#100,$);\n\
#102=IFCRECTANGLEPROFILEDEF(.AREA.,$,#101,12.,0.3);\n\
#103=IFCCARTESIANPOINT((0.,0.,0.));\n\
#104=IFCAXIS2PLACEMENT3D(#103,$,$);\n\
#105=IFCDIRECTION((0.,0.,1.));\n\
#106=IFCEXTRUDEDAREASOLID(#102,#104,#105,3.);\n\
#110=IFCRECTANGLEPROFILEDEF(.AREA.,$,#101,0.5,1.);\n",
    );
    // Cutters: 0.5 m wide on a 0.37 m pitch, so consecutive cutters overlap by
    // 0.13 m and every hop re-cuts the seam the previous hop just created. Each
    // is a through-cut (1.0 m across a 0.3 m wall) spanning z = 0.6..2.0.
    for i in 0..CHAIN {
        let x = -5.5 + (i as f64) * 0.37;
        let id = 1000 + i * 10;
        data.push_str(&format!(
            "#{p}=IFCCARTESIANPOINT(({x:.9},0.,0.6));\n\
#{a}=IFCAXIS2PLACEMENT3D(#{p},$,$);\n\
#{s}=IFCEXTRUDEDAREASOLID(#110,#{a},#105,1.4);\n",
            p = id,
            a = id + 1,
            s = id + 2,
        ));
    }
    for i in 0..CHAIN {
        let first = if i == 0 { 106 } else { 5000 + i - 1 };
        data.push_str(&format!(
            "#{}=IFCBOOLEANRESULT(.DIFFERENCE.,#{first},#{cut});\n",
            5000 + i,
            cut = 1000 + i * 10 + 2
        ));
    }
    let content = wrap_ifc(&data);
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder
        .decode_by_id((5000 + CHAIN - 1) as u32)
        .expect("decode spine root");
    let processor = BooleanClippingProcessor::new();
    let mesh = processor
        .process(
            &entity,
            &mut decoder,
            &IfcSchema::new(),
            TessellationQuality::Medium,
        )
        .expect("a 12-deep solid-cutter spine must resolve");

    // `process` returning Ok only says the walk finished; a hop that fell back
    // instead of cutting is recorded here, and the spine must take none.
    let failures = processor.take_failures();
    assert!(
        failures.is_empty(),
        "the deep spine must resolve without entering a boolean failure path; got {failures:?}"
    );

    assert_eq!(
        open_edge_count(&mesh),
        0,
        "every hop's seam must stay closed across a 12-deep seam-sharing spine"
    );
    assert_eq!(
        duplicate_face_count(&mesh),
        0,
        "no hop may leave a coincident duplicate face behind"
    );

    // The 12 overlapping cutters merge into ONE notch spanning
    // x = -5.75 .. -1.18, full wall thickness, 1.4 m tall:
    // 12*0.3*3 - 4.57*0.3*1.4 = 8.8806 m^3. Compared SIGNED, so an inward-wound
    // result fails instead of matching on magnitude.
    let volume = mesh_volume(&mesh);
    assert!(
        (volume - 8.8806).abs() < 1.0e-2,
        "spine must remove exactly the merged notch and stay outward-wound; \
         expected ~+8.8806 m^3, got {volume}"
    );

    // Fragmentation guard. The merged notch is a simple prismatic cavity, so the
    // consolidated result is a few dozen triangles. Without the per-hop
    // reduction the same spine fragments by an order of magnitude, which is both
    // the wrong geometry to hand the renderer and the reason an all-at-once
    // arrangement is dramatically slower.
    assert!(
        mesh.triangle_count() <= 64,
        "a 12-hop spine over one merged notch must stay consolidated; got {} triangles",
        mesh.triangle_count()
    );
}

/// A guard is worth exactly what it can catch. Each mesh below is INVALID and
/// each is INVISIBLE to the other two instruments, which is why the spine
/// regression asserts on all three: weaken any one of them and the
/// corresponding case here starts certifying broken geometry.
#[test]
fn watertightness_instruments_reject_the_defects_they_guard() {
    /// Append an outward-wound tetrahedron over four positively oriented
    /// corners, i.e. `(c1-c0) x (c2-c0) . (c3-c0) > 0`.
    fn push_tetra(positions: &mut Vec<f32>, indices: &mut Vec<u32>, corners: [[f32; 3]; 4]) {
        let base = (positions.len() / 3) as u32;
        for c in corners {
            positions.extend_from_slice(&c);
        }
        for f in [[0u32, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]] {
            indices.extend_from_slice(&[base + f[0], base + f[1], base + f[2]]);
        }
    }
    fn mesh_of(positions: Vec<f32>, indices: Vec<u32>) -> Mesh {
        let mut mesh = Mesh::new();
        mesh.normals = vec![0.0; positions.len()];
        mesh.positions = positions;
        mesh.indices = indices;
        mesh
    }
    const UNIT: [[f32; 3]; 4] = [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ];

    // Control: a single closed tetrahedron is clean on all three instruments.
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    push_tetra(&mut positions, &mut indices, UNIT);
    let good = mesh_of(positions, indices);
    assert_eq!(open_edge_count(&good), 0, "control tetra has no open edge");
    assert_eq!(
        duplicate_face_count(&good),
        0,
        "control tetra has no duplicate face"
    );
    assert!(
        (mesh_volume(&good) - 1.0 / 6.0).abs() < 1.0e-6,
        "control tetra encloses +1/6 m^3, got {}",
        mesh_volume(&good)
    );

    // (1) BOWTIE. Two closed tetrahedra meeting along one shared edge. That edge
    // carries two forward and two reverse incidences, which a net-signed tally
    // cancels to zero — this is the exact regression `open_edge_count` counting
    // the two directions separately exists to catch.
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    push_tetra(&mut positions, &mut indices, UNIT);
    push_tetra(
        &mut positions,
        &mut indices,
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, -1.0],
        ],
    );
    let bowtie = mesh_of(positions, indices);
    assert_eq!(
        open_edge_count(&bowtie),
        1,
        "the shared edge is non-manifold and must be reported, not cancelled"
    );
    assert_eq!(
        duplicate_face_count(&bowtie),
        0,
        "the bowtie is invisible to the duplicate-face instrument"
    );
    assert!(
        (mesh_volume(&bowtie) - 2.0 / 6.0).abs() < 1.0e-6,
        "the bowtie is invisible to the volume instrument"
    );

    // (2) ZERO-THICKNESS DUPLICATE SURFACE. A coincident pair of opposite-wound
    // triangles pairs its own edges perfectly and contributes nothing to the
    // signed volume, so only `duplicate_face_count` can see it.
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    push_tetra(&mut positions, &mut indices, UNIT);
    let sheet = (positions.len() / 3) as u32;
    positions.extend_from_slice(&[5.0, 0.0, 0.0, 6.0, 0.0, 0.0, 5.0, 1.0, 0.0]);
    indices.extend_from_slice(&[sheet, sheet + 1, sheet + 2, sheet, sheet + 2, sheet + 1]);
    let doubled = mesh_of(positions, indices);
    assert_eq!(
        duplicate_face_count(&doubled),
        1,
        "the coincident pair must be reported"
    );
    assert_eq!(
        open_edge_count(&doubled),
        0,
        "the duplicate surface is invisible to the edge instrument"
    );
    assert!(
        (mesh_volume(&doubled) - 1.0 / 6.0).abs() < 1.0e-6,
        "the duplicate surface is invisible to the volume instrument"
    );

    // (3) FULLY INVERTED WINDING. Reversing every triangle keeps the surface
    // manifold and duplicate-free; only a SIGNED volume notices.
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    push_tetra(&mut positions, &mut indices, UNIT);
    for t in indices.chunks_exact_mut(3) {
        t.swap(1, 2);
    }
    let inverted = mesh_of(positions, indices);
    assert!(
        (mesh_volume(&inverted) + 1.0 / 6.0).abs() < 1.0e-6,
        "an inverted solid must report a NEGATIVE volume, got {}",
        mesh_volume(&inverted)
    );
    assert_eq!(
        open_edge_count(&inverted),
        0,
        "inverted winding is invisible to the edge instrument"
    );
    assert_eq!(
        duplicate_face_count(&inverted),
        0,
        "inverted winding is invisible to the duplicate-face instrument"
    );
}

/// A ragged buffer must be REJECTED, not quietly truncated. Both instruments
/// that read the raw buffers are covered: `open_edge_count` and
/// `duplicate_face_count` go through `vertex_keys`, `mesh_volume` asserts for
/// itself. Split into two tests so each panic is attributed to the buffer that
/// caused it — one combined test would pass on a guard that only checks
/// positions.
#[test]
#[should_panic(expected = "positions must be whole xyz triplets")]
fn a_ragged_position_buffer_is_rejected() {
    let mut mesh = Mesh::new();
    // One trailing coordinate: `chunks_exact(3)` would drop the partial vertex
    // and hand back a mesh one vertex short of the one under test.
    mesh.positions = vec![0.0; 3 * 3 + 1];
    mesh.normals = vec![0.0; mesh.positions.len()];
    mesh.indices = vec![0, 1, 2];
    let _ = open_edge_count(&mesh);
}

#[test]
#[should_panic(expected = "indices must be whole triangles")]
fn a_ragged_index_buffer_is_rejected() {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0.0; 3 * 3];
    mesh.normals = vec![0.0; mesh.positions.len()];
    // A two-index tail: the dropped pair is exactly the kind of open edge these
    // instruments exist to find.
    mesh.indices = vec![0, 1, 2, 0, 1];
    let _ = mesh_volume(&mesh);
}

/// The FULL `process()` path on a self-referential boolean must terminate
/// (via the cycle guard + MAX_BOOLEAN_DEPTH recursion cap), returning a
/// Result — Ok or Err both acceptable — instead of hanging the worker.
#[test]
fn full_process_terminates_on_cyclic_boolean() {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let content = CYCLIC_IFC.to_string();
        let mut decoder = EntityDecoder::new(&content);
        let entity = decoder.decode_by_id(10).expect("decode #10");
        let processor = BooleanClippingProcessor::new();
        let schema = IfcSchema::new();
        let result = processor.process(
            &entity,
            &mut decoder,
            &schema,
            TessellationQuality::Medium,
        );
        let _ = tx.send(result.is_ok());
    });
    // Variant-matched, not `is_ok()`: see `collect_with_timeout` (#2945).
    let _ = crate::test_support::recv_or_diagnose(
        &rx,
        std::time::Duration::from_secs(10),
        "full process() hung on a cyclic boolean chain",
        "full process()'s worker PANICKED on the cyclic fixture (not a hang); \
         its panic is printed above",
    );
    let _ = handle.join();
}

/// `IfcCsgSolid.TreeRootExpression` may be an `IfcBooleanResult`, whose
/// operands may in turn be `IfcCsgSolid` — so the two are mutually recursive
/// over file-supplied references. `CsgSolidProcessor::process` built a FRESH
/// `BooleanClippingProcessor`, resetting both `depth` and the cycle guard, so
/// three entities recursed forever with depth never passing 1 (#2866).
///
/// `csg_primitive.rs` already rejected `IfcCsgSolid -> IfcCsgSolid` explicitly,
/// "so a malformed (or adversarial) file with a self-reference can't blow the
/// stack". That guard is one hop wide. This is the two-hop cycle it cannot see.
const CSG_BOOLEAN_CYCLE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCBOOLEANRESULT(.DIFFERENCE.,#20,#30);
#20=IFCCSGSOLID(#10);
#30=IFCBLOCK($,1.,1.,1.);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn boolean_csg_mutual_recursion_terminates() {
    // Worker thread + timeout, matching the test above: a regression that
    // loops without growing the stack shows up as a timeout rather than
    // hanging the suite. (A regression that DOES grow the stack aborts the
    // whole binary — no harness can catch that one, so it is named here
    // rather than implied.)
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let content = CSG_BOOLEAN_CYCLE.to_string();
        let mut decoder = EntityDecoder::new(&content);
        let entity = decoder.decode_by_id(10).expect("decode #10");
        let processor = BooleanClippingProcessor::new();
        let schema = IfcSchema::new();
        let result = processor.process(&entity, &mut decoder, &schema, Default::default());
        let _ = tx.send(result.map(|m| m.positions.len()));
    });

    // Variant-matched, not `is_ok()`: see `collect_with_timeout` (#2945).
    let value = crate::test_support::recv_or_diagnose(
        &rx,
        std::time::Duration::from_secs(10),
        "Boolean/CSG mutual recursion did not terminate",
        "the Boolean/CSG worker PANICKED (not a hang); \
         its panic is printed above",
    );
    let _ = handle.join();

    // The cycle is reported, not silently swallowed: an operand that cannot be
    // resolved must surface as an error so the router drops the element rather
    // than rendering a half-built solid as if it were complete.
    let err = value.expect_err("a cyclic operand must be an error");
    let msg = err.to_string();
    assert!(
        msg.contains("Cyclic boolean/CSG operand reference"),
        "expected the cycle to be named, got: {msg}"
    );
}

/// Entering through `CsgSolidProcessor` rather than the boolean side must be
/// guarded too — the router registers it directly, so that is the path a real
/// file takes when the element's Body item IS the `IfcCsgSolid`.
#[test]
fn csg_entry_point_is_guarded_too() {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let content = CSG_BOOLEAN_CYCLE.to_string();
        let mut decoder = EntityDecoder::new(&content);
        let entity = decoder.decode_by_id(20).expect("decode #20");
        let processor = crate::processors::CsgSolidProcessor::new();
        let schema = IfcSchema::new();
        let result = processor.process(&entity, &mut decoder, &schema, Default::default());
        let _ = tx.send(result.map(|m| m.positions.len()));
    });

    // Variant-matched, not `is_ok()`: see `collect_with_timeout` (#2945).
    let value = crate::test_support::recv_or_diagnose(
        &rx,
        std::time::Duration::from_secs(10),
        "CsgSolid entry point did not terminate",
        "the CsgSolid entry point's worker PANICKED (not a hang); \
         its panic is printed above",
    );
    let _ = handle.join();
    value.expect_err("a cyclic operand must be an error from this entry point too");
}

/// A long ACYCLIC `Boolean -> Csg -> Boolean` chain, every id distinct. The
/// CSG hop passes `depth` unchanged (a CsgSolid is not a boolean nesting
/// level), so `MAX_BOOLEAN_DEPTH` never advances and every `visited.insert`
/// succeeds — the set never fires either. Before `MAX_OPERAND_PATH_NODES` this
/// aborted the process on stack depth alone, with no cycle in the file
/// (Codex, #2871/#2872 review; the same gap here).
#[test]
fn a_long_acyclic_boolean_csg_chain_terminates() {
    let n: u32 = 4_000;
    let mut data = String::new();
    for i in 0..n {
        let b = 1 + i * 2;
        let c = 2 + i * 2;
        let next_b = if i + 1 == n { 90000 } else { 1 + (i + 1) * 2 };
        data.push_str(&format!("#{b}=IFCBOOLEANRESULT(.DIFFERENCE.,#{c},#90001);\n"));
        data.push_str(&format!("#{c}=IFCCSGSOLID(#{next_b});\n"));
    }
    data.push_str("#90000=IFCBLOCK($,1.,1.,1.);\n#90001=IFCBLOCK($,1.,1.,1.);\n");

    // On a worker thread like its siblings: if the bound regresses, this
    // overflows the stack, and a stack overflow ABORTS the whole test binary --
    // taking ~690 unrelated tests with it and burying whichever test reported
    // the regression cleanly. Cargo still exits non-zero, so it is not a false
    // green, but the diagnostic is unreadable.
    let content = wrap_ifc(&data);
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let mut decoder = EntityDecoder::new(&content);
        let entity = decoder.decode_by_id(1).expect("decode #1");
        let processor = BooleanClippingProcessor::new();
        let schema = IfcSchema::new();
        let result = processor.process(&entity, &mut decoder, &schema, Default::default());
        let _ = tx.send(result.map(|m| m.positions.len()).map_err(|e| e.to_string()));
    });
    // Variant-matched, not `is_ok()`: see `collect_with_timeout` (#2945).
    let value = crate::test_support::recv_or_diagnose(
        &rx,
        std::time::Duration::from_secs(20),
        "the operand chain bound did not terminate",
        "the operand chain worker PANICKED (not a hang, so the chain bound \
         is not implicated); its panic is printed above",
    );
    let _ = handle.join();
    let err = value
        .expect_err("an over-long operand chain must be reported, not rendered half-built");
    assert!(
        err.contains("operand chain exceeds"),
        "expected the chain bound to be named, got: {err}"
    );
}

/// `IfcCsgSolid.TreeRootExpression` may not be another `IfcCsgSolid` (IFC 4.3
/// `IfcCsgSelect`), and `CsgSolidProcessor` rejects it. Nothing asserted that
/// anywhere, which mattered while the path bound counted boolean ids only and
/// leaned on this rejection to keep the frame count bounded. The bound now
/// counts CSG ids too, so this is a plain spec check again — but a "be lenient
/// about nested CsgSolid" change is a plausible bad-exporter fix, and it should
/// fail here rather than in whatever it silently un-bounds.
#[test]
fn a_csg_solid_rooted_in_another_csg_solid_is_rejected() {
    let content = wrap_ifc(
        "#10=IFCCSGSOLID(#20);\n\
         #20=IFCCSGSOLID(#30);\n\
         #30=IFCBLOCK($,1.,1.,1.);\n",
    );
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(10).expect("decode #10");
    let processor = crate::processors::CsgSolidProcessor::new();
    let schema = IfcSchema::new();
    let err = processor
        .process(&entity, &mut decoder, &schema, Default::default())
        .expect_err("IfcCsgSolid -> IfcCsgSolid is a spec violation and must be refused");
    assert!(
        err.to_string().contains("not another IfcCsgSolid"),
        "the rejection must name what it rejected, got: {err}"
    );
}

/// Pins that the path bound counts EVERY frame, not just the boolean ones.
///
/// An alternating `Boolean -> Csg -> Boolean` chain puts two entities on the
/// stack per level. Counting booleans only, 50 levels reads as 50 against a
/// bound of 64 and is accepted while actually standing 100 frames deep — the
/// bound silently means twice its own number. Counting both, the same chain
/// crosses 64 and is refused.
///
/// This is the assertion that was missing when an earlier revision dropped the
/// CSG-side insert: at the time, removing it changed no test, which read as
/// "redundant" and was really "unpinned".
#[test]
fn the_path_bound_counts_csg_frames_too_not_only_booleans() {
    let n: u32 = 50;
    let mut data = String::new();
    for i in 0..n {
        let b = 1 + i * 2;
        let c = 2 + i * 2;
        let next_b = if i + 1 == n { 90000 } else { 1 + (i + 1) * 2 };
        data.push_str(&format!("#{b}=IFCBOOLEANRESULT(.DIFFERENCE.,#{c},#90001);\n"));
        data.push_str(&format!("#{c}=IFCCSGSOLID(#{next_b});\n"));
    }
    data.push_str("#90000=IFCBLOCK($,1.,1.,1.);\n#90001=IFCBLOCK($,1.,1.,1.);\n");

    let content = wrap_ifc(&data);
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(1).expect("decode #1");
    let processor = BooleanClippingProcessor::new();
    let schema = IfcSchema::new();
    let err = processor
        .process(&entity, &mut decoder, &schema, Default::default())
        .expect_err("100 stack frames must cross a 64-frame bound");
    assert!(
        err.to_string().contains("operand chain exceeds"),
        "the path bound must be what stops it, got: {err}"
    );
}

/// Pins the path-scoped `remove` on BOTH sides. Deleting either one leaves the
/// set accumulate-only, which turns a legitimately SHARED operand into a
/// reported cycle: `#10` below is reached from two different branches of an
/// acyclic tree, not twice down one path.
///
/// Without the removes this returns `Err("Cyclic boolean/CSG operand
/// reference at #10")` and the router drops the whole element. Every other
/// test in this file stayed green with them deleted -- the same
/// unpinned-not-redundant trap this file already records for the CSG insert,
/// one step over.
#[test]
fn an_operand_shared_between_two_branches_is_not_a_cycle() {
    for (label, shared) in [
        ("boolean", "#10=IFCBOOLEANRESULT(.UNION.,#900,#901);\n"),
        ("csg", "#10=IFCCSGSOLID(#11);\n#11=IFCBOOLEANRESULT(.UNION.,#900,#901);\n"),
    ] {
        let data = format!(
            "#1=IFCBOOLEANRESULT(.UNION.,#2,#3);\n\
             #2=IFCBOOLEANRESULT(.UNION.,#900,#10);\n\
             #3=IFCBOOLEANRESULT(.UNION.,#900,#10);\n\
             {shared}\
             #900=IFCBLOCK($,1.,1.,1.);\n\
             #901=IFCBLOCK($,1.,1.,1.);\n"
        );
        let content = wrap_ifc(&data);
        let mut decoder = EntityDecoder::new(&content);
        let entity = decoder.decode_by_id(1).expect("decode #1");
        let processor = BooleanClippingProcessor::new();
        let schema = IfcSchema::new();
        let mesh = processor
            .process(&entity, &mut decoder, &schema, Default::default())
            .unwrap_or_else(|e| {
                panic!("{label}: an operand shared across two BRANCHES is not a cycle: {e}")
            });
        assert!(
            !mesh.positions.is_empty(),
            "{label}: the shared operand must contribute geometry"
        );
    }
}

/// A #3922-review hypothesis: `solo_step` was `spine.len() == 1`, applied
/// uniformly to every node in `spine`. But a longer chain's top-level batch
/// can fail for a reason specific to its OUTERMOST cutter while the very
/// next suffix batches cleanly, leaving `spine` holding only that outermost
/// node — `spine.len() == 1` — even though its cutter has siblings (the ones
/// the suffix already folded into the mesh). If that lone node then hits an
/// accept-gate rejection, the old `solo_step = true` sent it to the riskier
/// unbounded `FallThrough` instead of the safer `KeepUncut` — exactly the
/// over-cut `!solo_step` exists to prevent.
///
/// House.ifc wall #2152's real chain (fixture: issue #960) reproduces the
/// shape without any synthetic geometry: entity #2146 (8 PBHS cutters) is
/// the node whose own top-level batch fails (its accept-gate rejects), while
/// the very next level, #2145 (7 cutters), batches cleanly. In the full
/// wall-#2152 chain (topmost #2149, 11 cutters) that leaves #2146 as one of
/// 4 nodes still in `spine`, so `solo_step` was already correctly `false`
/// there. Entering the SAME real geometry graph directly at #2146 — a
/// perfectly valid `IfcBooleanClippingResult` node; nothing in the IFC
/// schema requires the chain above it to exist — simulates an authored
/// element whose own representation root IS #2146: `spine` then holds only
/// `[#2146]`, so the old code set `solo_step = true` even though #2146's
/// cutter has the same 7 siblings, already batched, right below it.
#[cfg(any(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]
#[test]
fn solo_step_accounts_for_a_batched_suffix_not_just_spine_length() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/models/issues/960_house_segmented_roof_clip.ifc");
    let content = match std::fs::read_to_string(&path) {
        Ok(s) if !s.starts_with("version https://git-lfs.github.com/spec/") => s,
        _ => {
            eprintln!(
                "skipping: fixture issues/960_house_segmented_roof_clip.ifc not present \
                 (or an LFS pointer) — run `pnpm fixtures`"
            );
            return;
        }
    };
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(2146).expect("decode #2146");
    let processor = BooleanClippingProcessor::new();
    let schema = IfcSchema::new();
    let mesh = processor
        .process(&entity, &mut decoder, &schema, TessellationQuality::Medium)
        .expect("process #2146 chain");
    assert!(!mesh.is_empty(), "#2146's chain must not render as empty");
    let (_, mx) = mesh.bounds();
    // Before the fix: `solo_step` was wrongly `true` here, so the accept-gate
    // rejection on #2146's own cutter fell through to the unbounded plane
    // clip and OVER-cut the already-batched 7-cutter result down to max
    // Z ~= 2735.6 mm. After the fix, `solo_step` is correctly `false` (the
    // 7-cutter suffix batched below #2146 means it is not alone), so the
    // rejection keeps that step's host un-cut instead, landing at
    // max Z ~= 4475.3 mm — the un-cut 7-cutter-batched mesh, not a
    // secondary over-cut of it.
    assert!(
        (mx.z - 4475.3).abs() < 1.0,
        "#2146 max Z = {:.1} mm, expected ~4475.3 mm (KeepUncut, not an \
         unbounded-fallback over-cut). A value near 2735.6 means solo_step \
         was miscomputed from spine.len() alone again, ignoring that a \
         nested batch already folded this cutter's siblings into the mesh.",
        mx.z,
    );
}

/// A SYNTHETIC, small hand-written fixture that makes the #4023 defect
/// ACTIVE (RED before the fix, GREEN after), unlike the real-fixture guard
/// above (whose #2146 entry point never reaches an accept-gate rejection —
/// see #4024's PR body for the ~50-node scan across every DIFFERENCE-chain
/// root in `960_house_segmented_roof_clip.ifc` that confirmed this).
///
/// Chain (innermost first): `G` (a plain 10x10x10 box) `-cutterF2->` `H`
/// `-cutterF1->` `F` `-cutterE->` `E`. `collect_polygonal_chain(E)` walks the
/// WHOLE left-spine PBHS chain in one call, so entering at `E` always
/// attempts to batch all three cutters together first
/// (`try_union_polygonal_chain`, verified below via bounds/failure evidence,
/// not asserted directly on private state). `cutterE`'s polygonal boundary
/// is a self-intersecting (bowtie) `IfcPolyline` — a structurally invalid
/// polygon whose extruded prism makes the CSG subtract produce a torn,
/// non-closed result. That trips the accept gate for the 3-cutter batch
/// attempt at `E`, so it defers; `process_with_depth_inner` pushes `E` onto
/// `spine` and walks down to `F`, whose OWN 2-cutter batch (`cutterF1`,
/// `cutterF2` — both ordinary, non-degenerate half-space slabs) succeeds
/// cleanly. That leaves `spine == [E]` with `based_on_batch == true`: the
/// exact shape `solo_step == spine.len() == 1` mis-reads as "no sibling".
///
/// Applying `E`'s own step then re-hits the SAME bowtie-cutter accept-gate
/// rejection, this time via `apply_boolean_step`'s single-cutter
/// `IfcPolygonalBoundedHalfSpace` branch
/// (`BooleanClippingProcessor::resolve_single_cutter_subtract`). Pre-fix,
/// `solo_step` is wrongly `true` there, so the rejection escalates to
/// `SingleCutterSubtract::FallThrough` — the unbounded plane clip at
/// `cutterE`'s plane (z = 2, agreement removes z > 2) — collapsing the
/// batched `F`/`H` result down to z in `[0, 2]` and x/y in `[-5, 3]`
/// (`F`'s own x > 3 slab already capped x at 3). Post-fix, `based_on_batch`
/// makes `solo_step` correctly `false`, so the same rejection instead takes
/// `SingleCutterSubtract::KeepUncut`: `E`'s cutter is dropped and the
/// batched `F`/`H` result (x, y in `[-5, 5]`, z in `[0, 10]`) is returned
/// un-cut.
///
/// Verified directly (not asserted, since it reads private state): on this
/// checkout, `collect_polygonal_chain(#450)` (E) returns cutters
/// `[240, 340, 440]` (all three); `try_union_polygonal_chain(#450)` returns
/// `None` (deferred) under both `csg_manifold_gate` and `csg_topology_gate`;
/// `try_union_polygonal_chain(#350)` (F) returns `Some` (batched) under
/// both. `cargo test --features csg_manifold_gate` records exactly one
/// `NonManifoldRejected { same_direction: 6, .. }` failure on this fixture
/// pre- and post-fix; `--features csg_topology_gate` records exactly one
/// `OpenTopologyRejected` either way — the SAME accept-gate rejection is
/// reached both times, only its fallback changes.
#[cfg(any(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]
#[test]
fn solo_step_batched_suffix_defect_is_active_on_a_synthetic_bowtie_cutter() {
    // G: a plain 10x10x10 box (IfcRectangleProfileDef is CENTERED on its
    // position, so this spans x, y in [-5, 5], z in [0, 10]).
    let base = "\
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCAXIS2PLACEMENT2D(#10,$);
#12=IFCRECTANGLEPROFILEDEF(.AREA.,$,#11,10.,10.);
#13=IFCCARTESIANPOINT((0.,0.,0.));
#14=IFCAXIS2PLACEMENT3D(#13,$,$);
#15=IFCDIRECTION((0.,0.,1.));
#16=IFCEXTRUDEDAREASOLID(#12,#14,#15,10.);
";
    // cutterF2 (innermost of the F/H suffix): ordinary half-space slab,
    // plane at y=3, removing y>3 across the full x/z extent.
    let cutter_f2 = "\
#200=IFCCARTESIANPOINT((0.,3.,0.));
#201=IFCDIRECTION((0.,1.,0.));
#202=IFCAXIS2PLACEMENT3D(#200,#201,$);
#203=IFCPLANE(#202);
#210=IFCCARTESIANPOINT((0.,3.,0.));
#211=IFCDIRECTION((0.,1.,0.));
#212=IFCDIRECTION((0.,0.,1.));
#213=IFCAXIS2PLACEMENT3D(#210,#211,#212);
#220=IFCCARTESIANPOINT((-6.,-6.));
#221=IFCCARTESIANPOINT((6.,-6.));
#222=IFCCARTESIANPOINT((6.,6.));
#223=IFCCARTESIANPOINT((-6.,6.));
#224=IFCCARTESIANPOINT((-6.,-6.));
#230=IFCPOLYLINE((#220,#221,#222,#223,#224));
#240=IFCPOLYGONALBOUNDEDHALFSPACE(#203,.F.,#213,#230);
#250=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#16,#240);
";
    // cutterF1 (outer half of the F/H suffix): ordinary half-space slab,
    // plane at x=3, removing x>3. Together F1+F2 batch cleanly in ONE call
    // (try_union_polygonal_chain from #350) since neither is degenerate.
    let cutter_f1 = "\
#300=IFCCARTESIANPOINT((3.,0.,0.));
#301=IFCDIRECTION((1.,0.,0.));
#302=IFCAXIS2PLACEMENT3D(#300,#301,$);
#303=IFCPLANE(#302);
#310=IFCCARTESIANPOINT((3.,0.,0.));
#311=IFCDIRECTION((1.,0.,0.));
#312=IFCDIRECTION((0.,0.,1.));
#313=IFCAXIS2PLACEMENT3D(#310,#311,#312);
#320=IFCCARTESIANPOINT((-6.,-6.));
#321=IFCCARTESIANPOINT((6.,-6.));
#322=IFCCARTESIANPOINT((6.,6.));
#323=IFCCARTESIANPOINT((-6.,6.));
#324=IFCCARTESIANPOINT((-6.,-6.));
#330=IFCPOLYLINE((#320,#321,#322,#323,#324));
#340=IFCPOLYGONALBOUNDEDHALFSPACE(#303,.F.,#313,#330);
#350=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#250,#340);
";
    // cutterE (outermost, E's own cutter): a SELF-INTERSECTING (bowtie)
    // IfcPolyline boundary -- (-4,-4)->(4,4)->(4,-4)->(-4,4)->(-4,-4) crosses
    // itself at the origin -- at plane z=2, removing z>2. Extruding this
    // invalid polygon into a prism and subtracting it is what trips the
    // accept gate, both as part of E's own 3-cutter top-level batch attempt
    // and again at E's single-cutter step once the F/H suffix has batched.
    let cutter_e = "\
#400=IFCCARTESIANPOINT((0.,0.,2.));
#401=IFCDIRECTION((0.,0.,1.));
#402=IFCAXIS2PLACEMENT3D(#400,#401,$);
#403=IFCPLANE(#402);
#410=IFCCARTESIANPOINT((0.,0.,2.));
#411=IFCDIRECTION((0.,0.,1.));
#412=IFCDIRECTION((1.,0.,0.));
#413=IFCAXIS2PLACEMENT3D(#410,#411,#412);
#420=IFCCARTESIANPOINT((-4.,-4.));
#421=IFCCARTESIANPOINT((4.,4.));
#422=IFCCARTESIANPOINT((4.,-4.));
#423=IFCCARTESIANPOINT((-4.,4.));
#424=IFCCARTESIANPOINT((-4.,-4.));
#430=IFCPOLYLINE((#420,#421,#422,#423,#424));
#440=IFCPOLYGONALBOUNDEDHALFSPACE(#403,.F.,#413,#430);
#450=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#350,#440);
";
    let content = wrap_ifc(&format!("{base}{cutter_f2}{cutter_f1}{cutter_e}"));
    let mut decoder = EntityDecoder::new(&content);
    let processor = BooleanClippingProcessor::new();
    let entity = decoder.decode_by_id(450).expect("decode #450");
    let mesh = processor
        .process(&entity, &mut decoder, &IfcSchema::new(), TessellationQuality::Medium)
        .expect("process #450 chain");
    assert!(!mesh.is_empty(), "#450's chain must not render as empty");

    // The accept gate must actually have fired (this fixture is worthless as
    // a RED/GREEN unless a real rejection was observed, not just an empty
    // failure list that happens to leave bounds unchanged).
    let failures = processor.take_failures();
    assert!(
        failures.iter().any(|f| matches!(
            f.reason,
            BoolFailureReason::OpenTopologyRejected | BoolFailureReason::NonManifoldRejected { .. }
        )),
        "expected an accept-gate rejection (OpenTopologyRejected / \
         NonManifoldRejected) on the bowtie cutterE subtract; got {failures:?}"
    );

    let (_, mx) = mesh.bounds();
    // Before the fix: `solo_step` was wrongly `true` (spine.len() == 1,
    // ignoring `based_on_batch`), so the gate rejection escalated to
    // FallThrough and applied cutterE's unbounded plane clip (z > 2 removed)
    // on top of cutterF1's own x > 3 cap, landing at max ~= (3, 3, 2).
    // After the fix, `based_on_batch` is threaded through, `solo_step` is
    // correctly `false`, and the rejection takes KeepUncut instead: cutterE
    // is dropped entirely and the F/H batched result is returned un-cut, at
    // its true extent, max ~= (5, 5, 10).
    assert!(
        (mx.x - 5.0).abs() < 1.0e-3 && (mx.y - 5.0).abs() < 1.0e-3 && (mx.z - 10.0).abs() < 1.0e-3,
        "max bounds = {mx:?}, expected ~(5, 5, 10) (KeepUncut: cutterE dropped, \
         F/H batched result returned un-cut). ~(3, 3, 2) means solo_step was \
         miscomputed from spine.len() alone again, ignoring that a nested \
         batch already folded this cutter's siblings into the mesh."
    );
}

