// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSource, runCheck } from './check-leaf-reader-copies.mjs';
const copy = 'coords.first().and_then(|v| v.as_float()).unwrap_or(0.0)';
const path = 'rust/geometry/src/read.rs';

test('#7779 exact receivers/accessors and trivia remain visible', () => {
  for (const receiver of ['coords', 'ratios']) {
    for (const accessor of ['first()', 'get(0)', 'get(1)', 'get(2)']) {
      const source = `${receiver} /* outer /* nested */ */ . ${accessor}\n.and_then ( | v | v . as_float ( ) ) . unwrap_or ( fallback )`;
      assert.equal(scanSource(source, path).length, 1);
    }
  }
});

test('#7779 lexer excludes prose and literals without swallowing following code', () => {
  for (const hidden of [`// ${copy}\n`, `/* ${copy} */`, `"${copy}"`, `r###"${copy}"###`, `br#"${copy}"#`, `b"${copy}"`]) {
    assert.equal(scanSource(hidden, path).length, 0);
    assert.equal(scanSource(`${hidden}\nfn live<'a>() { ${copy}; }`, path).length, 1);
  }
  assert.equal(scanSource(`let c = 'x'; ${copy};`, path).length, 1);
});

test('#7779 test and canonical exclusions are exact', () => {
  assert.equal(scanSource(copy, 'rust/core/src/decoder/leaf_read.rs').length, 0);
  assert.equal(scanSource(copy, 'rust/geometry/src/decoder/leaf_read.rs').length, 1);
  assert.equal(scanSource(copy, 'rust/geometry/src/read_tests.rs').length, 0);
  assert.equal(scanSource(`#[cfg(test)] mod tests { fn check() { ${copy}; } }\n${copy};`, path).length, 1);
  assert.equal(scanSource(`#[cfg(test)] use testing;\nfn production() { ${copy}; }`, path).length, 1);
  assert.equal(scanSource(copy, 'rust/geometry/src/router/voids/probe/point.rs').length, 1);
});

test('#7779 exact spelling does not pretend to certify every leaf policy', () => {
  for (const source of [copy.replace('coords', 'coord'), copy.replace('first()', 'get(index)'),
    copy.replaceAll('|v| v', '|value| value'), 'decoder.point3(id)?']) {
    assert.equal(scanSource(source, path).length, 0);
  }
});

test('#7779 roots are mandatory and live copies fail the complete scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'leaf-copies-'));
  try {
    assert.throws(() => runCheck(root));
    mkdirSync(join(root, 'rust/geometry/src'), { recursive: true });
    mkdirSync(join(root, 'apps/server/src'), { recursive: true });
    assert.throws(() => runCheck(root), /Empty Rust source root/);
    writeFileSync(join(root, 'rust/geometry/src/lib.rs'), 'fn clean() {}');
    assert.throws(() => runCheck(root), /Empty Rust source root/);
    writeFileSync(join(root, 'apps/server/src/main.rs'), `fn main() { ${copy}; }`);
    const bad = runCheck(root);
    assert.equal(bad.ok, false);
    assert.equal(bad.scanned, 2);
    assert.equal(bad.findings.length, 1);
    writeFileSync(join(root, 'apps/server/src/main.rs'), 'fn main() {}');
    assert.equal(runCheck(root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
