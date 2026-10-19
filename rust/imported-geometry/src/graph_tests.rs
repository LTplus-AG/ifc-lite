// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

fn node(path: &str, children: &[(&str, u32)]) -> Node {
    Node { path: path.into(), children: children.iter().map(|(edge, id)| ((*edge).into(), *id)).collect() }
}
fn attributes(entity: bool, mesh: bool, points: bool) -> NodeReply {
    NodeReply { has_entity: entity, has_mesh: mesh, has_points: points, opacity: 1., ..NodeReply::default() }
}
fn event(program: &mut GraphProgram) -> Event { program.poll().unwrap().unwrap().clone() }
fn triangle() -> RawMesh {
    RawMesh { points: vec![vec![0., 0., 0.], vec![1., 0., 0.], vec![0., 1., 0.]],
        face_vertex_indices: vec![0., 1., 2.], face_vertex_counts: None, normals: None }
}
fn translation(x: f64, y: f64, z: f64) -> RawMatrix {
    vec![vec![1., 0., 0., 0.], vec![0., 1., 0., 0.], vec![0., 0., 1., 0.], vec![x, y, z, 1.]]
}
fn to_mesh_source(program: &mut GraphProgram, reply: NodeReply, key: &str) -> Event {
    let request = event(program);
    program.node_reply(request.sequence, reply).unwrap();
    let request = event(program);
    assert!(matches!(request.kind, EventKind::Key { .. }));
    program.key_reply(request.sequence, key.into()).unwrap();
    let request = event(program);
    assert!(matches!(request.kind, EventKind::MeshSource));
    request
}

#[test]
fn imported_graph_order_preserves_dag_occurrences_and_omits_only_path_cycles() {
    // Two roots share a child; a disconnected cycle still gets one seed.
    let nodes = vec![node("root-a", &[("first", 2), ("second", 3)]), node("root-b", &[("alias", 2)]),
        node("shared", &[("back", 0)]), node("leaf", &[]), node("cycle-a", &[("to-b", 5)]),
        node("cycle-b", &[("to-a", 4)]), node("root-c", &[])];
    let mut p = GraphProgram::new(7, 11, 3, nodes).unwrap();
    let mut visited = Vec::new();
    let mut lineages = Vec::new();
    while let Some(request) = p.poll().unwrap().cloned() {
        let EventKind::Node(lineage) = request.kind else { panic!("unexpected source request"); };
        visited.push((request.node, request.frame));
        lineages.push(lineage);
        p.node_reply(request.sequence, attributes(false, false, false)).unwrap();
    }
    // root-a has incoming from shared, so root-b's component comes first.
    let order = vec![1, 2, 0, 3, 6, 4, 5];
    assert_eq!(visited.iter().map(|(node, _)| *node).collect::<Vec<_>>(), [order.clone(), order].concat());
    assert!(visited.windows(2).all(|pair| pair[0].1 < pair[1].1));
    assert_eq!(lineages[3].iter().map(|e| e.node).collect::<Vec<_>>(), vec![1, 2, 0, 3]);
    assert_eq!(lineages[3][3].edge.as_deref(), Some("second"));
    assert_eq!(lineages[4], vec![LineageEntry { node: 6, edge: None }]);

    let mut diamond = GraphProgram::new(1, 1, 1, vec![node("a", &[("b", 1), ("c", 2)]),
        node("b", &[("d", 3)]), node("c", &[("d", 3)]), node("d", &[])]).unwrap();
    let mut order = Vec::new();
    while let Some(request) = diamond.poll().unwrap().cloned() {
        order.push(request.node);
        diamond.node_reply(request.sequence, attributes(false, false, false)).unwrap();
    }
    assert_eq!(order, vec![0, 1, 3, 2, 3]);
}

#[test]
fn imported_graph_raw_transform_context_and_ack_control_real_triangle_execution() {
    let mut p = GraphProgram::new(19, 29, 1, vec![node("entity", &[("Body", 1)]), node("shape", &[])]).unwrap();
    let root = event(&mut p);
    p.node_reply(root.sequence, NodeReply { local_transform: Some(translation(10., 20., 30.)),
        diffuse: Some(vec![0.2, 0.3, 0.4]), opacity: 0.5, ..attributes(true, false, false) }).unwrap();
    let child = event(&mut p);
    assert_eq!(child.node, 1);
    p.node_reply(child.sequence, NodeReply { local_transform: Some(translation(2., 0., 0.)),
        original_step_instance: Some("#9=IFCWALLTYPE();".into()), ..attributes(false, true, false) }).unwrap();
    let key = event(&mut p);
    assert_eq!(key.context, Some(0)); // Type metadata without an entity never replaces context.
    let EventKind::Key { transform: Some(transform), color } = key.kind else { panic!("key"); };
    assert_eq!(&transform[12..15], &[12., 20., 30.]);
    assert_eq!(color, Some([0.2, 0.3, 0.4, 0.5]));
    p.key_reply(key.sequence, "shape|entity|transform|color".into()).unwrap();
    let source = event(&mut p);
    p.mesh_reply(source.sequence, triangle()).unwrap();
    let output = p.poll().unwrap().unwrap();
    let EventKind::MeshOutput { output, .. } = &output.kind else { panic!("mesh"); };
    assert_eq!(output.positions, vec![12., 30., -20., 13., 30., -20., 12., 30., -21.]);
    assert_eq!(output.indices, vec![0, 1, 2]);
    assert_eq!(output.normals, vec![0., 1., 0., 0., 1., 0., 0., 1., 0.]);
    let sequence = event(&mut p).sequence;
    assert_eq!(event(&mut p).sequence, sequence);
    let retained = &p.retained()[0];
    assert_eq!(retained.identity, ImportIdentity { store: 19, revision: 29, definition: 2, occurrence: 2 });
    assert_eq!(retained.transform_stack.len(), 2);
    let ImportedSource::Mesh(raw) = retained.source.as_ref() else { panic!("raw mesh"); };
    assert_eq!(raw.points[1], vec![1., 0., 0.]);
    p.ack(sequence).unwrap();
    assert!(p.pending.is_none()); // Output buffers have no retained second owner after ACK.
    assert!(p.poll().unwrap().is_none());
    assert_eq!(p.retained().len(), 1);
}

#[test]
fn imported_graph_alias_key_is_recorded_before_source_and_stale_replies_preserve_pending() {
    let mut p = GraphProgram::new(1, 2, 1, vec![node("entity", &[("first", 1), ("alias", 1)]), node("mesh", &[])]).unwrap();
    let root = event(&mut p);
    p.node_reply(root.sequence, attributes(true, false, false)).unwrap();
    let source = to_mesh_source(&mut p, attributes(false, true, false), "same");
    assert_eq!(p.ack(source.sequence), Err(ImportError::IdentityMismatch));
    assert_eq!(p.mesh_reply(source.sequence + 1, triangle()), Err(ImportError::IdentityMismatch));
    assert_eq!(event(&mut p).sequence, source.sequence);
    p.mesh_reply(source.sequence, triangle()).unwrap();
    let output = event(&mut p);
    assert_eq!(p.key_reply(output.sequence, "foreign".into()), Err(ImportError::IdentityMismatch));
    p.ack(output.sequence).unwrap();
    let alias = event(&mut p);
    p.node_reply(alias.sequence, attributes(false, true, false)).unwrap();
    let key = event(&mut p);
    p.key_reply(key.sequence, "same".into()).unwrap();
    assert!(p.poll().unwrap().is_none());
    assert_eq!(p.retained().len(), 1);
}

#[test]
fn imported_graph_latest_visibility_and_entity_type_inheritance_gate_malformed_sources() {
    let mut p = GraphProgram::new(1, 1, 1, vec![node("hidden", &[("show", 1), ("typed", 2)]),
        node("shown", &[]), node("type", &[("instance", 3)]), node("nested", &[])]).unwrap();
    let root = event(&mut p);
    let mut malformed = translation(0., 0., 0.); malformed[3][3] = 0.;
    p.node_reply(root.sequence, NodeReply { visibility: Some("INVISIBLE".into()),
        local_transform: Some(malformed), ..attributes(true, true, false) }).unwrap();
    let child = event(&mut p); // Hidden malformed mesh never requested.
    assert_eq!(child.node, 1);
    p.node_reply(child.sequence, NodeReply { visibility: Some("visible".into()), ..attributes(false, true, false) }).unwrap();
    let key = event(&mut p); assert!(matches!(key.kind, EventKind::Key { .. }));
    p.key_reply(key.sequence, "skip-for-test".into()).unwrap();
    // Execute no vertices: malformed w validation belongs to executed geometry.
    let source = event(&mut p);
    p.mesh_reply(source.sequence, RawMesh { points: vec![], ..triangle() }).unwrap();
    let output = event(&mut p); p.ack(output.sequence).unwrap();
    let typed = event(&mut p);
    p.node_reply(typed.sequence, NodeReply { original_step_instance: Some("#1=iFcWaLlTyPe();".into()),
        visibility: Some("visible".into()), ..attributes(true, true, false) }).unwrap();
    let nested = event(&mut p); assert_eq!(nested.node, 3);
    p.node_reply(nested.sequence, attributes(true, true, false)).unwrap();
    assert!(p.poll().unwrap().is_none());
}

#[test]
fn imported_graph_points_execute_without_dedup_and_retain_raw_precision_once() {
    let mut p = GraphProgram::new(3, 4, 2, vec![node("entity", &[("one", 1), ("two", 1)]), node("cloud", &[])]).unwrap();
    let root = event(&mut p);
    p.node_reply(root.sequence, NodeReply { local_transform: Some(translation(5., 6., 7.)), ..attributes(true, false, false) }).unwrap();
    for expected_count in 1..=2 {
        let reached = event(&mut p);
        p.node_reply(reached.sequence, attributes(false, false, true)).unwrap();
        let source = event(&mut p); assert!(matches!(source.kind, EventKind::PointsSource));
        let positions = vec![1.0000000001, 2., 3., -1., -2., -3.];
        let pointer = positions.as_ptr();
        p.points_reply(source.sequence, Some(PointsReply { positions, colors: Some(vec![0.1, 0.2, 0.3]),
            count: 2., precision: "float64".into(), encoding: "inline".into() })).unwrap();
        let request = p.poll().unwrap().unwrap();
        let EventKind::PointsOutput { output, colors, count } = &request.kind else { panic!("points"); };
        assert_eq!(output.positions, vec![6., 10., -8., 4., 4., -4.]);
        assert_eq!(output.min, [4., 4., -8.]); assert_eq!(output.max, [6., 10., -4.]);
        assert_eq!(*count, 2.); assert_eq!(colors.as_deref(), Some([0.1_f32, 0.2, 0.3].as_slice()));
        let sequence = request.sequence;
        let retained = p.retained().last().unwrap();
        let ImportedSource::Points(raw) = retained.source.as_ref() else { panic!("raw points"); };
        if expected_count == 1 {
            assert_eq!(raw.as_ptr(), pointer); // The first admission moves its numeric buffer.
        } else {
            assert!(Arc::ptr_eq(&p.retained()[0].source, &retained.source));
            assert!(Arc::ptr_eq(p.retained()[0].points.as_ref().unwrap(), retained.points.as_ref().unwrap()));
        }
        assert_eq!(raw[0], 1.0000000001);
        let metadata = retained.points.as_ref().unwrap();
        assert_eq!(metadata.precision, "float64"); assert_eq!(metadata.encoding, "inline");
        assert_eq!(metadata.colors.as_deref(), Some([0.1, 0.2, 0.3].as_slice()));
        p.ack(sequence).unwrap(); assert!(p.pending.is_none());
        assert_eq!(p.retained().len(), expected_count);
    }
    assert!(p.poll().unwrap().is_none());
}

#[test]
fn imported_graph_numeric_failure_is_terminal_and_never_reissues_source() {
    for mesh in [true, false] {
        let mut p = GraphProgram::new(1, 1, if mesh { 1 } else { 2 }, vec![node("bad", &[])]).unwrap();
        let mut malformed = translation(0., 0., 0.); malformed[3][3] = 0.;
        let reached = event(&mut p);
        p.node_reply(reached.sequence, NodeReply { local_transform: Some(malformed), ..attributes(true, true, true) }).unwrap();
        if mesh { let key = event(&mut p); p.key_reply(key.sequence, "bad".into()).unwrap(); }
        let source = event(&mut p);
        let error = if mesh {
            p.mesh_reply(source.sequence, triangle()).unwrap_err()
        } else {
            p.points_reply(source.sequence, Some(PointsReply { positions: vec![1., 2., 3.], colors: None,
                count: 1., precision: "float64".into(), encoding: "inline".into() })).unwrap_err()
        };
        assert_eq!(error, if mesh { ImportError::HomogeneousMesh } else { ImportError::HomogeneousPoints });
        assert_eq!(p.poll().unwrap_err(), error);
        assert_eq!(p.node_reply(0, attributes(true, true, true)), Err(error.clone()));
        assert_eq!(p.ack(source.sequence), Err(error));
        assert!(p.pending.is_none()); assert!(p.queue.is_empty()); assert!(p.retained().is_empty());
    }
}

#[test]
fn composed_cycle_stubs_use_path_seed_identity_and_original_map_order() {
    let nodes = vec![node("A", &[("to-b", 1)]), node("B", &[("to-stub", 3)]),
        node("R", &[]), node("A", &[])];
    let mut program = GraphProgram::with_candidates(1, 1, 1, nodes, 3).unwrap();
    let mut order = Vec::new();
    while let Some(request) = program.poll().unwrap().cloned() {
        order.push(request.node);
        program.node_reply(request.sequence, attributes(false, false, false)).unwrap();
    }
    assert_eq!(order, [2, 0, 1]);
}

#[test]
fn imported_definition_cannot_change_source_or_codec_metadata_within_one_revision() {
    for change_metadata in [false, true] {
        let mut p = GraphProgram::new(1, 2, 2, vec![node("entity", &[("one", 1), ("two", 1)]), node("points", &[])]).unwrap();
        let root = event(&mut p);
        p.node_reply(root.sequence, attributes(true, false, false)).unwrap();
        for occurrence in 0..2 {
            let reached = event(&mut p);
            p.node_reply(reached.sequence, attributes(false, false, true)).unwrap();
            let request = event(&mut p);
            let positions = if occurrence == 1 && !change_metadata { vec![42., 2., 3.] } else { vec![1., 2., 3.] };
            let precision = if occurrence == 1 && change_metadata { "changed" } else { "f64" };
            let result = p.points_reply(request.sequence, Some(PointsReply { positions, colors: None,
                count: 1., precision: precision.into(), encoding: "inline".into() }));
            if occurrence == 0 {
                result.unwrap(); let output = event(&mut p); p.ack(output.sequence).unwrap();
            } else {
                assert_eq!(result, Err(ImportError::IdentityMismatch));
                assert_eq!(p.poll().unwrap_err(), ImportError::IdentityMismatch);
            }
        }
        assert_eq!(p.retained().len(), 1);
        let ImportedSource::Points(raw) = p.retained()[0].source.as_ref() else { panic!("points source"); };
        assert_eq!(raw, &[1., 2., 3.]);
    }
}

#[test]
fn inherited_visibility_keeps_an_invisible_ancestor_hidden() {
    for (child, hidden) in [("inherited", true), ("INHERITED", true), ("visible", false), ("invisible", true)] {
        let mut p = GraphProgram::new(1, 1, 1, vec![node("root", &[("child", 1)]), node("child", &[])]).unwrap();
        let root = event(&mut p);
        p.node_reply(root.sequence, NodeReply { visibility: Some("invisible".into()), ..attributes(true, false, false) }).unwrap();
        let reached = event(&mut p);
        p.node_reply(reached.sequence, NodeReply { visibility: Some(child.into()), ..attributes(false, true, false) }).unwrap();
        let emitted = matches!(p.poll().unwrap().map(|e| &e.kind), Some(EventKind::Key { .. }));
        assert_eq!(emitted, !hidden, "{child}");
    }
}

fn drain_root(p: &mut GraphProgram, reply: NodeReply) -> Result<(), ImportError> {
    let root = event(p);
    p.node_reply(root.sequence, reply)
}

#[test]
fn repeated_child_fan_out_is_refused_by_the_queue_budget() {
    let edges = vec![("edge", 1u32); 400];
    let mut p = GraphProgram::new(1, 1, 1, vec![node("root", &edges), node("leaf", &[])]).unwrap();
    p.limits.queued_bytes = 20_000;
    assert_eq!(drain_root(&mut p, attributes(true, false, false)), Err(ImportError::InvalidPacket));
    assert_eq!(p.poll().unwrap_err(), ImportError::InvalidPacket);
    // The same graph is fine under the production budget.
    let mut p = GraphProgram::new(1, 1, 1, vec![node("root", &edges), node("leaf", &[])]).unwrap();
    drain_root(&mut p, attributes(true, false, false)).unwrap();
    assert_eq!(p.queue.len(), 400);
}

#[test]
fn long_edge_names_count_against_the_queue_budget() {
    let long = "x".repeat(1 << 20);
    let nodes = vec![Node { path: "root".into(), children: (0..300).map(|_| (long.clone(), 1)).collect() }, node("leaf", &[])];
    let mut p = GraphProgram::new(1, 1, 1, nodes).unwrap();
    assert_eq!(drain_root(&mut p, attributes(true, false, false)), Err(ImportError::InvalidPacket));
    assert!(p.queue.len() < 300);
}

#[test]
fn depth_and_total_frame_limits_refuse_the_program() {
    let chain = vec![node("a", &[("e", 1)]), node("b", &[("e", 2)]), node("c", &[("e", 3)]), node("d", &[])];
    let run = |p: &mut GraphProgram| loop {
        match p.poll() {
            Ok(Some(request)) => { let s = request.sequence; if let Err(e) = p.node_reply(s, attributes(true, false, false)) { return Some(e); } }
            Ok(None) => return None,
            Err(e) => return Some(e),
        }
    };
    let mut p = GraphProgram::new(1, 1, 1, chain.clone()).unwrap();
    assert_eq!(run(&mut p), None);
    let mut p = GraphProgram::new(1, 1, 1, chain.clone()).unwrap();
    p.limits.depth = 3;
    assert_eq!(run(&mut p), Some(ImportError::InvalidPacket));
    let mut p = GraphProgram::new(1, 1, 1, chain).unwrap();
    p.limits.frames = 2;
    assert_eq!(run(&mut p), Some(ImportError::InvalidPacket));
}

#[test]
fn oversized_local_transforms_are_refused() {
    for matrix in [vec![vec![0.; 4]; 5], vec![vec![0.; 100_000]], vec![vec![1., 0., 0., 0., 0.]]] {
        let mut p = GraphProgram::new(1, 1, 1, vec![node("root", &[])]).unwrap();
        let reply = NodeReply { local_transform: Some(matrix), ..attributes(true, false, false) };
        assert_eq!(drain_root(&mut p, reply), Err(ImportError::InvalidPacket));
        assert_eq!(p.poll().unwrap_err(), ImportError::InvalidPacket);
    }
    let mut p = GraphProgram::new(1, 1, 1, vec![node("root", &[])]).unwrap();
    drain_root(&mut p, NodeReply { local_transform: Some(translation(1., 2., 3.)), ..attributes(true, false, false) }).unwrap();
}
