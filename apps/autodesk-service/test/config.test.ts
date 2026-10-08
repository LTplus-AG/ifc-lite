/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';
const base = { origin: 'https://viewer.example', clientId: 'public-id', clientSecret: 'server-secret' };
describe('Autodesk deployment configuration', () => {
  it('accepts exact HTTPS and explicit loopback development origins', () => {
    expect(validateConfig(base).origin).toBe(base.origin);
    expect(validateConfig({ ...base, origin: 'http://localhost:5173', insecureLocalhost: true }).origin).toBe('http://localhost:5173');
  });
  it('never permits insecure cookies for a non-loopback deployment', () => {
    expect(() => validateConfig({ ...base, insecureLocalhost: true })).toThrow('loopback');
    expect(() => validateConfig({ ...base, origin: 'http://viewer.example', insecureLocalhost: true })).toThrow('loopback');
    expect(() => validateConfig({ ...base, origin: 'http://localhost:5173' })).toThrow('HTTPS');
  });
  it('rejects origins with paths or credentials and invalid resource limits', () => {
    for (const origin of ['https://viewer.example/path', 'https://user:password@viewer.example', 'https://viewer.example/']) {
      expect(() => validateConfig({ ...base, origin })).toThrow();
    }
    for (const maxSessions of [0, -1, Infinity, NaN, 1.5]) expect(() => validateConfig({ ...base, maxSessions })).toThrow('positive safe integers');
    expect(() => validateConfig({ ...base, maxArtifactBytes: -1 })).toThrow('positive safe integers');
    expect(() => validateConfig({ ...base, clientSecret: '' })).toThrow('server-side');
  });
});
