/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { semantics } from './semantics.mjs';

assert.match(process.version, /^v22\.13\./, 'acceptance requires Node 22.13.x');
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.NODE_PATH, undefined);
const mode = process.argv[2];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const proof = { mode, node: process.version, executable: realpathSync(process.execPath), resolved: {} };
for (const specifier of ['@ifc-lite/diff', '@ifc-lite/wasm/diff', '@ifc-lite/wasm/diff_bg.wasm']) {
  const url = import.meta.resolve(specifier);
  const path = realpathSync(fileURLToPath(url));
  assert.ok(path.startsWith(`${realpathSync(process.cwd())}/node_modules/`), `escaped consumer: ${path}`);
  proof.resolved[specifier] = { url, realpath: path, bytes: readFileSync(path).length, sha256: sha256(readFileSync(path)) };
}
// Publish before import/init so a runtime failure still leaves resolution proof.
writeFileSync(`${mode}-resolution.json`, JSON.stringify(proof, null, 2));
const api = await import('@ifc-lite/diff');
const constants = {
  IDENTITY_MAP_SIDECAR_FORMAT: 'ifc-lite/identity-map', IDENTITY_MAP_SIDECAR_VERSION: 1,
  IDENTITY_MAP_SIDECAR_KEYED_VERSION: 2, LINEAGE_SIDECAR_FORMAT: 'ifc-lite/lineage',
  LINEAGE_SIDECAR_VERSION: 1, CONTENT_MATCH_REASON_PREFIX: 'content-match:',
  SUCCESSOR_REASON_PREFIX: 'successor:', ACCEPTED_AMBIGUOUS_REASON: 'accepted:ambiguous',
};
for (const [name, value] of Object.entries(constants)) assert.equal(api[name], value);
const guarded = [
  ['prepareDiffModel', []], ['diffModels', [], []], ['stableHash', ''], ['normalizeValue', null],
  ['buildDataFingerprint', { ifcType: 'IfcWall' }], ['buildComponentFingerprints', { ifcType: 'IfcWall' }],
  ['identityMapFromContentMatches'], ['identityMapFromSuccessors'],
  ['lineageOfDiff', { entries: [] }], ['lineageFromDiff', { entries: [] }],
  ['lineageConflicts', []], ['keyAliasesFromLineage', []], ['rekeyByLineage', [], []],
  ['createIdentityMapSidecar', {}], ['serializeIdentityMapSidecar', {}],
  ['parseIdentityMapSidecar', '{}'], ['validateIdentityMapSidecar', {}],
  ['identityMapSidecarMismatches', {}, {}], ['keyAliasesFromSidecar', {}],
  ['createLineageSidecar', {}], ['serializeLineageSidecar', {}],
  ['parseLineageSidecar', '{}'], ['validateLineageSidecar', {}], ['lineageSidecarMismatches', {}, {}],
];
const preinit = () => {
  assert.throws(() => new api.DiffModelHandle([]), /Initialize @ifc-lite\/diff.*initDiff/);
  for (const [name, ...args] of guarded) {
    assert.throws(() => api[name](...args), /Initialize @ifc-lite\/diff.*initDiff/);
  }
};
preinit();
const bytes = readFileSync(new URL(import.meta.resolve('@ifc-lite/wasm/diff_bg.wasm')));
const invalid = new Uint8Array([0]);
if (mode === 'sync') {
  assert.throws(() => api.initDiffSync({ module: invalid }), error => {
    writeFileSync('expected-sync-error.json', JSON.stringify({ name: error.name, message: error.message, stack: error.stack }, null, 2));
    return error instanceof WebAssembly.CompileError;
  });
  preinit();
  api.initDiffSync({ module: bytes });
} else {
  if (mode === 'retry') {
    const failed = await Promise.allSettled([
      api.initDiff({ module_or_path: invalid }), api.initDiff({ module_or_path: invalid }),
    ]);
    for (const outcome of failed) {
      assert.equal(outcome.status, 'rejected');
      assert.ok(outcome.reason instanceof WebAssembly.CompileError);
    }
    writeFileSync('expected-init-errors.json', JSON.stringify(failed.map(o => ({
      name: o.reason.name, message: o.reason.message, stack: o.reason.stack,
    })), null, 2));
    preinit();
  } else assert.equal(mode, 'async');
  // Unmodified Node fetch cannot load file: URLs. Default init MUST succeed
  // through the real filesystem path. No mocked fetch or substituted loader.
  await assert.rejects(fetch(new URL(import.meta.resolve('@ifc-lite/wasm/diff_bg.wasm'))), TypeError);
  await Promise.all([api.initDiff(), api.initDiff(), api.initDiff()]);
}
// Once ready, init is idempotent even with unusable replacement input.
await api.initDiff({ module_or_path: invalid });
api.initDiffSync({ module: invalid });
proof.semantics = semantics(api, { handles: true });
proof.preinitOperations = [...guarded.map(([name]) => name), 'DiffModelHandle'].sort();
assert.deepEqual(proof.preinitOperations, proof.semantics.operations);
assert.deepEqual(Object.keys(api).sort(), [...proof.semantics.operations,
  'initDiff', 'initDiffSync', ...Object.keys(constants)].sort(), 'public runtime export surface');
writeFileSync(`${mode}-result.json`, JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ mode, status: 'passed', ...proof.semantics }));
