#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/lib/rust-public-api.mjs and
 * scripts/lib/rust-item-shape.mjs (issue #4192).
 *
 * The load-bearing case is `#4178-and-#4182`, below: it reconstructs the
 * exact `OpeningDiagnostic`/`Mesh` struct text from before and after the two
 * real PRs #4192 cites (a field added to a `pub`, non-`#[non_exhaustive]`
 * struct re-exported at the crate root) and asserts the extracted surface
 * differs in exactly the way that broke the release. If this test does not
 * pass, the gate does not work — see the issue's own words.
 *
 * The rest is VACUITY and PARSING coverage: every way this could report a
 * clean surface having examined nothing, plus the Rust shapes (nested `pub
 * use` groups, tuple/unit structs, enum variant shapes, ambiguous names,
 * `pub unsafe extern "C" fn`) that a naive regex-only parser gets wrong.
 *
 * Run: node --test scripts/lib/rust-public-api.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCrateSurface, discoverCrateDirs } from './rust-public-api.mjs';
import { splitTopLevel } from './rust-item-shape.mjs';

/** A scratch crate dir with `src/lib.rs` plus any extra module files, torn down after `fn` runs. */
function withCrate(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rust-public-api-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#4178-and-#4182: catches a field added to a pub, non-#[non_exhaustive] struct at the crate root', () => {
  const before = withCrate(
    {
      'src/lib.rs': `
        mod router;
        mod mesh;
        pub use router::OpeningDiagnostic;
        pub use mesh::Mesh;
      `,
      'src/router.rs': `
        /// One opening's worth of diagnostic data.
        #[derive(Debug, Clone)]
        pub struct OpeningDiagnostic {
            pub opening_id: u32,
            pub vertex_count: usize,
        }
      `,
      'src/mesh.rs': `
        #[derive(Debug, Clone)]
        pub struct Mesh {
            pub positions: Vec<f32>,
            pub indices: Vec<u32>,
            pub rtc_applied: bool,
        }
      `,
    },
    (dir) => extractCrateSurface(dir).surface
  );

  const after = withCrate(
    {
      'src/lib.rs': `
        mod router;
        mod mesh;
        pub use router::OpeningDiagnostic;
        pub use mesh::Mesh;
      `,
      'src/router.rs': `
        /// One opening's worth of diagnostic data.
        #[derive(Debug, Clone)]
        pub struct OpeningDiagnostic {
            pub opening_id: u32,
            pub vertex_count: usize,
            pub triangle_count: usize,
        }
      `,
      'src/mesh.rs': `
        #[derive(Debug, Clone)]
        pub struct Mesh {
            pub positions: Vec<f32>,
            pub indices: Vec<u32>,
            pub rtc_applied: bool,
            pub welded_in_object_frame: bool,
        }
      `,
    },
    (dir) => extractCrateSurface(dir).surface
  );

  assert.notEqual(before.OpeningDiagnostic, after.OpeningDiagnostic, 'triangle_count addition must change the descriptor');
  assert.ok(!before.OpeningDiagnostic.includes('triangle_count'));
  assert.ok(after.OpeningDiagnostic.includes('triangle_count: usize'));

  assert.notEqual(before.Mesh, after.Mesh, 'welded_in_object_frame addition must change the descriptor');
  assert.ok(!before.Mesh.includes('welded_in_object_frame'));
  assert.ok(after.Mesh.includes('welded_in_object_frame: bool'));
});

test('a struct already #[non_exhaustive] records name+kind only, no field list — adding a field there is not a break', () => {
  const before = withCrate(
    {
      'src/lib.rs': `mod diag; pub use diag::Widening;`,
      'src/diag.rs': `
        #[non_exhaustive]
        #[derive(Debug)]
        pub struct Widening {
            pub a: u32,
        }
      `,
    },
    (dir) => extractCrateSurface(dir).surface
  );
  const after = withCrate(
    {
      'src/lib.rs': `mod diag; pub use diag::Widening;`,
      'src/diag.rs': `
        #[non_exhaustive]
        #[derive(Debug)]
        pub struct Widening {
            pub a: u32,
            pub b: u32,
        }
      `,
    },
    (dir) => extractCrateSurface(dir).surface
  );
  assert.equal(before.Widening, 'struct (non_exhaustive)');
  assert.equal(before.Widening, after.Widening, 'a non_exhaustive struct gaining a field must not change the snapshot');
});

test('enum variants: unit, tuple, and struct-like shapes, and non_exhaustive suppresses variant detail', () => {
  const { surface } = withCrate(
    {
      'src/lib.rs': `mod e; pub use e::{Reason, Sealed};`,
      'src/e.rs': `
        #[derive(Debug)]
        pub enum Reason {
            Unit,
            Tuple(String, usize),
            Struct { count: usize, label: String },
        }

        #[non_exhaustive]
        pub enum Sealed {
            A,
            B,
        }
      `,
    },
    (dir) => extractCrateSurface(dir)
  );
  assert.equal(
    surface.Reason,
    'enum { Struct { count: usize; label: String }; Tuple(String, usize); Unit }'
  );
  assert.equal(surface.Sealed, 'enum (non_exhaustive)');
});

test('tuple struct and unit struct shapes', () => {
  const { surface } = withCrate(
    {
      'src/lib.rs': `mod s; pub use s::{Pair, Marker};`,
      'src/s.rs': `
        pub struct Pair(pub f64, pub f64);
        pub struct Marker;
      `,
    },
    (dir) => extractCrateSurface(dir)
  );
  assert.equal(surface.Pair, 'struct(f64, f64)');
  assert.equal(surface.Marker, 'struct (unit)');
});

test('nested pub use groups, `as` aliases, and multi-line groups all resolve', () => {
  const { surface } = withCrate(
    {
      'src/lib.rs': `
        mod a;
        mod b;
        pub use a::{
          Foo,
          bar::{Baz, Qux as Renamed},
        };
        pub use b::Thing as Aliased;
      `,
      'src/a.rs': `
        pub struct Foo { pub x: u32 }
        pub mod bar {
          pub struct Baz { pub y: u32 }
          pub struct Qux { pub z: u32 }
        }
      `,
      'src/b.rs': `pub struct Thing { pub w: u32 }`,
    },
    (dir) => extractCrateSurface(dir)
  );
  assert.equal(surface.Foo, 'struct { x: u32 }');
  assert.equal(surface.Baz, 'struct { y: u32 }');
  assert.equal(surface.Renamed, 'struct { z: u32 }');
  assert.equal(surface.Aliased, 'struct { w: u32 }');
});

test('a `pub use` inside an inline `pub mod { ... }` block is NOT folded into the crate-root surface', () => {
  // Regression for the conflation bug: `collectRootUses` used to scan the
  // whole masked `lib.rs` for `pub use` regardless of brace nesting, so an
  // inline `pub mod sub { pub use ...; }` block's re-export was treated as a
  // root-level item. Combined with first-wins dedup, that let a NESTED `X`
  // silently displace a genuine ROOT `X` declared later in the file — the
  // wrong shape recorded with no warning, contradicting this module's own
  // "NOT tracked" docblock rule for items reachable only via a `pub mod`'s
  // own path.
  const { surface } = withCrate(
    {
      'src/lib.rs': `
        mod real;
        mod other;

        pub mod sub {
          pub use crate::real::Thing as X;
        }

        pub use other::Other as X;
      `,
      'src/real.rs': `pub struct Thing { pub inner_field: u32 }`,
      'src/other.rs': `pub struct Other { pub outer_field: u32 }`,
    },
    (dir) => extractCrateSurface(dir)
  );
  // The root-level `pub use other::Other as X;` must win — the inline mod's
  // re-export is out of scope for the crate-root surface entirely.
  assert.equal(surface.X, 'struct { outer_field: u32 }');
});

test('a re-export whose path is not a locally declared module is external — no field detail claimed', () => {
  const { surface } = withCrate(
    {
      'src/lib.rs': `pub use some_external_crate::{Vector3, Matrix4};`,
    },
    (dir) => extractCrateSurface(dir)
  );
  assert.equal(surface.Vector3, 'external re-export');
  assert.equal(surface.Matrix4, 'external re-export');
});

test('a private (non-pub) field is excluded from a struct descriptor', () => {
  const { surface } = withCrate(
    {
      'src/lib.rs': `mod s; pub use s::Thing;`,
      'src/s.rs': `
        pub struct Thing {
            pub visible: u32,
            hidden: u32,
            pub(crate) also_hidden: u32,
        }
      `,
    },
    (dir) => extractCrateSurface(dir)
  );
  assert.equal(surface.Thing, 'struct { visible: u32 }');
});

test('a name defined in two files is AMBIGUOUS, not silently resolved to either one', () => {
  const { surface, warnings } = withCrate(
    {
      'src/lib.rs': `mod a; mod b; pub use a::Dup; pub use b::Dup as DupToo;`,
      'src/a.rs': `pub struct Dup { pub x: u32 }`,
      'src/b.rs': `pub struct Dup { pub y: u32 }`,
    },
    (dir) => extractCrateSurface(dir)
  );
  assert.equal(surface.Dup, 'ambiguous');
  assert.equal(surface.DupToo, 'ambiguous');
  assert.ok(warnings.some((w) => w.includes('AMBIGUOUS: Dup')));
});

test('`pub unsafe extern "C" fn` at the crate root (the whole shape of rust/ffi/src/lib.rs) is captured', () => {
  const { surface, pubUseCount } = withCrate(
    {
      'src/lib.rs': `
        #[no_mangle]
        pub unsafe extern "C" fn ifc_lite_parse(ptr: *const u8, len: usize) -> i32 {
            0
        }
        #[no_mangle]
        pub extern "C" fn ifc_lite_free(ptr: *mut u8, len: usize) {}
      `,
    },
    (dir) => extractCrateSurface(dir)
  );
  assert.equal(pubUseCount, 0);
  assert.equal(surface.ifc_lite_parse, 'fn');
  assert.equal(surface.ifc_lite_free, 'fn');
});

test('a field list this parser cannot confidently split is reported as unparsed, never a partial list', () => {
  const { surface } = withCrate(
    {
      'src/lib.rs': `mod s; pub use s::Weird;`,
      // A field entry using a macro-generated shape this parser does not
      // understand (`cfg_if!`-style token soup) must not silently vanish.
      'src/s.rs': `
        pub struct Weird {
            pub a: u32,
            some_macro!(b, c),
        }
      `,
    },
    (dir) => extractCrateSurface(dir)
  );
  assert.equal(surface.Weird, 'struct (fields: unparsed)');
});

test('VACUITY: an empty lib.rs (no pub use, no direct pub item) throws rather than reporting zero items as clean', () => {
  withCrate({ 'src/lib.rs': `mod internal; fn private_helper() {}` }, (dir) => {
    assert.throws(() => extractCrateSurface(dir), /EMPTY_SURFACE/);
  });
});

test('VACUITY: a missing lib.rs throws rather than being read as an empty (passing) surface', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rust-public-api-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    assert.throws(() => extractCrateSurface(dir), /NO_LIB_RS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverCrateDirs finds a crate by its Cargo.toml `name`, not by directory name', () => {
  const rustRoot = mkdtempSync(join(tmpdir(), 'rust-root-'));
  try {
    mkdirSync(join(rustRoot, 'wasm-bindings'), { recursive: true });
    writeFileSync(join(rustRoot, 'wasm-bindings', 'Cargo.toml'), '[package]\nname = "ifc-lite-wasm"\n');
    mkdirSync(join(rustRoot, 'unrelated-tool'), { recursive: true });
    writeFileSync(join(rustRoot, 'unrelated-tool', 'Cargo.toml'), '[package]\nname = "csg-thread-bench"\n');
    const dirs = discoverCrateDirs(rustRoot, ['ifc-lite-wasm']);
    assert.equal(dirs.size, 1);
    assert.equal(dirs.get('ifc-lite-wasm'), join(rustRoot, 'wasm-bindings'));
  } finally {
    rmSync(rustRoot, { recursive: true, force: true });
  }
});

test('discoverCrateDirs omits crates whose Cargo.toml is absent — the caller decides that is fatal, not this function', () => {
  const rustRoot = mkdtempSync(join(tmpdir(), 'rust-root-'));
  try {
    const dirs = discoverCrateDirs(rustRoot, ['ifc-lite-core']);
    assert.equal(dirs.size, 0);
  } finally {
    rmSync(rustRoot, { recursive: true, force: true });
  }
});

test('splitTopLevel respects nested <>()[]{} — a field type with tuple-of-tuples commas is one entry', () => {
  const parts = splitTopLevel('a: Option<((f32, f32, f32), (f32, f32, f32))>, b: u32');
  assert.deepEqual(parts, ['a: Option<((f32, f32, f32), (f32, f32, f32))>', 'b: u32']);
});
