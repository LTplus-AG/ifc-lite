/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { createResourceUriStrategy, assertResourceUriIdentityConfig, resourceUriForGlobalId } from './uri-resolver.js';
import { IFC_GLOBAL_ID_STRATEGY } from './resolver.js';
const GlobalId = '1Oms875aH3Wg$9l65H2ZGw';
const id = `https://lbd.org/${GlobalId}`;
const config = { mode: 'template' as const, template: 'https://lbd.org/{GlobalId}' };
const context = { entities: [{ modelId: 'a', expressId: 17468, GlobalId }], revisions: new Map<string, string>() };
describe('resource URI identity (#6783)', () => {
  it('extracts compressed GlobalId from raw and once-encoded URI without changing resource identity', () => {
    const strategy = createResourceUriStrategy(config);
    for (const resourceId of [id, id.replace('$', '%24')]) {
      const record = { id: resourceId };
      expect(strategy.resolve(record, context)).toEqual({ status: 'resolved', ref: { modelId: 'a', expressId: 17468 } });
      expect(record.id).toBe(resourceId);
    }
    expect(resourceUriForGlobalId(GlobalId, config)).toBe(id);
  });
  it('retains canonical federation ambiguity, revision association and explicit scope', () => {
    const strategy = createResourceUriStrategy(config); const entities = [...context.entities, { modelId: 'b', expressId: 7, GlobalId }];
    expect(strategy.resolve({ id }, { ...context, entities }).status).toBe('ambiguous');
    expect(strategy.resolve({ id, modelRevision: 'r' }, { ...context, entities }).status).toBe('unscoped');
    expect(strategy.resolve({ id, modelRevision: 'r' }, { entities, revisions: new Map([['r', 'b']]) })).toEqual({ status: 'resolved', ref: { modelId: 'b', expressId: 7 } });
    expect(strategy.resolve({ id }, { ...context, entities, modelScope: 'a' }).status).toBe('resolved');
    expect(strategy.resolve({ id, modelRevision: 'r' }, { entities, revisions: new Map([['r', 'b']]), modelScope: 'a' }).status).toBe('unmatched');
  });
  it('rejects wrong template, delimiters, credentials and double/malformed percent decoding', () => {
    const strategy = createResourceUriStrategy(config);
    for (const resourceId of [id.replace('lbd.org', 'wrong.org'), id + '?x=1', id + '#x', id + '?', id + '#', id.replace('$', '%2F'), id.replace('$', '%5C'), id.replace('$', '%2524'), id.replace('$', '%'), id.replace('https://', 'https://secret@'), id + '/', id + '/x/..', id + '/x/%2e%2e', id.replace('lbd.org', 'lbd.org/%zz'), 'urn:x:' + GlobalId]) expect(strategy.resolve({ id: resourceId }, context).status).toBe('invalid');
    expect(strategy.resolve({ id, GlobalId: '0000000000000000000001' }, context).status).toBe('invalid');
    expect(IFC_GLOBAL_ID_STRATEGY.resolve({ id, GlobalId: 'wrong' }, context).status).toBe('invalid');
    expect(IFC_GLOBAL_ID_STRATEGY.resolve({ id }, context).status).toBe('external');
  });
  it('requires explicit bounded single-placeholder templates and captures immutable configuration', () => {
    for (const template of ['https://lbd.org/', 'https://{GlobalId}.org/x', 'https://{GlobalId}.org/0000000000000000000001', 'https://lbd.org/{GlobalId}/{GlobalId}', 'https://lbd.org/{other}', 'https://lbd.org/{GlobalId}?token=x', 'https://lbd.org/{GlobalId}?', 'https://lbd.org/{GlobalId}#', 'https://lbd.org/' + 'a'.repeat(2048) + '{GlobalId}']) expect(() => assertResourceUriIdentityConfig({ mode: 'template', template })).toThrow();
    expect(() => assertResourceUriIdentityConfig([])).toThrow();
    expect(() => assertResourceUriIdentityConfig(Object.create(config) as unknown)).toThrow();
    expect(() => assertResourceUriIdentityConfig({ ...config, bearer: 'secret' })).toThrow(/Unknown/);
    const mutable = { ...config }; const strategy = createResourceUriStrategy(mutable); mutable.template = 'https://other.org/{GlobalId}';
    expect(strategy.resolve({ id }, context).status).toBe('resolved');
  });
  it('last path segment is opt-in and cannot invent unknown reverse URI bases', () => {
    const segment = { mode: 'last-path-segment' as const }; const strategy = createResourceUriStrategy(segment);
    expect(strategy.resolve({ id: `https://other.org/resource/${GlobalId.replace('$', '%24')}` }, context).status).toBe('resolved');
    expect(strategy.resolve({ id: `https://other.org/resource/${GlobalId}/` }, context).status).toBe('invalid');
    expect(() => resourceUriForGlobalId(GlobalId, segment)).toThrow(/full URI template|known resource/);
  });
});

describe('URI template rendering invariants (#6783 review)', () => {
  it('preserves every compressed identifier character, including consecutive dollar signs', () => {
    const GlobalId = '0' + '$'.repeat(21);
    const uri = resourceUriForGlobalId(GlobalId, config);
    expect(uri).toBe(`https://lbd.org/${GlobalId}`);
    const context = { entities: [{ modelId: 'dollars', expressId: 7, GlobalId }], revisions: new Map<string, string>() };
    expect(createResourceUriStrategy(config).resolve({ id: uri }, context)).toEqual({ status: 'resolved', ref: { modelId: 'dollars', expressId: 7 } });
  });
  it('accepts the expanded length boundary and every rendered URI resolves through the same strategy', () => {
    const templateAtExpandedLength = (length: number) => 'https://lbd.org/' + 'a'.repeat(length - 'https://lbd.org/'.length - GlobalId.length) + '{GlobalId}';
    const boundary = { mode: 'template' as const, template: templateAtExpandedLength(2048) };
    const uri = resourceUriForGlobalId(GlobalId, boundary); expect(uri.length).toBe(2048);
    expect(createResourceUriStrategy(boundary).resolve({ id: uri }, context).status).toBe('resolved');
    for (const length of [2049, 2060]) {
      const tooLong = { mode: 'template' as const, template: templateAtExpandedLength(length) };
      expect(() => assertResourceUriIdentityConfig(tooLong)).toThrow(/Expanded resource URI/);
      expect(() => resourceUriForGlobalId(GlobalId, tooLong)).toThrow(/2048/);
    }
  });
  it('rejects placeholders consuming percent escapes while complete literal escapes remain reversible', () => {
    for (const prefix of ['%', '%2', '%A', '%a']) {
      const partial = { mode: 'template' as const, template: `https://lbd.org/${prefix}{GlobalId}` };
      expect(() => assertResourceUriIdentityConfig(partial)).toThrow(/percent escape/);
      expect(() => resourceUriForGlobalId(GlobalId, partial)).toThrow(/percent escape/);
    }
    const literalEscape = { mode: 'template' as const, template: 'https://lbd.org/%25{GlobalId}' };
    const uri = resourceUriForGlobalId(GlobalId, literalEscape);
    expect(createResourceUriStrategy(literalEscape).resolve({ id: uri }, context).status).toBe('resolved');
    expect(uri).toBe(`https://lbd.org/%25${GlobalId}`);
  });
});
