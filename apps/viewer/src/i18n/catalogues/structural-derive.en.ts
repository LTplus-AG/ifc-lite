/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The structural derivation review (#9668), loaded with its dialog's chunk
 * (`StructuralDerivationReview.tsx` registers it), not at first load.
 */
export const structuralDeriveEn = {
  'structuralDerive.hint': 'Beams, columns and members become curve members; slabs and walls become surface members on their mid-plane; member ends that meet share a node; footings carry supports. Every derived item is linked to its physical element. This creates IFC records; it does not check the design.',
  'structuralDerive.prepare': 'Derive and review',
  'structuralDerive.acknowledgement': 'I have reviewed the skipped elements and the guessed supports.',
  'structuralDerive.counts': '{curveMembers} curve members · {surfaceMembers} surface members · {nodes} nodes · {supports} supports, {guessedSupports} guessed · {created} IFC records to create',
  'structuralDerive.assumed': '{count} elements have no LoadBearing value and are assumed load-bearing.',
  'structuralDerive.skipped': 'Skipped elements ({count})',
  'structuralDerive.guessed': 'Guessed supports, placed at the lowest nodes because no footing carries one ({count})',
  'structuralDerive.unconnected': 'Nodes touching a member or surface they are not connected to ({count})',
  'structuralDerive.existing': 'This model already has an analysis model ({ids}). Nothing is derived beside it.',
  'structuralDerive.nothing': 'Nothing to derive: no load-bearing element could be idealised, or every one already has a structural counterpart.',
  'structuralDerive.noModel': 'Load a model to derive its structural analysis model.',
  'structuralDerive.nodeAt': 'Node {node}: {position} m',
  'structuralDerive.endAt': 'Node {node}: {position} m, {landsOn} #{element}',
  'structuralDerive.more': '{count} more not shown',
  'structuralDerive.model': 'Model: {name}',
  'structuralDerive.moved': 'Member ends moved along their axis to make a joint ({count})',
  'structuralDerive.movedRow': '#{element} {end}: {distance} m to meet #{to}',
  'structuralDerive.free': 'Free member ends, meeting no other member and no support ({count})',
  'structuralDerive.end.start': 'start',
  'structuralDerive.end.end': 'end',
  'structuralDerive.reason.already-idealised': 'already has a structural counterpart',
  'structuralDerive.reason.not-load-bearing': 'not load-bearing',
  'structuralDerive.reason.load-bearing-unknown': 'no LoadBearing value',
  'structuralDerive.reason.no-idealisable-shape': 'shape cannot be idealised',
  'structuralDerive.reason.shorter-than-tolerance': 'shorter than the tolerance',
  'structuralDerive.reason.footing-without-member-end': 'no member end on this footing',
  'structuralDerive.landsOn.member-interior': 'on member',
  'structuralDerive.landsOn.surface-member': 'on surface member',
} as const satisfies Record<string, TranslationValue>;
