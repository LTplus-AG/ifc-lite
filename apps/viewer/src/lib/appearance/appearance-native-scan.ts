/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearancePlanner } from './planner-worker-client';
import { prepareScanSession, type ScanSession } from './scan/session';
import type { ScanLandmark, ScanPair, ScanPoint, ScanRegistrationRequest } from './scan/types';
import { ScanValidationError } from '@/components/viewer/appearance/scan-validation-message';
/** The exact native landmark acceptance rule used by the canvas and API. */
export function appendNativeScanPair(
  pairs: readonly ScanPair[],
  pending: { point: ScanLandmark; partition: 'fit' | 'check' },
  target: { point: ScanPoint; feature: string },
): ScanPair[] {
  if (
    pairs.some(
      (row) =>
        row.correspondence.sourceObservation === pending.point.observation ||
        row.correspondence.targetFeature === target.feature,
    )
  )
    throw new ScanValidationError('appearance.scan.error.duplicateLandmark');
  if (pairs.filter((row) => row.partition === pending.partition).length >= 256)
    throw new ScanValidationError('appearance.scan.error.pairLimit');
  const row: ScanPair = {
    source: pending.point,
    partition: pending.partition,
    correspondence: {
      id: crypto.randomUUID(),
      sourceObservation: pending.point.observation,
      targetFeature: target.feature,
      source: pending.point.point,
      target: target.point,
    },
  };
  return [...pairs, row];
}
export async function registerNativeScanSession(
  session: ScanSession,
  pairs: readonly ScanPair[],
  planner: AppearancePlanner,
  signal: AbortSignal,
) {
  session.validate();
  const request: ScanRegistrationRequest = structuredClone({
    sourceFrame: session.sourceFrame,
    targetFrame: session.targetFrame,
    fit: pairs.filter((pair) => pair.partition === 'fit').map((pair) => pair.correspondence),
    heldOut: pairs.filter((pair) => pair.partition === 'check').map((pair) => pair.correspondence),
  });
  const report = await planner.registerScan(request, { signal });
  signal.throwIfAborted();
  session.validate();
  return { request, report };
}
/** Rebind only proven unchanged paired surfaces after a native appearance edit;
 * a changed source/frame/body refuses rather than silently reusing old anchors. */
export async function refreshNativeScanBinding(
  session: ScanSession,
  saved: { request: ScanRegistrationRequest; rebind: (next: ScanSession) => void },
  planner: AppearancePlanner,
  signal: AbortSignal,
) {
  const next = await prepareScanSession(session.sourceModelId, session.selector, session.targetModelId, signal);
  saved.rebind(next);
  const request: ScanRegistrationRequest = {
    ...structuredClone(saved.request),
    sourceFrame: next.sourceFrame,
    targetFrame: next.targetFrame,
  };
  const report = await planner.registerScan(request, { signal });
  next.validate();
  signal.throwIfAborted();
  return { session: next, result: { request, report }, recovery: { request, rebind: next.afterAppearance() } };
}

/** Same native fit/check edit as the landmark list. Registration must be
 * recalculated by the caller after this immutable correspondence edit. */
export function changeNativeScanPartition(
  pairs: readonly ScanPair[],
  id: string,
  partition: 'fit' | 'check',
): ScanPair[] {
  const current = pairs.find(pair => pair.correspondence.id === id);
  if (current && current.partition !== partition && pairs.filter(pair => pair.partition === partition).length >= 256)
    throw new ScanValidationError('appearance.scan.error.pairLimit');
  return pairs.map((pair) => (pair.correspondence.id === id ? { ...pair, partition } : pair));
}
