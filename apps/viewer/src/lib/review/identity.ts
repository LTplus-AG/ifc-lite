/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Element identity validation against the loaded models (P18, #6922).
 *
 * A finding only joins a coordination card when every element it names
 * resolves to exactly one loaded model that contains the GlobalId, under a
 * model name no other loaded model shares. Revisions and federations reuse
 * GlobalIds across models, so an element named without a model (a BCF
 * component, a linked record) that occurs in two loaded models is ambiguous
 * and is never merged on a guess.
 */

import type { FindingElement, ReviewModel } from './types';

export type ElementResolution =
  | { state: 'resolved'; modelId: string; modelName: string; expressId: number }
  | { state: 'ambiguous'; modelNames: string[] }
  | { state: 'missing' };

export function resolveElement(element: FindingElement, models: readonly ReviewModel[]): ElementResolution {
  // A native identity failure is authoritative; a GlobalId match must not overrule it.
  if (element.nativeUnresolved === 'ambiguous') return { state: 'ambiguous', modelNames: [] };
  if (element.nativeUnresolved === 'unmatched') return { state: 'missing' };
  let candidates: readonly ReviewModel[];
  if (element.modelId !== null) {
    const named = models.find(model => model.id === element.modelId);
    candidates = named ? [named] : element.modelName !== null ? models.filter(model => model.name === element.modelName) : [];
  } else if (element.modelName !== null) {
    candidates = models.filter(model => model.name === element.modelName);
  } else {
    candidates = models;
  }
  const hits = candidates.flatMap(model => {
    const expressId = model.expressIdOf(element.globalId);
    return expressId > 0 ? [{ model, expressId }] : [];
  });
  if (hits.length === 0) return { state: 'missing' };
  if (hits.length > 1) return { state: 'ambiguous', modelNames: hits.map(hit => hit.model.name) };
  const [{ model, expressId }] = hits;
  // The durable key is the model name; two loaded models sharing it cannot be told apart later.
  const sameName = models.filter(other => other.name === model.name);
  if (sameName.length > 1) return { state: 'ambiguous', modelNames: sameName.map(other => other.name) };
  return { state: 'resolved', modelId: model.id, modelName: model.name, expressId };
}

/** Durable element key: model name plus GlobalId. Stable across reloads of the same file. */
export function elementKey(modelName: string, globalId: string): string {
  return `${modelName}\u001f${globalId}`;
}

export function splitElementKey(key: string): { modelName: string; globalId: string } {
  const at = key.lastIndexOf('\u001f');
  return { modelName: key.slice(0, at), globalId: key.slice(at + 1) };
}
