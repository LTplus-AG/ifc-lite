#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The BUILD_WIDE=1 bundle must never be built on LLVM < 23: those versions
// miscompile i64 overflow checks under +wide-arithmetic
// (llvm/llvm-project#200429). Drives build_wide_bundle (and build-wasm.sh's
// call into it) with stub rustup / wasm-pack / wasm-tools, so no wasm is built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const lib = join(here, 'build-wasm-wide.sh');
const buildWasm = join(repoRoot, 'scripts', 'build-wasm.sh');

const STUB_RUSTUP = `#!/usr/bin/env bash
# rustup run <toolchain> <cmd> [args...]
[ "$1" = run ] || exit 2
tc="$2"; shift 2
if [ "$1" = rustc ]; then
  echo "rustc 1.0.0-nightly"
  if [ -n "$STUB_LLVM" ]; then echo "LLVM version: $STUB_LLVM.1.0"; fi
  exit 0
fi
printf '%s\\n' "toolchain=$tc" "rustflags=$RUSTFLAGS" "args=$*" >> "$STUB_LOG"
mkdir -p packages/wasm/pkg-wide
printf 'wasm' > packages/wasm/pkg-wide/ifc-lite_bg.wasm
`;

const STUB_WASM_TOOLS = `#!/usr/bin/env bash
if [ "$STUB_WIDE_OPS" = 1 ]; then echo "i64.mul_wide_s"; else echo "i64.mul"; fi
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'build-wasm-wide-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['rustup', STUB_RUSTUP], ['wasm-tools', STUB_WASM_TOOLS]]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  return { dir, bin, log: join(dir, 'invocations.log') };
}

function runWide(env) {
  const sb = sandbox();
  try {
    const res = spawnSync('bash', ['-c', `. "${lib}" && build_wide_bundle`], {
      cwd: sb.dir,
      encoding: 'utf8',
      env: {
        PATH: `${sb.bin}:/usr/bin:/bin`,
        HOME: sb.dir,
        WASM_PACK: 'wasm-pack',
        FEATURES: '',
        STUB_LOG: sb.log,
        STUB_WIDE_OPS: '1',
        ...env,
      },
    });
    const log = existsSync(sb.log) ? readFileSync(sb.log, 'utf8') : '';
    return { status: res.status, out: `${res.stdout}${res.stderr}`, log };
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
}

for (const llvm of ['21', '22']) {
  test(`refuses LLVM ${llvm} and never invokes wasm-pack`, () => {
    const r = runWide({ STUB_LLVM: llvm });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`LLVM ${llvm}, which miscompiles`));
    assert.match(r.out, /llvm\/llvm-project#200429/);
    assert.equal(r.log, '', 'wasm-pack must not run on a refused toolchain');
  });
}

test('refuses a toolchain whose LLVM version cannot be read', () => {
  const r = runWide({ STUB_LLVM: '' });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /cannot read the LLVM version of nightly-2026-10-15/);
  assert.equal(r.log, '');
});

test('builds on WIDE_TOOLCHAIN with +wide-arithmetic when LLVM >= 23', () => {
  const r = runWide({ STUB_LLVM: '23' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.log, /^toolchain=nightly-2026-10-15$/m);
  assert.match(r.log, /^rustflags=.*-C target-feature=\+simd128,\+wide-arithmetic$/m);
  assert.match(r.log, /^args=wasm-pack build rust\/wasm-bindings .*--out-dir \.\.\/\.\.\/packages\/wasm\/pkg-wide .*--release/m);
  assert.match(r.out, /wide-arithmetic bundle emits wide ops/);
});

test('an overridden WIDE_TOOLCHAIN is used, and is still held to LLVM >= 23', () => {
  const ok = runWide({ STUB_LLVM: '24', WIDE_TOOLCHAIN: 'nightly-2027-01-01' });
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.log, /^toolchain=nightly-2027-01-01$/m);

  const old = runWide({ STUB_LLVM: '21', WIDE_TOOLCHAIN: 'nightly-2025-11-15' });
  assert.notEqual(old.status, 0, old.out);
  assert.equal(old.log, '');
});

test('refuses a bundle that emits no wide ops', () => {
  const r = runWide({ STUB_LLVM: '23', STUB_WIDE_OPS: '0' });
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /has NO wide ops/);
});

test('build-wasm.sh routes BUILD_WIDE=1 through build_wide_bundle', () => {
  const src = readFileSync(buildWasm, 'utf8');
  const block = src.slice(src.indexOf('if [ "${BUILD_WIDE:-}" = "1" ]'));
  assert.match(block, /^\s*\. "\$SCRIPT_DIR\/lib\/build-wasm-wide\.sh"$/m);
  assert.match(block, /^\s*build_wide_bundle \|\| exit 1$/m);
  assert.doesNotMatch(src, /wide-arithmetic"? *\\\n\s*rustup run nightly-2025-11-15/,
    'the wide bundle must not be built on the repo pin');
});

test('wide-arithmetic.yml pins the same WIDE_TOOLCHAIN as the build helper', () => {
  const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'wide-arithmetic.yml'), 'utf8');
  const fromWorkflow = wf.match(/^\s*WIDE_TOOLCHAIN:\s*(\S+)\s*$/m)?.[1];
  const fromLib = readFileSync(lib, 'utf8').match(/^WIDE_TOOLCHAIN_DEFAULT="([^"]+)"$/m)?.[1];
  assert.ok(fromLib, 'build-wasm-wide.sh must define WIDE_TOOLCHAIN_DEFAULT');
  assert.equal(fromWorkflow, fromLib);
});
