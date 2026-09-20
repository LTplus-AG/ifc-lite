/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface RemoteEntityDefinition {
  ifcClass: string;
  attributes: Record<string, unknown>;
  /** Source-store identity for an explicitly materialized GUID-less record. */
  sourceExpressId?: number;
}

export function remoteEntityDefinition(entity: unknown): RemoteEntityDefinition | null {
  const attributes = (entity as { get?(key: string): unknown } | undefined)?.get?.('attributes') as {
    get(key: string): unknown;
    forEach?(fn: (value: unknown, key: string) => void): void;
  } | undefined;
  const classValue = attributes?.get('bsi::ifc::class') as { code?: unknown } | undefined;
  if (typeof classValue?.code !== 'string') return null;
  const initial: Record<string, unknown> = {};
  attributes?.forEach?.((value, key) => {
    if (key !== 'bsi::ifc::class') initial[key] = value;
  });
  const meta = (entity as { get?(key: string): unknown }).get?.('meta') as {
    get(key: string): unknown;
  } | undefined;
  const sourceExpressId = meta?.get('ifc-lite::sourceExpressId');
  return {
    ifcClass: classValue.code,
    attributes: initial,
    ...(typeof sourceExpressId === 'number' && Number.isSafeInteger(sourceExpressId) && sourceExpressId > 0
      ? { sourceExpressId }
      : {}),
  };
}
