/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { useSemanticSession } from '../session';
import type { RevisionPin } from './revision-pin-schema';

export type { RevisionPin } from './revision-pin-schema';

type Models = ReturnType<typeof useViewerStore.getState>['models'];

export function captureRevisionPin(revisions: ReadonlyMap<string, string> = useSemanticSession.getState().revisions,
  models: Models = useViewerStore.getState().models): RevisionPin {
  return {
    capturedAt: new Date().toISOString(),
    associations: [...revisions].map(([revision, modelId]) => ({ revision, modelId,
      modelName: models.get(modelId)?.name ?? modelId, fingerprint: models.get(modelId)?.sourceFingerprint ?? null }))
      .sort((a, b) => a.revision.localeCompare(b.revision)),
    models: [...models.values()].map(model => ({ id: model.id, fingerprint: model.sourceFingerprint ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

const identity = (pin: RevisionPin) => JSON.stringify([pin.associations.map(({ revision, modelId, fingerprint }) => [revision, modelId, fingerprint]), pin.models]);

/** Current only while the same revisions map to the same loaded sources. */
export function revisionPinIsCurrent(pin: RevisionPin, revisions: ReadonlyMap<string, string> = useSemanticSession.getState().revisions,
  models: Models = useViewerStore.getState().models): boolean {
  return identity(pin) === identity(captureRevisionPin(revisions, models));
}
