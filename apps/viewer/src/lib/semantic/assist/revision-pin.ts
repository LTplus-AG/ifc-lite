/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { useSemanticSession } from '../session';

/**
 * The model revision context a result or mapping was produced against: the
 * semantic revision associations in force and the loaded model sources. Any
 * change (re-association, reload, a different file) makes it historical.
 */
export interface RevisionPin {
  capturedAt: string;
  associations: Array<{ revision: string; modelId: string; modelName: string; fingerprint: string | null }>;
  models: Array<{ id: string; fingerprint: string | null }>;
}

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

export function decodeRevisionPin(value: unknown): RevisionPin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pin = value as Record<string, unknown>;
  const text = (item: unknown) => typeof item === 'string';
  const fingerprint = (item: unknown) => item === null || typeof item === 'string';
  if (!text(pin.capturedAt) || !Array.isArray(pin.associations) || !Array.isArray(pin.models)
    || pin.associations.length > 1000 || pin.models.length > 1000) return null;
  const associationsValid = pin.associations.every(item => !!item && typeof item === 'object' && text(item.revision) && text(item.modelId)
    && text(item.modelName) && fingerprint(item.fingerprint));
  const modelsValid = pin.models.every(item => !!item && typeof item === 'object' && text(item.id) && fingerprint(item.fingerprint));
  return associationsValid && modelsValid ? structuredClone(pin) as unknown as RevisionPin : null;
}
