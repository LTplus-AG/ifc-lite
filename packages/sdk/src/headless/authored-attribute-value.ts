/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Coerce one authored STEP attribute to the scalar shape used by queries. */
export function authoredValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const wrapper = value as { real?: number; typed?: { value?: string | number | boolean } };
    if (typeof wrapper.real === 'number') return wrapper.real;
    if (wrapper.typed?.value !== undefined) return wrapper.typed.value;
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '$' || trimmed === '*' || trimmed === '.U.' || trimmed === '.X.') return undefined;
  if (trimmed === '.T.') return true;
  if (trimmed === '.F.') return false;
  if (trimmed.startsWith('#')) return trimmed;
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('.') && trimmed.endsWith('.')) return trimmed.slice(1, -1);
  return trimmed;
}
