/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ContentMatch, EntityFingerprint, ModelDiff, SuccessorClaim } from './types.js';

const key = <TRef>(entity: EntityFingerprint<TRef>) => ({ key: entity.key });

/** Only fields consumed by the native identity helper cross the boundary. */
export function projectContentMatches<TRef>(matches: Iterable<ContentMatch<TRef>> | undefined) {
  return [...matches ?? []].map(match => ({ kind: match.kind, base: match.base.map(key), head: match.head.map(key) }));
}

export function projectAcceptedSuccessors<TRef>(accepted: Iterable<SuccessorClaim<TRef>> | undefined) {
  return [...accepted ?? []].map(claim => ({ confidence: claim.confidence, base: key(claim.base), head: key(claim.head) }));
}

/** Keep arbitrary adapter references and unrelated fingerprint fields in JS. */
export function projectLineageDiff<TRef>(diff: ModelDiff<TRef>) {
  return {
    entries: diff.entries.map(entry => ({ key: entry.key, state: entry.state })),
    appliedKeyAliases: [...diff.appliedKeyAliases ?? []],
    contentMatches: projectContentMatches(diff.contentMatches),
    splitMerges: (diff.splitMerges ?? []).map(claim => ({
      kind: claim.kind, confidence: claim.confidence, whole: key(claim.whole),
      pieces: claim.pieces.map(piece => ({ key: piece.key, volume: piece.volume })),
      piecesVolume: claim.piecesVolume,
    })),
  };
}
