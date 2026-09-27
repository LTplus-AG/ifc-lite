/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { FlowDocument } from '@ifc-lite/flow';
import {
  buildRedactionMap,
  declaredSecrets,
  interpolateSecrets,
  redactDeep,
  redactText,
  referencedSecrets,
  resolveSecretValues,
  usableSecretNames,
  validateSecretReferences,
} from './secrets.js';

function doc(overrides: Partial<FlowDocument>): FlowDocument {
  return { flowVersion: 1, id: 'g', name: 'g', capabilities: [], inputs: [], outputs: [], nodes: [], edges: [], ...overrides };
}

describe('declaredSecrets', () => {
  it('reads secret.read:<NAME> capabilities from the document', () => {
    const d = doc({ capabilities: ['secret.read:API_TOKEN', 'model.read'] });
    expect(declaredSecrets(d)).toEqual(new Set(['API_TOKEN']));
  });

  it('ignores malformed capability strings rather than throwing', () => {
    const d = doc({ capabilities: ['not a capability'] });
    expect(declaredSecrets(d)).toEqual(new Set());
  });
});

describe('referencedSecrets', () => {
  it('finds a reference in a plain string param', () => {
    const d = doc({ nodes: [{ id: 'n1', type: 'http.request', params: { url: 'https://x/{{secret:TOKEN}}' } }] });
    expect(referencedSecrets(d)).toEqual([{ nodeId: 'n1', param: 'url', name: 'TOKEN' }]);
  });

  it('finds a reference nested inside a json-kind header map', () => {
    const d = doc({
      nodes: [{ id: 'n1', type: 'http.request', params: { headers: { Authorization: 'Bearer {{secret:API_TOKEN}}' } } }],
    });
    expect(referencedSecrets(d)).toEqual([{ nodeId: 'n1', param: 'headers', name: 'API_TOKEN' }]);
  });

  it('finds multiple references across nodes and params', () => {
    const d = doc({
      nodes: [
        { id: 'n1', type: 'http.request', params: { url: 'https://x/{{secret:A}}' } },
        { id: 'n2', type: 'http.request', params: { headers: { h: '{{secret:B}}' }, body: '{{secret:C}}' } },
      ],
    });
    expect(referencedSecrets(d).map((r) => r.name).sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('validateSecretReferences', () => {
  it('is clean for a graph with no secret references', () => {
    const d = doc({ nodes: [{ id: 'n1', type: 'http.request', params: { url: 'https://x/' } }] });
    expect(validateSecretReferences(d, {})).toEqual([]);
  });

  it('reports an undeclared reference as a validation error, not a silent empty string', () => {
    const d = doc({ nodes: [{ id: 'n1', type: 'http.request', params: { url: 'https://x/{{secret:TOKEN}}' } }] });
    const errors = validateSecretReferences(d, { TOKEN: 'abc123456' });
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe('undeclared');
  });

  it('reports a declared-but-unset secret as a validation error', () => {
    const d = doc({
      capabilities: ['secret.read:TOKEN'],
      nodes: [{ id: 'n1', type: 'http.request', params: { url: 'https://x/{{secret:TOKEN}}' } }],
    });
    const errors = validateSecretReferences(d, {});
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe('unset');
  });

  it('passes when the secret is declared, referenced, and set', () => {
    const d = doc({
      capabilities: ['secret.read:TOKEN'],
      nodes: [{ id: 'n1', type: 'http.request', params: { url: 'https://x/{{secret:TOKEN}}' } }],
    });
    expect(validateSecretReferences(d, { TOKEN: 'abc123456' })).toEqual([]);
  });
});

describe('resolveSecretValues + interpolateSecrets', () => {
  it('substitutes a resolved secret into a string param', () => {
    const d = doc({
      capabilities: ['secret.read:TOKEN'],
      nodes: [{ id: 'n1', type: 'http.request', params: { url: 'https://x/?t={{secret:TOKEN}}' } }],
    });
    const values = resolveSecretValues(d, { TOKEN: 'sekret-value-123' });
    const out = interpolateSecrets(d, values);
    expect(out.nodes[0].params?.url).toBe('https://x/?t=sekret-value-123');
    // The input document is never mutated.
    expect(d.nodes[0].params?.url).toBe('https://x/?t={{secret:TOKEN}}');
  });

  it('substitutes inside a nested json param without disturbing sibling keys', () => {
    const d = doc({
      capabilities: ['secret.read:TOKEN'],
      nodes: [{ id: 'n1', type: 'http.request', params: { headers: { Authorization: 'Bearer {{secret:TOKEN}}', Accept: 'application/json' } } }],
    });
    const values = resolveSecretValues(d, { TOKEN: 'sekret-value-123' });
    const out = interpolateSecrets(d, values);
    expect(out.nodes[0].params?.headers).toEqual({ Authorization: 'Bearer sekret-value-123', Accept: 'application/json' });
  });
});

describe('redaction', () => {
  it('does not redact a secret shorter than the minimum length', () => {
    const map = buildRedactionMap(new Map([['SHORT', 'abc']]));
    expect(map.size).toBe(0);
  });

  it('redacts a long secret value wherever it appears in text', () => {
    const map = buildRedactionMap(new Map([['TOKEN', 'sekret-value-123']]));
    expect(redactText('auth failed for sekret-value-123 on host x', map)).toBe('auth failed for <secret:TOKEN> on host x');
  });

  it('redacts every occurrence, not just the first', () => {
    const map = buildRedactionMap(new Map([['TOKEN', 'abcdef123456']]));
    const text = 'first: abcdef123456, second: abcdef123456';
    expect(redactText(text, map)).toBe('first: <secret:TOKEN>, second: <secret:TOKEN>');
  });

  it('redactDeep scrubs strings at any depth of an arbitrary structure', () => {
    const map = buildRedactionMap(new Map([['TOKEN', 'sekret-value-123']]));
    const value = {
      log: ['request sent with token sekret-value-123'],
      response: { body: 'echo: sekret-value-123', status: 401 },
      nested: [{ deep: ['sekret-value-123'] }],
    };
    const redacted = redactDeep(value, map);
    expect(JSON.stringify(redacted)).not.toContain('sekret-value-123');
    expect(redacted.response.status).toBe(401);
  });
});

describe('redaction — overlapping and shared secret values (#5446 review)', () => {
  it('redacts a secret that contains another whole, without exposing its suffix', () => {
    const redaction = buildRedactionMap(new Map([['A', 'abcdef'], ['B', 'abcdefghi']]));
    expect(redactText('x abcdefghi y abcdef z', redaction)).toBe('x <secret:B> y <secret:A> z');
  });

  it('names every secret that shares one value, rather than letting one take it over', () => {
    const redaction = buildRedactionMap(new Map([['TOKEN', 'same-value-123'], ['ALIAS', 'same-value-123']]));
    expect(redactText('Bearer same-value-123', redaction)).toBe('Bearer <secret:ALIAS|TOKEN>');
  });

  it('treats regex metacharacters in a secret literally', () => {
    const redaction = buildRedactionMap(new Map([['P', 'a.b*c+d?']]));
    expect(redactText('axbbc a.b*c+d?', redaction)).toBe('axbbc <secret:P>');
  });
});

describe('secret availability and key redaction (#5446 review)', () => {
  it('reports only set secrets long enough to redact as usable', () => {
    // A 4-character value is refused at run time, so it must not count as
    // available to `flow validate` either.
    expect(usableSecretNames({ LONG: 'long-enough', SHORT: '4711', EMPTY: '', UNSET: undefined })).toEqual(['LONG']);
  });

  it('redacts secrets used as object keys and map keys, not only values', () => {
    const redaction = buildRedactionMap(new Map([['K', 'key-secret-99']]));
    const out = redactDeep({ 'key-secret-99': 1, nested: new Map([['key-secret-99', 2]]) }, redaction);
    expect(Object.keys(out)).toEqual(['<secret:K>', 'nested']);
    expect([...(out.nested as Map<string, number>).keys()]).toEqual(['<secret:K>']);
  });
});
