/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { structuralDeriveEn } from './catalogues/structural-derive.en';
export type StructuralDeriveKey = keyof typeof structuralDeriveEn extends `structuralDerive.${infer Key}` ? Key : never;
/** The structural derivation review's keys and parameters (#9668), validated before its chunk loads. */
export const structuralDeriveShape = {
  "hint": [],
  "prepare": [],
  "acknowledgement": [],
  "counts": ["created", "curveMembers", "guessedSupports", "nodes", "supports", "surfaceMembers"],
  "assumed": ["count"],
  "skipped": ["count"],
  "guessed": ["count"],
  "unconnected": ["count"],
  "existing": ["ids"],
  "nothing": [],
  "noModel": [],
  "nodeAt": ["node", "position"],
  "endAt": ["element", "landsOn", "node", "position"],
  "more": ["count"],
  "model": ["name"],
  "moved": ["count"],
  "movedRow": ["distance", "element", "end", "to"],
  "free": ["count"],
  "end.start": [],
  "end.end": [],
  "reason.already-idealised": [],
  "reason.not-load-bearing": [],
  "reason.load-bearing-unknown": [],
  "reason.no-idealisable-shape": [],
  "reason.shorter-than-tolerance": [],
  "reason.footing-without-member-end": [],
  "landsOn.member-interior": [],
  "landsOn.surface-member": [],
} satisfies Record<StructuralDeriveKey, readonly string[]>;
