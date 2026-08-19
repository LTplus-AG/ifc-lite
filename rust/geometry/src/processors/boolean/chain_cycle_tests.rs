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
    let outcome = rx.recv_timeout(std::time::Duration::from_secs(10));
    assert!(outcome.is_ok(), "collect_polygonal_chain hung (walk did not terminate)");
    let _ = handle.join();
    outcome.unwrap().expect("collect_polygonal_chain returned Err")
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

    let outcome = rx.recv_timeout(std::time::Duration::from_secs(5));
    assert!(
        outcome.is_ok(),
        "collect_polygonal_chain hung on a cyclic FirstOperand chain"
    );
    let _ = handle.join();

    let (base_id, cutter_count) = outcome
        .unwrap()
        .expect("collect_polygonal_chain returned Err");
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
    let outcome = rx.recv_timeout(std::time::Duration::from_secs(10));
    assert!(outcome.is_ok(), "full process() hung on a cyclic boolean chain");
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

    let outcome = rx.recv_timeout(std::time::Duration::from_secs(10));
    assert!(
        outcome.is_ok(),
        "Boolean/CSG mutual recursion did not terminate"
    );
    let _ = handle.join();

    // The cycle is reported, not silently swallowed: an operand that cannot be
    // resolved must surface as an error so the router drops the element rather
    // than rendering a half-built solid as if it were complete.
    let err = outcome.unwrap().expect_err("a cyclic operand must be an error");
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

    let outcome = rx.recv_timeout(std::time::Duration::from_secs(10));
    assert!(outcome.is_ok(), "CsgSolid entry point did not terminate");
    let _ = handle.join();
    outcome
        .unwrap()
        .expect_err("a cyclic operand must be an error from this entry point too");
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

    let content = wrap_ifc(&data);
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(1).expect("decode #1");
    let processor = BooleanClippingProcessor::new();
    let schema = IfcSchema::new();
    let err = processor
        .process(&entity, &mut decoder, &schema, Default::default())
        .expect_err("an over-long operand chain must be reported, not rendered half-built");
    assert!(
        err.to_string().contains("operand chain exceeds"),
        "expected the chain bound to be named, got: {err}"
    );
}
