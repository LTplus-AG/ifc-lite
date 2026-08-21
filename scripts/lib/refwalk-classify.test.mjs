#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the refwalk recursion classifier (issue #2944 feasibility
 * study), over synthetic fixtures rather than real repo source -- following
 * the same convention as check-source-text-assertions.mjs's allowlist: real
 * source drifts, and a test that depends on a specific line in
 * rust/geometry/src would break for reasons unrelated to the classifier.
 *
 * Run: node --test scripts/lib/refwalk-classify.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFunctions,
  findRecursiveFunctions,
  extractLoopBodies,
  findChaseLoopFunctions,
  classifyFile,
} from './refwalk-classify.mjs';

test('extractFunctions finds a simple function and its body', () => {
  const src = `
fn foo(x: u32) -> u32 {
    x + 1
}
`;
  const fns = extractFunctions(src);
  assert.equal(fns.length, 1);
  assert.equal(fns[0].name, 'foo');
  assert.match(fns[0].body, /x \+ 1/);
});

test('extractFunctions is not confused by generic angle brackets in the signature', () => {
  const src = `
fn get<T>(decoder: &mut EntityDecoder, id: u32) -> Result<T, Error> {
    decoder.decode_by_id(id)
}
`;
  const fns = extractFunctions(src);
  assert.equal(fns.length, 1);
  assert.equal(fns[0].name, 'get');
});

test('extractFunctions skips trait method declarations with no body', () => {
  const src = `
trait Foo {
    fn bar(&self) -> u32;
}
fn baz() -> u32 { 1 }
`;
  const fns = extractFunctions(src);
  assert.deepEqual(fns.map((f) => f.name), ['baz']);
});

test('findRecursiveFunctions detects direct self-recursion', () => {
  const src = `
fn walk(id: u32, decoder: &mut EntityDecoder, depth: u32) -> Vec<u32> {
    if depth > 32 { return vec![]; }
    let e = decoder.decode_by_id(id).unwrap();
    walk(e.next_id, decoder, depth + 1)
}
`;
  const fns = extractFunctions(src);
  const rec = findRecursiveFunctions(fns);
  assert.ok(rec.has('walk'));
});

test('findRecursiveFunctions detects mutual recursion across two functions', () => {
  const src = `
fn a(id: u32, decoder: &mut EntityDecoder, depth: u32) -> u32 {
    b(id, decoder, depth + 1)
}
fn b(id: u32, decoder: &mut EntityDecoder, depth: u32) -> u32 {
    let e = decoder.decode_by_id(id).unwrap();
    a(e.parent, decoder, depth + 1)
}
`;
  const fns = extractFunctions(src);
  const rec = findRecursiveFunctions(fns);
  assert.ok(rec.has('a'));
  assert.ok(rec.has('b'));
});

test('findRecursiveFunctions does NOT flag a plain bounded loop that calls a non-recursive helper', () => {
  const src = `
fn extract_edge_loop_points(loop_entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Vec<Point3> {
    let edges = loop_entity.get(0).and_then(|a| a.as_list()).unwrap();
    let mut points = Vec::new();
    for edge_ref in edges {
        let edge_id = edge_ref.as_entity_ref().unwrap();
        let oriented_edge = decoder.decode_by_id(edge_id).unwrap();
        points.push(sample_edge(oriented_edge, decoder));
    }
    points
}

fn sample_edge(edge: DecodedEntity, decoder: &mut EntityDecoder) -> Point3 {
    let p = decoder.decode_by_id(edge.id).unwrap();
    Point3::origin()
}
`;
  const fns = extractFunctions(src);
  const rec = findRecursiveFunctions(fns);
  assert.equal(rec.size, 0);
});

test('classifyFile: edge_loop.rs shape (bounded for-loop over a fixed list) is NOT flagged', () => {
  const src = `
fn extract_edge_loop_points(loop_entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Vec<Point3> {
    let edges = loop_entity.get(0).and_then(|a| a.as_list()).unwrap();
    let mut points = Vec::new();
    for edge_ref in edges {
        let edge_id = edge_ref.as_entity_ref().unwrap();
        let oriented_edge = decoder.decode_by_id(edge_id).unwrap();
        points.push(process(oriented_edge));
    }
    points
}
`;
  const result = classifyFile(src);
  assert.deepEqual(result.flagged, []);
  assert.deepEqual(result.bounded, ['extract_edge_loop_points']);
});

test('classifyFile: a self-recursive reference chase (visited/depth guarded) IS flagged', () => {
  const src = `
fn sample_curve_polyline_guarded(curve_id: u32, decoder: &mut EntityDecoder, depth: u32, visited: &mut HashSet<u32>) -> Vec<Point3> {
    if depth >= MAX_DEPTH || !visited.insert(curve_id) {
        return Vec::new();
    }
    let curve = decoder.decode_by_id(curve_id).unwrap();
    let basis_id = curve.get(0).and_then(|a| a.as_entity_ref()).unwrap();
    sample_curve_polyline_guarded(basis_id, decoder, depth + 1, visited)
}
`;
  const result = classifyFile(src);
  assert.deepEqual(result.flagged, ['sample_curve_polyline_guarded']);
  assert.deepEqual(result.bounded, []);
});

test('classifyFile: a decode call in a function with no cycle at all is bounded, not flagged, even with zero loops', () => {
  const src = `
fn lookup_name(id: u32, decoder: &mut EntityDecoder) -> Option<String> {
    let e = decoder.decode_by_id(id).ok()?;
    e.get(2).and_then(|a| a.as_string())
}
`;
  const result = classifyFile(src);
  assert.deepEqual(result.flagged, []);
  assert.deepEqual(result.bounded, ['lookup_name']);
});

test('findRecursiveFunctions does NOT treat a call through an unrelated field as self-recursion (cross-struct name collision)', () => {
  // The false-positive class measured against rust/geometry/src's
  // extrusion.rs / sectioned.rs / swept/*.rs: two distinct structs each
  // define a method named `process`, and one dispatches to the OTHER's
  // `process` through a field, not to itself.
  const src = `
fn process(self_entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<Mesh> {
    let profile_entity = decoder.decode_by_id(self_entity.id)?;
    let profile = self.profile_processor.process(&profile_entity, decoder)?;
    Ok(profile)
}
`;
  const fns = extractFunctions(src);
  const rec = findRecursiveFunctions(fns);
  assert.equal(rec.size, 0, 'self.field.process(...) must not read as process calling itself');
});

test('findRecursiveFunctions DOES treat self.name(...) (no intervening field) as self-recursion', () => {
  const src = `
fn process_with_depth(entity: &DecodedEntity, decoder: &mut EntityDecoder, depth: u32) -> Result<Mesh> {
    let child = decoder.decode_by_id(entity.child_id)?;
    self.process_with_depth(&child, decoder, depth + 1)
}
`;
  const fns = extractFunctions(src);
  const rec = findRecursiveFunctions(fns);
  assert.ok(rec.has('process_with_depth'));
});

test('classifyFile: mutual recursion split across process_with_depth / process_operand_with_depth is flagged on both', () => {
  const src = `
fn process_with_depth(entity: &DecodedEntity, decoder: &mut EntityDecoder, depth: u32) -> Result<Mesh> {
    if depth > MAX_BOOLEAN_DEPTH { return Err(Error::TooDeep); }
    let first = process_operand_with_depth(&entity.first, decoder, depth)?;
    Ok(first)
}

fn process_operand_with_depth(operand_id: &u32, decoder: &mut EntityDecoder, depth: u32) -> Result<Mesh> {
    let operand = decoder.decode_by_id(*operand_id)?;
    process_with_depth(&operand, decoder, depth + 1)
}
`;
  const result = classifyFile(src);
  assert.deepEqual(result.flagged.sort(), ['process_operand_with_depth', 'process_with_depth']);
});

// --- chase-loop signal (issue #2944 follow-up: a walk that follows
// references WITHOUT recursing, by reassigning its cursor variable from
// resolve_ref/decode_by_id each iteration -- structurally invisible to
// findRecursiveFunctions above, since the function never calls itself). ---

test('extractLoopBodies finds a for-loop body and excludes the braces', () => {
  const src = `
fn f() {
    for i in 0..3 {
        do_thing(i);
    }
}
`;
  const bodies = extractLoopBodies(src);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /do_thing\(i\)/);
  assert.equal(bodies[0].includes('for'), false);
});

test('extractLoopBodies is not confused by a for-loop condition containing brackets', () => {
  const src = `
fn f(v: &[u32]) {
    for x in v.iter().filter(|y| **y > 0) {
        consume(x);
    }
}
`;
  const bodies = extractLoopBodies(src);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /consume\(x\)/);
});

test('findChaseLoopFunctions flags a loop that reassigns its cursor directly from resolve_ref, chasing an attribute of itself (probe.rs extract_extrusion_direction_recursive shape)', () => {
  const src = `
fn walk_despite_its_name(item: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<Thing> {
    let mut current = item.clone();
    let mut visited = FxHashSet::default();
    for _depth in 0..MAX_DEPTH {
        if !visited.insert(current.id) {
            return None;
        }
        let next_attr = current.get(1)?;
        current = decoder.resolve_ref(next_attr).ok()??;
    }
    None
}
`;
  const fns = extractFunctions(src);
  const chase = findChaseLoopFunctions(fns);
  assert.ok(chase.has('walk_despite_its_name'));
  assert.equal(chase.get('walk_despite_its_name').guarded, true);
});

test('findChaseLoopFunctions flags a loop where the decode call feeds the cursor through an intermediate let binding, not the same statement (collect_polygonal_chain / #2866-fix layers.rs shape)', () => {
  const src = `
fn chase_first_operand(entity: DecodedEntity, decoder: &mut EntityDecoder) -> DecodedEntity {
    let mut cur = entity;
    let mut visited: HashSet<u32> = HashSet::new();
    loop {
        if !visited.insert(cur.id) {
            return cur;
        }
        let Some(first_operand_id) = cur.get_ref(1) else {
            return cur;
        };
        let next = match decoder.decode_by_id(first_operand_id) {
            Ok(e) => e,
            Err(_) => return cur,
        };
        cur = next;
    }
}
`;
  const fns = extractFunctions(src);
  const chase = findChaseLoopFunctions(fns);
  assert.ok(chase.has('chase_first_operand'));
  assert.equal(chase.get('chase_first_operand').guarded, true);
});

test('findChaseLoopFunctions does NOT flag a bounded for-loop over a list bound before the loop, even though it reassigns a `let` binding each iteration (edge_loop.rs shape)', () => {
  const src = `
fn extract_edge_loop_points(loop_entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Vec<Point3> {
    let edges = loop_entity.get(0).and_then(|a| a.as_list()).unwrap();
    let mut points = Vec::new();
    for edge_ref in edges {
        let edge_id = edge_ref.as_entity_ref().unwrap();
        let oriented_edge = decoder.decode_by_id(edge_id).unwrap();
        points.push(sample_edge(oriented_edge, decoder));
    }
    points
}
`;
  const fns = extractFunctions(src);
  const chase = findChaseLoopFunctions(fns);
  assert.equal(chase.size, 0);
});

test('findChaseLoopFunctions does NOT flag a loop that decodes a fixed id each iteration without ever reassigning a pre-existing cursor variable', () => {
  const src = `
fn lookup_each(ids: &[u32], decoder: &mut EntityDecoder) -> Vec<Option<DecodedEntity>> {
    let mut out = Vec::new();
    for id in ids {
        let entity = decoder.decode_by_id(*id).ok();
        out.push(entity);
    }
    out
}
`;
  const fns = extractFunctions(src);
  const chase = findChaseLoopFunctions(fns);
  assert.equal(chase.size, 0);
});

test('findChaseLoopFunctions reports guarded: false for the same chase shape with no visited set or depth cap (the #2866 main-branch layers.rs shape, structurally as a loop rather than its real self-recursion)', () => {
  const src = `
fn chase_without_a_guard(entity: DecodedEntity, decoder: &mut EntityDecoder) -> DecodedEntity {
    let mut cur = entity;
    loop {
        let Some(first_operand_id) = cur.get_ref(1) else {
            return cur;
        };
        let next = match decoder.decode_by_id(first_operand_id) {
            Ok(e) => e,
            Err(_) => return cur,
        };
        cur = next;
    }
}
`;
  const fns = extractFunctions(src);
  const chase = findChaseLoopFunctions(fns);
  assert.ok(chase.has('chase_without_a_guard'));
  assert.equal(chase.get('chase_without_a_guard').guarded, false);
});

test('classifyFile reports the chase-loop signal separately from the recursion signal, and a function structurally on both (recursion AND an inline chase loop) appears in both lists', () => {
  const boundedSrc = `
fn extract_edge_loop_points(loop_entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Vec<Point3> {
    let edges = loop_entity.get(0).and_then(|a| a.as_list()).unwrap();
    for edge_ref in edges {
        let oriented_edge = decoder.decode_by_id(edge_ref.as_entity_ref().unwrap()).unwrap();
        use_edge(oriented_edge);
    }
    Vec::new()
}
`;
  const boundedResult = classifyFile(boundedSrc);
  assert.deepEqual(boundedResult.chaseFlagged, []);
  assert.deepEqual(boundedResult.flagged, []);

  const bothSrc = `
fn process_with_depth(entity: &DecodedEntity, decoder: &mut EntityDecoder, depth: u32) -> Result<Mesh> {
    if depth > MAX_BOOLEAN_DEPTH { return Err(Error::TooDeep); }
    let mut cur = entity.clone();
    let mut visited: HashSet<u32> = HashSet::new();
    let base = loop {
        if !visited.insert(cur.id) {
            return Err(Error::Cyclic);
        }
        if !cur.is_boolean() {
            break cur;
        }
        let first_attr = cur.get(1)?;
        let first = decoder.resolve_ref(first_attr)?.ok_or(Error::Missing)?;
        cur = first;
    };
    process_operand_with_depth(&base, decoder, depth)
}

fn process_operand_with_depth(operand: &DecodedEntity, decoder: &mut EntityDecoder, depth: u32) -> Result<Mesh> {
    let entity = decoder.decode_by_id(operand.id)?;
    process_with_depth(&entity, decoder, depth + 1)
}
`;
  const bothResult = classifyFile(bothSrc);
  assert.ok(bothResult.flagged.includes('process_with_depth'), 'mutual recursion with process_operand_with_depth');
  assert.ok(bothResult.chaseFlagged.includes('process_with_depth'), 'also an inline chase loop over FirstOperand');
});
