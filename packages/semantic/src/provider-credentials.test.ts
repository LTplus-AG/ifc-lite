/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createSemanticProvider, type ProviderReadOptions } from './provider.js';

describe('decoded provider credential rejection (#6643 review)', () => {
  const bearer = 'synthetic-credential';
  const escaped = [...bearer].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const options = { endpoint: 'https://example.org/query', host: 'example.org', bearer };
  it.each([
    { kind: 'json', body: `{"nested":[{"label":"${escaped}"}]}`, mime: 'application/json' },
    { kind: 'json', body: `{"${escaped}":"safe"}`, mime: 'application/json' },
    { kind: 'select', body: `{"head":{"vars":["label"]},"results":{"bindings":[{"label":{"type":"literal","value":"${escaped}"}}]}}`, mime: 'application/sparql-results+json' },
    { kind: 'construct', body: `<https://example.org/s> <https://example.org/p> "${escaped}" .`, mime: 'text/turtle' },
  ] as const)('rejects escaped credentials in $kind before returning portable data', async ({ kind, body, mime }) => {
    expect(body).not.toContain(bearer);
    const provider = createSemanticProvider(async () => new Response(body, { headers: { 'Content-Type': mime } }));
    const query = kind === 'select' ? 'SELECT ?label WHERE {?s ?p ?label}' : kind === 'construct' ? 'CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o}' : undefined;
    await expect(provider.read({ ...options, kind, query })).rejects.toThrow('Provider response contained a credential');
  });
  it.each(['synthetic"quoted', 'synthetic\\backslash'])('checks decoded JSON strings containing quotes or backslashes', async credential => {
    const body = JSON.stringify({ label: credential });
    expect(body).not.toContain(credential);
    const provider = createSemanticProvider(async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    await expect(provider.read({ ...options, kind: 'json', bearer: credential })).rejects.toThrow('Provider response contained a credential');
  });
  it('keeps malformed JSON response text out of the reported error', async () => {
    const provider = createSemanticProvider(async () => new Response('{"private-provider-detail":', { headers: { 'Content-Type': 'application/json' } }));
    await expect(provider.read({ ...options, kind: 'json' } satisfies ProviderReadOptions)).rejects.toThrow('Invalid semantic provider JSON');
  });
});
