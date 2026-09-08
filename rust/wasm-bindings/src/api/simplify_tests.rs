// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native (non-wasm) tests for [`group_and_slice_records`], the pure core of
//! `simplifyMeshes` extracted from behind the `JsValue` boundary.
//!
//! The fixture is built so a mutation is observable rather than accidentally
//! correct: several *differently-sized* records (never one — a single record
//! cannot observe a stride), a deliberately non-exact total, and records at
//! distinct index positions so an off-by-one or a swapped index shows up.
//!
//! A fixture that CAN observe a stride is not the same as an assertion that
//! DOES. Element 10's first record starts at offset 0, which is also where an
//! `i * 16` -> `0` mutant lands, so asserting only that record left the
//! `local_to_world` stride unpinned; the second record's window (200..=215) is
//! what actually kills it. Say what a test pins, not what its fixture could
//! in principle detect.

use super::group_and_slice_records;

/// Three records belonging to two elements, deliberately of DIFFERENT sizes
/// so a wrong stride or a swapped offset is observable:
///   record 0: element 10, 2 vertices, 3 indices
///   record 1: element 20, 1 vertex,  0 indices
///   record 2: element 10, 3 vertices, 6 indices  (second record of elem 10)
/// Positions/normals are distinct per-vertex values (never repeated) so a
/// slice that reads the wrong window returns visibly wrong numbers, not
/// coincidentally-right ones.
struct Fixture {
    express_ids: Vec<u32>,
    levels: Vec<u8>,
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    vertex_counts: Vec<u32>,
    index_counts: Vec<u32>,
    origins: Vec<f64>,
    local_to_world: Vec<f64>,
    local_to_world_present: Vec<u8>,
}

fn fixture() -> Fixture {
    // record 0: 2 verts -> 6 floats: [0,1,2, 3,4,5]
    // record 1: 1 vert  -> 3 floats: [6,7,8]
    // record 2: 3 verts -> 9 floats: [9,10,11, 12,13,14, 15,16,17]
    let positions: Vec<f32> = (0..18).map(|i| i as f32).collect();
    let normals: Vec<f32> = (0..18).map(|i| (i as f32) + 100.0).collect();
    // record 0: 3 indices, record 1: 0, record 2: 6
    let indices: Vec<u32> = vec![0, 1, 0, /* rec1 empty */ 0, 1, 2, 1, 2, 0];
    let mut l2w = vec![0.0f64; 3 * 16];
    // Only record 0 (element 10's first record) carries a placement; that's
    // enough per SimplifyRecordInput's contract, but for this pure-slicing
    // layer we just need the values to round-trip, so give every record a
    // distinct recognisable matrix when marked present.
    for r in 0..3 {
        for k in 0..16 {
            l2w[r * 16 + k] = (r * 100 + k) as f64;
        }
    }
    Fixture {
        express_ids: vec![10, 20, 10],
        levels: vec![2, 3, 2],
        positions,
        normals,
        indices,
        vertex_counts: vec![2, 1, 3],
        index_counts: vec![3, 0, 6],
        origins: vec![
            1.0, 2.0, 3.0, // record 0
            4.0, 5.0, 6.0, // record 1
            7.0, 8.0, 9.0, // record 2
        ],
        local_to_world: l2w,
        local_to_world_present: vec![1, 0, 1],
    }
}

/// `(positions_len, indices_len)` for one record of a grouped element.
type RecordShape = (usize, usize);
/// One grouped element as the tests observe it: `(id, level, per-record shapes)`.
/// Named rather than spelled inline so `call`'s signature stays readable and
/// clippy's `type_complexity` gate stays satisfied.
type GroupedShape = (u32, u8, Vec<RecordShape>);

fn call(f: &Fixture) -> Result<Vec<GroupedShape>, String> {
    // Shapes rather than slices, so assertions don't need to hold borrowed
    // slices alongside the Result.
    group_and_slice_records(
        &f.express_ids,
        &f.levels,
        &f.positions,
        &f.normals,
        &f.indices,
        &f.vertex_counts,
        &f.index_counts,
        &f.origins,
        &f.local_to_world,
        &f.local_to_world_present,
    )
    .map(|groups| {
        groups
            .into_iter()
            .map(|g| {
                let shapes = g.records.iter().map(|r| (r.positions.len(), r.indices.len())).collect();
                (g.id, g.level, shapes)
            })
            .collect()
    })
}

#[test]
fn first_seen_order_is_not_ascending_id_order() {
    // The main fixture's ids are [10, 20, 10]: first-seen (10, 20) and
    // ascending (10, 20) are the SAME sequence, so that test stays green if
    // grouping is changed to sort by id. Element order is a wire contract --
    // it decides the order of `SimplifiedMeshes.element_ids` that JS reads
    // back -- so it needs a fixture where the two rules disagree.
    // Reversing the ids keeps every level pairing intact: element 20 now holds
    // records 0 and 2 (whose levels already matched), element 10 holds record 1.
    let mut f = fixture();
    f.express_ids = vec![20, 10, 20];
    let groups = call(&f).expect("well-formed fixture must not error");
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].0, 20, "first-seen order must put 20 first, not sorted order");
    assert_eq!(groups[1].0, 10);
}

#[test]
fn groups_by_first_seen_element_order_and_slices_each_record() {
    let f = fixture();
    let groups = call(&f).expect("well-formed fixture must not error");
    // First-seen order: element 10 appears at record 0, element 20 at record 1.
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].0, 10);
    assert_eq!(groups[1].0, 20);
    // Element 10 carries both record 0 (2 verts -> 6 floats, 3 indices) and
    // record 2 (3 verts -> 9 floats, 6 indices), in that order.
    assert_eq!(groups[0].2, vec![(6, 3), (9, 6)]);
    assert_eq!(groups[1].2, vec![(3, 0)]);
}

#[test]
fn slices_positions_at_the_exact_record_window() {
    let f = fixture();
    let groups = call_full(&f).unwrap();
    // Element 10's second record (record index 2) must read positions
    // [9..18), not the record-0 window [0..6) or the record-1 window [6..9).
    let elem10 = &groups[0];
    let second_record = &elem10.records[1];
    assert_eq!(second_record.positions, &[9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0][..]);
    // Normals share the position offset/length exactly.
    assert_eq!(
        second_record.normals,
        &[109.0, 110.0, 111.0, 112.0, 113.0, 114.0, 115.0, 116.0, 117.0][..]
    );
    assert_eq!(second_record.indices, &[0, 1, 2, 1, 2, 0][..]);
    assert_eq!(second_record.origin, [7.0, 8.0, 9.0]);
}

#[test]
fn local_to_world_present_flag_gates_the_decode() {
    let f = fixture();
    let groups = call_full(&f).unwrap();
    let elem10 = &groups[0];
    // record 0 (present=1): Some, value = [0..16)
    let expected: [f64; 16] = {
        let mut m = [0.0f64; 16];
        for (k, slot) in m.iter_mut().enumerate() {
            *slot = k as f64;
        }
        m
    };
    assert_eq!(elem10.records[0].local_to_world, Some(expected));

    // Record 0 alone cannot pin the STRIDE: its window starts at 0, which is
    // where a `wire_index * 16` -> `0` mutant also lands, so that assertion
    // passes with the stride arithmetic deleted. Element 10's SECOND record is
    // wire record 2, and the fixture fills it with `r * 100 + k`, so a correct
    // stride reads 200..=215 and any other offset reads something else.
    let expected_third: [f64; 16] = {
        let mut m = [0.0f64; 16];
        for (k, slot) in m.iter_mut().enumerate() {
            *slot = (2 * 100 + k) as f64;
        }
        m
    };
    assert_eq!(elem10.records[1].local_to_world, Some(expected_third));

    // element 20's only record has present=0: None, even though the wire
    // array carries non-zero bytes at that offset.
    let elem20 = &groups[1];
    assert_eq!(elem20.records[0].local_to_world, None);
}

fn call_full<'a>(f: &'a Fixture) -> Result<Vec<super::GroupedElementRecords<'a>>, String> {
    group_and_slice_records(
        &f.express_ids,
        &f.levels,
        &f.positions,
        &f.normals,
        &f.indices,
        &f.vertex_counts,
        &f.index_counts,
        &f.origins,
        &f.local_to_world,
        &f.local_to_world_present,
    )
}

#[test]
fn rejects_mismatched_per_record_array_lengths() {
    // The guard is SIX independent clauses, not one. Popping only `levels`
    // exercised the first and left the other five free: deleting any of
    // `vertex_counts`, `index_counts`, `origins`, `local_to_world` or
    // `local_to_world_present` from the condition kept this suite green.
    // Each arm below is one clause, so a deleted clause now reds this test.
    /// One clause of the guard: the array to shorten, by name.
    type ShortenOne = (&'static str, fn(&mut Fixture));
    let cases: [ShortenOne; 6] = [
        ("levels", |f| {
            f.levels.pop();
        }),
        ("vertex_counts", |f| {
            f.vertex_counts.pop();
        }),
        ("index_counts", |f| {
            f.index_counts.pop();
        }),
        ("origins", |f| {
            f.origins.pop();
        }),
        ("local_to_world", |f| {
            f.local_to_world.pop();
        }),
        ("local_to_world_present", |f| {
            f.local_to_world_present.pop();
        }),
    ];
    for (name, break_one) in cases {
        let mut f = fixture();
        break_one(&mut f);
        let err = match call(&f) {
            Ok(_) => panic!("{name}: a short array was accepted"),
            Err(e) => e,
        };
        assert_eq!(
            err, "simplifyMeshes: per-record array lengths disagree",
            "{name}: wrong rejection reason"
        );
    }
}

#[test]
fn rejects_normals_present_but_not_1to1_with_positions() {
    let mut f = fixture();
    f.normals.pop();
    let err = call(&f).unwrap_err();
    assert_eq!(err, "simplifyMeshes: normals must be empty or 1:1 with positions");
}

#[test]
fn empty_normals_is_allowed() {
    let mut f = fixture();
    f.normals.clear();
    let groups = call_full(&f).expect("empty normals must be accepted, not treated as a mismatch");
    assert_eq!(groups.len(), 2);
    // Accepting the input is only half of it: every record must come back with
    // an EMPTY normals slice. `call` projects normals away, so handing the
    // caller's positions back as normals would pass unnoticed.
    for g in &groups {
        for r in &g.records {
            assert!(r.normals.is_empty(), "element {} record normals must stay empty", g.id);
        }
    }
}

#[test]
fn rejects_trailing_slack_in_positions_exact_total_check() {
    // One extra float appended: counts sum to 18 but positions.len() == 19.
    // This is the "not an exact multiple" case the exact-total check exists
    // for -- it must be exercised with real trailing slack, not merely with
    // matching totals.
    let mut f = fixture();
    f.positions.push(999.0);
    f.normals.push(999.0); // keep normals 1:1 with positions so only the total check fires
    let err = call(&f).unwrap_err();
    assert_eq!(err, "simplifyMeshes: counts do not match concatenated array lengths");
}

#[test]
fn rejects_trailing_slack_in_indices_exact_total_check() {
    let mut f = fixture();
    f.indices.push(0);
    let err = call(&f).unwrap_err();
    assert_eq!(err, "simplifyMeshes: counts do not match concatenated array lengths");
}

#[test]
fn rejects_short_positions_that_undercount_the_stated_vertices() {
    // vertex_counts claim 2+1+3=6 verts (18 floats) but positions is short.
    let mut f = fixture();
    f.positions.truncate(17);
    f.normals.truncate(17); // keep normals 1:1 with positions so only the total check fires
    let err = call(&f).unwrap_err();
    assert_eq!(err, "simplifyMeshes: counts do not match concatenated array lengths");
}

#[test]
fn rejects_conflicting_levels_within_one_element() {
    let mut f = fixture();
    // record 2 also belongs to element 10 (record 0's element); give it a
    // different level than record 0's level=2.
    f.levels[2] = 5;
    let err = call(&f).unwrap_err();
    assert_eq!(err, "simplifyMeshes: records for element 10 have conflicting levels");
}

#[test]
fn accepts_agreeing_levels_within_one_element() {
    let f = fixture(); // levels[0] == levels[2] == 2 already
    let groups = call(&f).expect("agreeing levels across an element's records must be accepted");
    assert_eq!(groups[0].1, 2);
}
