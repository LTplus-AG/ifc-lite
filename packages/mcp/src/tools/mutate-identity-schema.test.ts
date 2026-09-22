/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5192: `entity_set_property`, `entity_delete_property`, `entity_set_attribute`
 * and `entity_delete` each accept `global_id` OR `express_id`, but only
 * `resolveExpressId` (called from inside the handler) ever enforced that —
 * `entity_delete` had no `required` array at all, so
 * `entity_delete({ model_id: 'm1' })` validated cleanly and failed only at
 * runtime.
 *
 * These tests run `validateInput` directly against each tool's
 * `inputSchema`, the same call `server.ts` makes before a handler ever runs
 * (and that `mutation_batch` repeats per sub-op). No model/backend is
 * constructed: the point is that the *schema* now rejects the missing-identity
 * case, not that the handler does.
 */

import { describe, expect, it, vi } from 'vitest';
import { validateInput } from '../validate.js';

// `mutate.ts` pulls in `@ifc-lite/query` and `@ifc-lite/sdk` for real entity
// resolution (`EntityNode`, `propertyValueTypeOf`), which this file never
// calls — it only inspects `inputSchema`, static data on each `Tool`. Those
// two packages require the (banned-here) wasm build to compile from a fresh
// worktree, so they're stubbed purely to let the module load; the objects
// under test (`inputSchema`) are untouched by the stubs.
vi.mock('@ifc-lite/query', () => ({ EntityNode: class {} }));
vi.mock('@ifc-lite/sdk', () => ({ propertyValueTypeOf: () => 'string' }));
vi.mock('@ifc-lite/parser', () => ({
  getInheritanceChainAcrossSchemas: () => [],
  effectiveRelationshipEdges: () => [],
  resolveEffectiveEntityRecord: () => undefined,
  resolveEffectiveRelationshipOverlay: () => undefined,
  normalizeIfcTypeName: (s: string) => s,
}));

const { mutationTools } = await import('./mutate.js');

function schemaOf(name: string) {
  const found = mutationTools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found.inputSchema;
}

describe('mutate tool schemas require global_id or express_id', () => {
  const cases: Array<{ name: string; validExtra: Record<string, unknown> }> = [
    { name: 'entity_set_property', validExtra: { pset: 'Pset_WallCommon', name: 'Reference', value: 'W-01' } },
    { name: 'entity_delete_property', validExtra: { pset: 'Pset_WallCommon', name: 'Reference' } },
    { name: 'entity_set_attribute', validExtra: { attribute: 'Name', value: 'New name' } },
    { name: 'entity_delete', validExtra: {} },
  ];

  for (const { name, validExtra } of cases) {
    describe(name, () => {
      it('rejects a call with neither global_id nor express_id at validation time', () => {
        const r = validateInput(schemaOf(name), { model_id: 'm1', ...validExtra });
        expect(r.valid).toBe(false);
        expect(r.errors.some((e) => /anyOf/.test(e.message))).toBe(true);
      });

      it('accepts global_id alone', () => {
        const r = validateInput(schemaOf(name), { model_id: 'm1', global_id: 'GLOBAL00000000000000001', ...validExtra });
        expect(r.valid).toBe(true);
      });

      it('accepts express_id alone', () => {
        const r = validateInput(schemaOf(name), { model_id: 'm1', express_id: 70, ...validExtra });
        expect(r.valid).toBe(true);
      });

      // No-regression pin: today's existing valid calls (both identity fields
      // present, or the tool's own other required fields) must keep validating.
      // The likely failure mode of adding `anyOf` is an over-strict schema that
      // now rejects calls that work today.
      it('still accepts a call supplying both global_id and express_id', () => {
        const r = validateInput(schemaOf(name), {
          model_id: 'm1', global_id: 'GLOBAL00000000000000001', express_id: 70, ...validExtra,
        });
        expect(r.valid).toBe(true);
      });

      it('still flags the tool\'s own other required fields as missing', () => {
        if (Object.keys(validExtra).length === 0) return; // entity_delete has none
        const r = validateInput(schemaOf(name), { model_id: 'm1', express_id: 70 });
        expect(r.valid).toBe(false);
        expect(r.errors.some((e) => e.message === 'Required property missing')).toBe(true);
      });
    });
  }
});
