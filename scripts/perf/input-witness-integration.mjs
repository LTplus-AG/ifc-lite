/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileHash } from './interleaved-assets.mjs';
import { discoverViewerInput } from './input-witness-discovery.mjs';
import { installViewerInputWitness } from './input-witness-install.mjs';
import { captureViewerInputDiagnostic } from './input-witness-diagnostic.mjs';
import { captureViewerInputIdentity } from './input-witness-capture.mjs';
import { expectedZeroPlacedMesh } from './input-witness-zero-placement.mjs';
import { INPUT_WITNESS_BOUNDS, requireViewerInputIdentityPair } from './input-witness-policy.mjs';

const rawContract = readFileSync(new URL('./input-witness-source-contract.json', import.meta.url));
const contract = JSON.parse(rawContract);
export const INPUT_PROTOCOL = 'independent-viewer-input-v4-metadata-lineage-instrumented';
export const INPUT_SUBJECTS = Object.freeze({ ...contract.subjects });
const manifestSha256 = createHash('sha256').update(rawContract).digest('hex');

export function inputProtocol(value) {
  if (value === undefined || value === 'false') return null;
  if (value === 'true') return INPUT_PROTOCOL;
  throw new Error('REFUSE: unknown independent input diagnostic mode');
}

// Called by the source/build producer, then checked again by the driver before
// either UI load. No supplied browser payload alone authenticates this audit.
export async function qualifyInputSubjects(builds) {
  for (const arm of ['base', 'candidate']) {
    const build = builds[arm];
    if (!build || build.revision !== INPUT_SUBJECTS[arm]) throw new Error('REFUSE: independent input subject mismatch');
    for (const dependency of contract.dependencies) {
      if (await fileHash(join(build.dir, dependency.path)) !== dependency.sha256) {
        throw new Error(`REFUSE: unaudited installed input dependency ${arm}:${dependency.path}`);
      }
    }
    for (const row of contract.sourceContract) {
      const expected = row[`${arm}Sha256`];
      if (!expected || build.sourceInputs[row.path] !== expected
        || await fileHash(join(build.dir, row.path)) !== expected) {
        throw new Error(`REFUSE: unaudited independent input source ${arm}:${row.path}`);
      }
    }
  }
  return { protocol: INPUT_PROTOCOL, manifestSha256, subjects: INPUT_SUBJECTS,
    immutableArguments: true, sourceFiles: contract.sourceContract.length,
    scope: 'Pinned conditional canonical reference contract; not historical byte snapshots or GPU qualification' };
}

export function requireInputProof(proof, arm, revision) {
  if (!Object.hasOwn(INPUT_SUBJECTS, arm) || revision !== INPUT_SUBJECTS[arm]
    || proof?.protocol !== INPUT_PROTOCOL || proof.manifestSha256 !== manifestSha256
    || proof.immutableArguments !== true || proof.sourceFiles !== contract.sourceContract.length
    || Object.keys(proof.subjects ?? {}).length !== 2
    || ['base', 'candidate'].some(role => proof.subjects[role] !== INPUT_SUBJECTS[role])) {
    throw new Error('REFUSE: input reference proof not bound to fixed source producer');
  }
  return { subjectHead: revision, manifestSha256, immutableArguments: true };
}

export async function registerInputWitness(page, proof, arm, revision) {
  const referenceAudit = requireInputProof(proof, arm, revision);
  return page.evaluate(installViewerInputWitness, {
    discoverySource: discoverViewerInput.toString(), bounds: INPUT_WITNESS_BOUNDS, referenceAudit,
  });
}

export async function captureInputWitness(page, limits) {
  return page.evaluate(captureViewerInputIdentity, {
    oneBufferBytes: limits.oneBufferBytes, digestBytes: limits.digestBytes, records: limits.records,
    zeroPlacementSource: expectedZeroPlacedMesh.toString(),
  });
}

export async function captureInputDiagnostic(page) {
  return page.evaluate(captureViewerInputDiagnostic);
}

export async function disposeInputWitness(page) {
  return page.evaluate(() => {
    const witness = globalThis.__ifc_lite_input_witness__;
    if (!witness) return { restored: false, failure: 'input witness absent at cleanup' };
    return witness.dispose();
  });
}

export function requireInputAppearancePair(rows) {
  if (!Array.isArray(rows) || rows.length !== 2 || rows[0]?.arm !== 'base' || rows[1]?.arm !== 'candidate') {
    throw new Error('REFUSE: exactly two ordered independent appearance rows required');
  }
  for (const row of rows) {
    requireInputProof(row.inputProof, row.arm, row.revision);
    if (row.inputProtocol !== INPUT_PROTOCOL || row.inputWitnessCleanup?.restored !== true
      || row.fullAppearanceIdentity?.status !== 'observed') throw new Error('REFUSE: independent appearance/cleanup incomplete');
  }
  requireViewerInputIdentityPair(rows[0].fullAppearanceIdentity.value, rows[1].fullAppearanceIdentity.value);
  return { protocol: INPUT_PROTOCOL, producedIdentityEqual: true, viewportInputIdentityEqual: true,
    scope: 'Two instrumented canonical UI loads, CPU output/input and retained scene; no performance or pixel/GPU identity verdict' };
}
