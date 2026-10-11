/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getOpJsonSchema, OP_KINDS, validateOp } from '@ifc-lite/ids-authoring';
import { describe, expect, it } from 'vitest';
import { createToolRegistry, defineTool, success } from './registry.js';
import { agentOpSchema } from './op-schema.js';
import { ALL_TOOLS, registryFor } from './index.js';
import { MODES } from '../modes.js';
import { objectSchema } from './context.js';

const echo = defineTool<{ word: string }, null>({
  name: 'echo', group: 'ids', strict: true, readOnly: true, description: 'Echo a word.',
  inputSchema: objectSchema({ word: { type: 'string', minLength: 1 } }, ['word']),
  run: (input) => success(`echo ${input.word}`, { word: input.word }),
});

const boom = defineTool<Record<string, never>, null>({
  name: 'boom', group: 'ids', strict: true, readOnly: true, description: 'Fails.',
  inputSchema: objectSchema({}, []),
  run: () => { throw new Error('exploded'); },
});

describe('tool registry', () => {
  const registry = createToolRegistry([echo, boom]);

  it('runs a tool on schema-valid input', async () => {
    expect(await registry.call('echo', { word: 'hi' }, undefined, null)).toMatchObject({ ok: true, data: { ok: true, word: 'hi' } });
  });

  it('answers an unknown tool, unparseable JSON, a schema violation and a throwing handler as errors, never a throw', async () => {
    expect(await registry.call('nope', {}, undefined, null)).toMatchObject({ ok: false, signature: ['TOOL:nope'] });
    expect(await registry.call('echo', undefined, '{"word": "h', null)).toMatchObject({ ok: false, data: { error: 'INVALID_JSON' } });
    const invalid = await registry.call('echo', { word: '', extra: 1 }, undefined, null);
    expect(invalid.ok).toBe(false);
    expect((invalid.data as { errors: string[] }).errors).toEqual(expect.arrayContaining(['$.word: must have at least 1 characters', '$.extra: is not allowed']));
    expect(await registry.call('boom', {}, undefined, null)).toMatchObject({ ok: false, data: { error: 'exploded' } });
  });

  it('rejects provider-invalid and duplicate tool names', () => {
    expect(() => createToolRegistry([{ ...echo, name: 'ids.read' }])).toThrow(/Invalid tool name/);
    expect(() => createToolRegistry([echo, echo])).toThrow(/Duplicate/);
  });

  it('exposes specs with $defs inline and the strict flag', () => {
    const specs = registryFor(MODES.draft, { model: false, bsdd: false }).specs();
    const apply = specs.find((s) => s.name === 'ids_apply_ops');
    expect(apply?.strict).toBe(false);
    expect(apply?.inputSchema.$defs).toHaveProperty('AgentOp');
    expect(specs.find((s) => s.name === 'schema_entity')?.strict).toBe(true);
  });

  it('every strict tool has a closed object schema (what strict tool use requires)', () => {
    for (const tool of ALL_TOOLS.filter((t) => t.strict)) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('$ref');
    }
  });

  it('offers tools by mode and by what the host provides', () => {
    const names = (mode: keyof typeof MODES, available = { model: false, bsdd: false }) => registryFor(MODES[mode], available).specs().map((s) => s.name);
    expect(names('draft')).not.toContain('model_stats');
    expect(names('draft', { model: true, bsdd: true })).toEqual(expect.arrayContaining(['model_stats', 'bsdd_search']));
    expect(names('explain')).not.toEqual(expect.arrayContaining(['ids_apply_ops']));
    expect(names('explain')).toContain('ids_read');
    expect(names('translate')).toEqual(['ids_read', 'ids_apply_ops', 'ids_undo', 'ids_lint', 'ids_mark_unresolved']);
  });
});

describe('agent op schema (generated from getOpJsonSchema)', () => {
  it('covers every authoring kind of the vocabulary and none of the fidelity kinds', () => {
    const { kinds } = agentOpSchema();
    const fidelity = ['spec.restore', 'spec.patch', 'facet.restore', 'facet.patch'];
    expect(kinds).toEqual(OP_KINDS.filter((k) => !fidelity.includes(k)));
  });

  it('reuses the vocabulary payload schemas unchanged, with opId optional and handles allowed', () => {
    const { defs } = agentOpSchema();
    const source = getOpJsonSchema().$defs as Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
    expect(defs.Op_spec_add.properties?.payload).toEqual(source.Op_spec_add.properties?.payload);
    expect(defs.Op_spec_add.required).toEqual(['kind', 'payload']);
    const pattern = new RegExp(String(defs.Uuid.pattern));
    expect(pattern.test('@doors')).toBe(true);
    expect(pattern.test('0190e2c4-5f6a-7b8c-9d0e-1f2a3b4c5d6e')).toBe(true);
    expect(pattern.test('0190e2c4-5f6a-7b8c-9d0e-1f2a3b4c5d6e-tail')).toBe(false);
    expect(pattern.test('doors')).toBe(false);
  });

  it('the real op validator still guards resolved ops', () => {
    expect(validateOp({ kind: 'spec.add', payload: { specId: '@x', name: 'n', ifcVersions: ['IFC4'] } }).ok).toBe(false);
  });
});
