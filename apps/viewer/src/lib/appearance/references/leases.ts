/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { retainPdfDocument, releasePdfDocument } from '../pdf/documents.js';
import { appearanceAssets } from '../model-assets.js';
import type { AppearanceSourceOption } from '../draft-types.js';
import type { AppearanceAssetOwner } from '../assets.js';
import type { RegisteredAppearanceReference, ReferenceCommand } from './types.js';

export interface ReferenceLeaseState {
  appearanceSources?: readonly AppearanceSourceOption[];
  appearanceReferences: ReadonlyMap<string, RegisteredAppearanceReference>;
  referenceUndo: readonly ReferenceCommand[];
  referenceRedo: readonly ReferenceCommand[];
}
/** A store owns independent live and history leases. Never borrow the source's lease. */
export function createReferenceLeases() {
  const namespace = crypto.randomUUID();
  let held = new Map<string, { owner: AppearanceAssetOwner; assets: Set<string>; pdfs: Set<string> }>();
  function sync(state: ReferenceLeaseState): void {
    const desired = new Map<string, { owner: AppearanceAssetOwner; assets: Set<string>; pdfs: Set<string> }>();
    for (const source of state.appearanceSources ?? []) if (source.pdfLineage) {
      const key = `reference:${namespace}:source:${source.id}`;
      desired.set(key, { owner: { kind: 'source', id: key }, assets: new Set(), pdfs: new Set([source.pdfLineage.documentSha256]) });
    }
    for (const reference of state.appearanceReferences.values()) {
      const key = `reference:${namespace}:live:${reference.id}`;
      desired.set(key, { owner: { kind: 'source', id: key }, assets: new Set([reference.assetId]), pdfs: new Set(reference.pdf ? [reference.pdf.documentSha256] : []) });
    }
    for (const command of [...state.referenceUndo, ...state.referenceRedo]) {
      const key = `reference:${namespace}:history:${command.id}`;
      desired.set(key, { owner: { kind: 'history', id: key }, assets: new Set(
        [...command.before.values(), ...command.after.values()].map(record => record.assetId)),
        pdfs: new Set([...command.before.values(), ...command.after.values()].flatMap(record => record.pdf ? [record.pdf.documentSha256] : [])) });
    }
    // Retain first so history pruning or live replacement cannot close a bitmap
    // that another resulting owner still needs. Missing files remain recoverable.
    for (const entry of desired.values()) for (const asset of entry.assets) {
      if (appearanceAssets.get(asset)) appearanceAssets.retain(asset, entry.owner);
    }
    for (const [key, entry] of held) for (const asset of entry.assets) {
      if (!desired.get(key)?.assets.has(asset)) appearanceAssets.release(asset, entry.owner);
    }
    for (const [key, entry] of desired) for (const digest of entry.pdfs) retainPdfDocument(digest, key);
    for (const [key, entry] of held) for (const digest of entry.pdfs) {
      if (!desired.get(key)?.pdfs.has(digest)) releasePdfDocument(digest, key);
    }
    held = desired;
  }
  return { sync };
}
