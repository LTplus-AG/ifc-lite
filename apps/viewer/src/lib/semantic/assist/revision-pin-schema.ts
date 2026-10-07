/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
