// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validate, validateShape, decode } from '../retained-contract/validate.mjs';

const output = new URL('../../.retained-dev/', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The expected commit comes from the original build request, never runtime Git. */
export async function loadDevelopmentInspection(expectedCommit) {
  assert.match(expectedCommit, /^[a-f0-9]{40}$/u);
  const build = JSON.parse(readFileSync(new URL('build.json', output), 'utf8'));
  assert.equal(build.implementationCommit, expectedCommit, 'Original build request identity');
  const files = readdirSync(new URL('wasm/', output), { recursive: true })
    .filter(name => /\.(?:js|wasm|ts)$/u.test(name)).sort();
  assert.deepEqual(files, Object.keys(build.files).sort(), 'Complete generated artifact closure');
  for (const name of files) {
    assert.equal(sha256(readFileSync(new URL(`wasm/${name}`, output))), build.files[name], `Build bytes: ${name}`);
  }
  const engine = await import(new URL('wasm/ifc-lite.js', output));
  // initSync with bytes: neither JS loader nor source inspection needs fetch.
  engine.initSync({ module: readFileSync(new URL('wasm/ifc-lite_bg.wasm', output)) });
  return (bytes, productId, optionsJson) => {
    const reportBytes = engine.inspectDevelopmentSource(bytes, productId, optionsJson);
    assert.ok(reportBytes instanceof Uint8Array, 'Opaque synchronous diagnostic bytes');
    const report = validateShape('InspectionReport', JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reportBytes)));
    assert.equal(report.implementationCommit, expectedCommit, 'Embedded compile identity');
    assert.equal(report.identity.source.sha256, sha256(bytes), 'Source bytes');
    assert.equal(report.identity.source.namespace, sha256(`ifc-lite/source-inspection/v1/${sha256(bytes)}`));
    assert.equal(report.product.productId, String(productId), 'Selected product');
    assert.deepEqual(report.identity.options, decode('Options', optionsJson), 'Strict immutable options');
    return validate('InspectionReport', report, { identity: report.identity,
      enumerationComplete: false, requested: [report.product], nonGeometric: [] });
  };
}
