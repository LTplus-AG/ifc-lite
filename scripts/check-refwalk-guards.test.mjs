/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the refwalk gate (issue #2944). Everything runs against synthetic
 * Rust written into an `mkdtemp` tree, not against the repo, so a change to
 * rust/geometry can never make these vacuously green -- the same construction
 * scripts/check-source-text-assertions.mjs's own tests use.
 *
 * Half of these exist because a gate that passes vacuously is worse than no
 * gate: three checks in this repo have shipped exiting 0 having examined
 * nothing. `emptyInput`, `missingRoot` and `detectorFloor` pin that this one
 * fails loudly instead.
 *
 * Run: `node --test scripts/check-refwalk-guards.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCheck } from './check-refwalk-guards.mjs';

const ROOT = 'rust/geometry/src';

/**
 * Build a temp tree of `{ 'rust/geometry/src/x.rs': '...' }` and run the check
 * against it. Defaults keep the repo's own floor and allowlist out of play.
 *
 * @param {Record<string, string>} files
 * @param {object} [opts]
 */
function check(files, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'refwalk-gate-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return runCheck(dir, { roots: [ROOT], allowlist: new Set(), candidateFloor: 0, allowlistCeiling: 0, ...opts });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNGUARDED = `
fn chase(id: u32, decoder: &mut EntityDecoder) -> Option<u32> {
    let item = decoder.decode_by_id(id).ok()?;
    let next = item.get_ref(0)?;
    chase(next, decoder)
}
`;

test('flags a self-recursive walk with no guard', () => {
  const r = check({ [`${ROOT}/a.rs`]: UNGUARDED });
  assert.deepEqual(r.unguarded, [`${ROOT}/a.rs::chase::recursion`]);
  assert.equal(r.ok, false);
});

test('accepts the same walk once a visited set is threaded through it', () => {
  const guarded = `
fn chase(id: u32, decoder: &mut EntityDecoder, visited: &mut FxHashSet<u32>) -> Option<u32> {
    if !visited.insert(id) {
        return None;
    }
    let item = decoder.decode_by_id(id).ok()?;
    let next = item.get_ref(0)?;
    chase(next, decoder, visited)
}
`;
  const r = check({ [`${ROOT}/a.rs`]: guarded });
  assert.deepEqual(r.unguarded, []);
  assert.equal(r.candidates, 1, 'still a candidate — it is guarded, not invisible');
});

test('accepts a depth cap against a named bound', () => {
  const guarded = `
fn chase(id: u32, decoder: &mut EntityDecoder, depth: u32) -> Option<u32> {
    if depth >= MAX_MAPPED_ITEM_DEPTH {
        return None;
    }
    let item = decoder.decode_by_id(id).ok()?;
    chase(item.get_ref(0)?, decoder, depth + 1)
}
`;
  assert.deepEqual(check({ [`${ROOT}/a.rs`]: guarded }).unguarded, []);
});

test('an unrelated bounded loop over a constant is NOT a guard', () => {
  // The regression #2869's parent commit produced: `0..=SEGMENTS` is arc
  // tessellation, not a recursion bound, and reading it as one hid the walk.
  const fake = `
fn chase(id: u32, decoder: &mut EntityDecoder) -> Option<u32> {
    for i in 0..=SEGMENTS {
        let _ = i;
    }
    let item = decoder.decode_by_id(id).ok()?;
    chase(item.get_ref(0)?, decoder)
}
`;
  assert.deepEqual(check({ [`${ROOT}/a.rs`]: fake }).unguarded, [`${ROOT}/a.rs::chase::recursion`]);
});

test('finds the guard when it lives in another member of the same cycle', () => {
  // The five-of-six #2866 shape: a `_guarded` wrapper holds the visited set,
  // an `_inner` holds the decode. Scoping the guard search to one function
  // reports both halves unguarded.
  const split = `
fn walk_guarded(id: u32, decoder: &mut EntityDecoder, seen: &mut FxHashSet<u32>) -> Option<u32> {
    if !seen.insert(id) {
        return None;
    }
    walk_inner(id, decoder, seen)
}

fn walk_inner(id: u32, decoder: &mut EntityDecoder, seen: &mut FxHashSet<u32>) -> Option<u32> {
    let item = decoder.decode_by_id(id).ok()?;
    walk_guarded(item.get_ref(0)?, decoder, seen)
}
`;
  const r = check({ [`${ROOT}/a.rs`]: split });
  assert.deepEqual(r.unguarded, []);
  assert.equal(r.candidates, 2, 'both cycle members are candidates');
});

test('a path-scoped Vec stack counts as a guard', () => {
  // rust/processing/src/processor/color_layer.rs (#2874) spells it
  // `traversal_stack.contains(&id)` / `.push(id)` -- neither `visited` nor
  // `.insert`.
  const stack = `
fn chase(id: u32, decoder: &mut EntityDecoder, traversal_stack: &mut Vec<u32>) -> Option<u32> {
    if traversal_stack.contains(&id) {
        return None;
    }
    traversal_stack.push(id);
    let item = decoder.decode_by_id(id).ok()?;
    let out = chase(item.get_ref(0)?, decoder, traversal_stack);
    traversal_stack.pop();
    out
}
`;
  assert.deepEqual(check({ [`${ROOT}/a.rs`]: stack }).unguarded, []);
});

test('bounded iteration over a pre-bound list is not flagged at all', () => {
  // The edge_loop.rs shape, the false positive issue #2944's literal wording
  // would have produced across ~50 files.
  const bounded = `
fn build_face(edges: &[AttrRef], decoder: &mut EntityDecoder) -> Vec<Point> {
    let mut out = Vec::new();
    for edge_ref in edges {
        let edge_id = edge_ref.as_entity_ref().unwrap();
        let oriented_edge = decoder.decode_by_id(edge_id).unwrap();
        out.push(oriented_edge.point());
    }
    out
}
`;
  const r = check({ [`${ROOT}/a.rs`]: bounded });
  assert.equal(r.candidates, 0);
  assert.deepEqual(r.unguarded, []);
});

test('flags an unguarded chase loop, which recursion detection alone would miss', () => {
  const chaseLoop = `
fn follow(start: u32, decoder: &mut EntityDecoder) -> Option<u32> {
    let mut current = decoder.decode_by_id(start).ok()?;
    loop {
        let source_attr = current.get(0)?;
        current = decoder.resolve_ref(source_attr).ok()??;
    }
}
`;
  assert.deepEqual(check({ [`${ROOT}/a.rs`]: chaseLoop }).unguarded, [`${ROOT}/a.rs::follow::chase`]);
});

test('a self.field.method() call sharing a name is not read as recursion', () => {
  // Removing this rejection re-flags five unrelated `process` methods.
  const dispatch = `
fn process(&self, id: u32, decoder: &mut EntityDecoder) -> Mesh {
    let entity = decoder.decode_by_id(id).unwrap();
    self.profile_processor.process(entity.get_ref(0).unwrap(), decoder)
}
`;
  assert.equal(check({ [`${ROOT}/a.rs`]: dispatch }).candidates, 0);
});

test('an array return type does not hide a whole file from the extractor', () => {
  // `-> Option<[f32; 4]>` stopped the header scan on the `;` inside the array
  // type, so every function in rust/processing/src/style/surface.rs read as a
  // bodyless declaration and the file classified clean.
  const arrayReturn = `
fn read_colour(id: u32, decoder: &mut EntityDecoder) -> Option<[f32; 4]> {
    let e = decoder.decode_by_id(id).ok()?;
    read_colour(e.get_ref(0)?, decoder)
}
`;
  const r = check({ [`${ROOT}/a.rs`]: arrayReturn });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.unguarded, [`${ROOT}/a.rs::read_colour::recursion`]);
});

test('a file with fn that will not parse is an error, not a clean file', () => {
  const r = check({ [`${ROOT}/a.rs`]: 'trait T { fn only_a_declaration(&self) -> u32; }\n' });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /parsed to zero functions/);
  assert.equal(r.ok, false);
});

test('empty input set fails loudly rather than reporting success', () => {
  // A glob resolving to nothing is how verify-esm-entrypoints.mjs,
  // check-tla-chunk-await.mjs and vitest-timeout-audit.mjs each shipped
  // exiting 0 having checked nothing.
  const dir = mkdtempSync(join(tmpdir(), 'refwalk-gate-'));
  try {
    mkdirSync(join(dir, ROOT), { recursive: true });
    writeFileSync(join(dir, ROOT, 'notes.md'), '# no rust here\n');
    const r = runCheck(dir, { roots: [ROOT], allowlist: new Set(), candidateFloor: 0, allowlistCeiling: 0 });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /contains no \.rs files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing scan root fails loudly rather than being skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refwalk-gate-'));
  try {
    const r = runCheck(dir, { roots: ['rust/nope/src'], allowlist: new Set(), candidateFloor: 0, allowlistCeiling: 0 });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /scan root missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a detector that stops finding anything fails the floor', () => {
  // The vacuity failure that a "0 unguarded" line cannot distinguish from
  // success on its own.
  const r = check({ [`${ROOT}/a.rs`]: 'fn nothing() -> u32 { 1 }\n' }, { candidateFloor: 30 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /only 0 candidate walks found, floor is 30/);
});

test('an allowlist row suppresses exactly its own walk', () => {
  const files = { [`${ROOT}/a.rs`]: UNGUARDED, [`${ROOT}/b.rs`]: UNGUARDED };
  const r = check(files, {
    allowlist: new Set([`${ROOT}/a.rs::chase::recursion`]),
    allowlistCeiling: 1,
  });
  assert.deepEqual(r.unguarded, [`${ROOT}/b.rs::chase::recursion`]);
});

test('an allowlist row whose walk got guarded is reported stale', () => {
  const r = check(
    { [`${ROOT}/a.rs`]: 'fn nothing() -> u32 { 1 }\n' },
    { allowlist: new Set([`${ROOT}/a.rs::chase::recursion`]), allowlistCeiling: 1 }
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /no longer name an unguarded walk/);
});

test('allowlist growth cannot land without editing the ceiling', () => {
  const r = check({ [`${ROOT}/a.rs`]: UNGUARDED }, {
    allowlist: new Set([`${ROOT}/a.rs::chase::recursion`]),
    allowlistCeiling: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /ALLOWLIST_CEILING reads 0/);
});

test('allowlist shrinkage must lower the ceiling too', () => {
  const r = check({ [`${ROOT}/a.rs`]: UNGUARDED }, { allowlist: new Set(), allowlistCeiling: 1 });
  assert.match(r.errors.join('\n'), /ALLOWLIST_CEILING reads 1/);
});


/**
 * The gate is only worth anything if it RUNS. `isMain` decides that, and the
 * obvious spelling of it is wrong: `import.meta.url` is percent-encoded while
 * `process.argv[1]` is a raw path, so one space in the checkout path makes
 * them unequal, the module falls through, and the process exits 0 having
 * scanned nothing. CI reads that as a pass.
 *
 * These two run the script as a real entry point and assert on its SUCCESS
 * LINE rather than its exit code: a script that never ran also exits 0, so the
 * exit code cannot tell the two apart. That is the whole point -- the same
 * absence-reads-as-success shape this gate exists to catch, one level up in
 * the gate itself.
 *
 * They cannot be covered by importing `runCheck`, the way every other test
 * here does: an imported module has `isMain === false` by design, so the bug
 * is invisible from inside the test process. It has to be spawned.
 */
test('the gate actually runs from a path containing a space', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refwalk gate '));
  try {
    assert.ok(dir.includes(' '), `temp dir must contain a space, got ${dir}`);
    const copied = join(dir, 'check-refwalk-guards.mjs');
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(copied, readFileSync(new URL('./check-refwalk-guards.mjs', import.meta.url)));
    writeFileSync(
      join(dir, 'lib', 'refwalk-classify.mjs'),
      readFileSync(new URL('./lib/refwalk-classify.mjs', import.meta.url))
    );
    writeFileSync(
      join(dir, 'lib', 'is-main-entry.mjs'),
      readFileSync(new URL('./lib/is-main-entry.mjs', import.meta.url))
    );
    writeFileSync(
      join(dir, 'refwalk-guard-allowlist.txt'),
      readFileSync(new URL('./refwalk-guard-allowlist.txt', import.meta.url))
    );

    const run = spawnSync(process.execPath, [copied], { encoding: 'utf8' });
    const output = `${run.stdout}${run.stderr}`;

    // The discriminator is OUTPUT, not exit code. A module that falls through
    // because `isMain` came out false prints NOTHING and exits 0 -- which is
    // indistinguishable from a clean pass if you only read the status. Any
    // output naming the gate proves the body executed.
    //
    // Here it is the missing-scan-root failure: the copy has no rust/ tree, so
    // a gate that ran must refuse to report a pass over zero files. That
    // refusal IS the evidence.
    assert.notEqual(
      output.trim(),
      '',
      'the gate produced no output at all, so `isMain` was false and it never ran'
    );
    assert.match(
      output,
      /refwalk-guards: scan root missing/,
      `expected the gate to run and refuse an empty scan, got:\n${output}`
    );
    assert.equal(run.status, 1, 'a gate that scanned nothing must exit non-zero');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the success line reports a non-zero file count, not an empty scan', () => {
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./check-refwalk-guards.mjs', import.meta.url))],
    { encoding: 'utf8' }
  );
  const m = /check-refwalk-guards: OK \((\d+) \.rs files scanned/.exec(`${run.stdout}${run.stderr}`);
  assert.ok(m, `no success line:\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.ok(
    Number(m[1]) > 0,
    'scanned 0 .rs files -- a green that examined nothing is what this gate is for'
  );
});
