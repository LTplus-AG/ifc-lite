/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict proposal bounds (#7241); native document/wiring validation owns input kinds and param contracts. */
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));

export function assertBoundedPlayerInputs(value: unknown): void {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid bounded Flow Player inputs');
  const bindings = new Set<string>();
  for (const input of value) {
    if (!record(input) || !only(input, ['nodeId', 'param', 'label', 'kind', 'options', 'fileSlots'])
      || !text(input.nodeId, 64) || !text(input.param, 200) || !text(input.label, 120) || !text(input.kind, 30)
      || (input.options !== undefined && (!Array.isArray(input.options) || input.options.length > 100 || !input.options.every(option => text(option, 240))))) {
      throw new Error('Invalid bounded Flow Player input');
    }
    const key = JSON.stringify([input.nodeId, input.param]);
    if (bindings.has(key)) throw new Error(`Duplicate Flow Player input: ${input.nodeId}.${input.param}`);
    bindings.add(key);
    if (input.fileSlots !== undefined) {
      if (!Array.isArray(input.fileSlots) || input.fileSlots.length > 100) throw new Error('Invalid bounded Flow Player file slots');
      for (const slot of input.fileSlots) {
        if (!record(slot) || !only(slot, ['id', 'label', 'accept', 'multiple', 'required']) || !text(slot.id, 120) || !text(slot.label, 120)
          || typeof slot.accept !== 'string' || slot.accept.length > 500 || typeof slot.multiple !== 'boolean' || typeof slot.required !== 'boolean') {
          throw new Error('Invalid bounded Flow Player file slot');
        }
      }
    }
  }
}
