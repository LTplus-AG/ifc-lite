// SPDX-License-Identifier: MPL-2.0
// Verify existing build-owned inputs; this does not attest compiler execution.
import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, regular, readWithin, files } from './retained-asset-contract.mjs';

function requireEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Patched SDK ${label} mismatch`);
}

export async function verifiedSdkProvenance({ adapter, sdk, build, revision, receiptPath }) {
  const pinsBytes = await readWithin(adapter, 'patches/imprint-status-v1.json');
  const pins = JSON.parse(pinsBytes);
  requireEqual(pins.schema, 1, 'pin schema');
  requireEqual(pins.id, 'imprint-status-v1', 'patch identity');
  requireEqual(pins.upstreamRevision, revision, 'upstream revision');
  requireEqual(pins.selection, ['source/SMLib', 'source/SM_API', 'LICENSE', 'THIRD_PARTY_NOTICES.md'], 'selection');
  const patch = await readWithin(adapter, 'patches/imprint-status-v1.patch');
  requireEqual(digest(patch), pins.patchSha256, 'patch bytes');
  const names = execFileSync('git', ['-C', sdk, 'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...pins.selection],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean).sort();
  requireEqual(names.length, pins.fileCount, 'input count');
  const inputRows = [];
  for (const name of names) inputRows.push([name, digest(await readWithin(sdk, name, true))]);
  requireEqual(digest(Buffer.from(JSON.stringify(inputRows))), pins.inputInventorySha256, 'input inventory');
  const expected = Object.fromEntries(inputRows);
  requireEqual(expected[pins.path], pins.inputSha256, 'modified input');
  if (!names.includes(pins.path) || !/^[a-f0-9]{64}$/.test(pins.outputSha256)) throw new Error('Invalid patched SDK output pin');
  expected[pins.path] = pins.outputSha256;
  const root = join(build, 'ifclite-sdk', pins.id);
  const selected = join(root, 'provenance.json');
  requireEqual(receiptPath, selected, 'selected receipt path');
  requireEqual(await realpath(selected), selected, 'receipt real path');
  const receiptBytes = await readWithin(root, 'provenance.json');
  requireEqual(await regular(join(build, 'ifclite-sdk-provenance.json')), receiptBytes, 'configured receipt bytes');
  const receipt = JSON.parse(receiptBytes);
  requireEqual(receipt.schema, 1, 'receipt schema');
  requireEqual(receipt.upstreamRevision, revision, 'receipt upstream');
  requireEqual(receipt.upstreamInventorySha256, pins.inputInventorySha256, 'receipt input inventory');
  requireEqual(receipt.patch, pins, 'receipt patch');
  requireEqual(receipt.pinsSha256, digest(pinsBytes), 'receipt pins');
  requireEqual(receipt.preparerSha256, digest(await readWithin(adapter, 'prepare_sdk.py')), 'preparer');
  requireEqual(receipt.outputFiles, expected, 'receipt output inventory');
  requireEqual(await files(root), [...names, 'provenance.json'].sort(), 'prepared file inventory');
  for (const name of names) requireEqual(digest(await readWithin(root, name, true)), expected[name], `prepared file ${name}`);
  const outputRows = Object.entries(expected).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { receiptBytes, patch, identity: {
    id: pins.id, upstreamRevision: revision, patchSha256: pins.patchSha256,
    inputInventorySha256: pins.inputInventorySha256,
    outputInventorySha256: digest(Buffer.from(JSON.stringify(outputRows))),
    receiptSha256: digest(receiptBytes),
  } };
}
