/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { editOwnershipRefusal, expandAffectedSet } from '@ifc-lite/export';
import { toNativeLength } from './anchor.js';
import { emitOrdinaryElement, type OrdinaryInStoreElement } from './ordinary-element.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { computeWallSplitGeometry, type WallEditChain } from './edit/wall-edit.js';
import { computeLinearElementSplitGeometry, type LinearElementEditChain } from './edit/linear-element-edit.js';
import { keepsFirstPiece } from './edit/split-guid.js';
import { cloneElementMetadata } from './edit/metadata-clone.js';
import { reassignWallOpenings } from './edit/wall-opening-reassign.js';
import { readWallJoinTarget, readWallJoinRels } from './wall-join-read.js';
import { splitJoinedWallDraft } from './element-split-joined.js';
import type { ElementSplitResult, SplitEnvironment } from './element-split.js';
import { readSplitPlacement, preserveSplitPlacement } from './element-split-placement.js';

type Vec3 = [number, number, number];
const native = (v: number, k: number) => toNativeLength({ lengthUnitScale: k }, v);
const scaled = (p: readonly number[], k: number): Vec3 => [native(p[0], k), native(p[1], k), native(p[2], k)];
const along = (s: Vec3, dir: Vec3, t: number): Vec3 => [s[0] + dir[0] * t, s[1] + dir[1] * t, s[2] + dir[2] * t];

export function splitWallDraft(env: SplitEnvironment, id: number, chain: WallEditChain, distance: number): ElementSplitResult {
  const { editor, dataStore, view } = env;
  const ownership = editOwnershipRefusal(dataStore, view, [chain.startPointId, chain.profileId, chain.profileOriginPointId], expandAffectedSet(dataStore, view, [id], 'hostsChanged'));
  if (ownership) throw new Error(ownership);
  const read = readWallJoinTarget(dataStore, view, id, env.lengthUnitScale);
  const rels = readWallJoinRels(dataStore, view, new Set([id]));
  let addedId: number, keepLeft: boolean, element: OrdinaryInStoreElement;
  if (read && (!read.plain || read.axisRepId !== null || rels.length > 0)) {
    ({ addedId, keepLeft, element } = splitJoinedWallDraft(env, id, distance, read, rels));
  } else {
    const geo = computeWallSplitGeometry(chain, distance, chain.height);
    if (!geo.ok) throw new Error(geo.reason);
    keepLeft = keepsFirstPiece(distance, chain.wallLength - distance);
    const kept = keepLeft ? geo.geometry.left : geo.geometry.right;
    const cut = keepLeft ? geo.geometry.right : geo.geometry.left;
    element = { kind: 'wall', params: { ...cut, Name: env.name, GlobalId: env.newGlobalId } };
    addedId = emitOrdinaryElement(editor, resolveSpatialAnchor(dataStore, env.storeyExpressId, view), element);
    const k = chain.lengthUnitScale;
    const length = Math.hypot(kept.End[0] - kept.Start[0], kept.End[1] - kept.Start[1]);
    editor.setPositionalAttribute(chain.startPointId, 0, scaled(kept.Start, k));
    editor.setPositionalAttribute(chain.profileId, 3, native(length, k));
    editor.setPositionalAttribute(chain.profileOriginPointId, 0, [native(length, k) / 2, 0]);
  }
  const [leftId, rightId] = keepLeft ? [id, addedId] : [addedId, id];
  const openings = reassignWallOpenings(dataStore, view, editor, id, leftId, rightId, native(distance, chain.lengthUnitScale));
  cloneElementMetadata(dataStore, view, editor, id, [addedId]);
  return { sourceId: id, addedId, leftId, rightId, storeyId: env.storeyExpressId, element, openings };
}

export function splitLinearDraft(env: SplitEnvironment, id: number, chain: LinearElementEditChain, distance: number): ElementSplitResult {
  const placement = readSplitPlacement(env, id);
  const ownership = editOwnershipRefusal(env.dataStore, env.view, [chain.extrudedSolidId, chain.startPointId], new Set([id]));
  if (ownership) throw new Error(ownership);
  const geo = computeLinearElementSplitGeometry(chain, distance);
  if (!geo.ok) throw new Error(geo.reason);
  const keepFirst = keepsFirstPiece(distance, chain.depth - distance);
  const keptStart = keepFirst ? chain.startCoordinates : geo.geometry.cutPoint;
  const keptLength = keepFirst ? distance : chain.depth - distance;
  const newStart = keepFirst ? geo.geometry.cutPoint : chain.startCoordinates;
  const newLength = keepFirst ? chain.depth - distance : distance;
  const common = { Name: env.name, GlobalId: env.newGlobalId };
  const section = chain.profile ? { Profile: chain.profile } : { Width: geo.geometry.width, Height: geo.geometry.height };
  const element: OrdinaryInStoreElement = chain.elementType === 'IfcColumn'
    ? { kind: 'column', params: { ...common, Position: newStart, Height: newLength,
      ...(chain.profile ? { Profile: chain.profile } : { Width: geo.geometry.width, Depth: geo.geometry.height }) } }
    : { kind: chain.elementType === 'IfcBeam' ? 'beam' : 'member',
      params: { ...common, Start: newStart, End: along(newStart, chain.axisDirection, newLength), ...section } };
  const { editor, dataStore, view } = env;
  const addedId = emitOrdinaryElement(editor, resolveSpatialAnchor(dataStore, env.storeyExpressId, view), element);
  preserveSplitPlacement(env, addedId, placement);
  editor.setPositionalAttribute(chain.extrudedSolidId, 3, native(keptLength, chain.lengthUnitScale));
  if (!keepFirst) editor.setPositionalAttribute(chain.startPointId, 0, scaled(keptStart, chain.lengthUnitScale));
  cloneElementMetadata(dataStore, view, editor, id, [addedId]);
  const [leftId, rightId] = keepFirst ? [id, addedId] : [addedId, id];
  return { sourceId: id, addedId, leftId, rightId, storeyId: env.storeyExpressId, element, openings: { toLeft: 0, toRight: 0, skipped: 0 } };
}
