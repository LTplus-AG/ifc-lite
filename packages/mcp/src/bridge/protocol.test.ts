/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `--bridge` wire protocol (#9523) is the contract the browser side is
 * built against, so its validators and the pairing-link format are pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  BRIDGE_PROTOCOL_VERSION,
  buildPairingUrl,
  normalizePairingCode,
  parsePairingFragment,
  parseTabMessage,
  validateToolDescriptors,
} from './protocol.js';
import { generatePairingCode } from './pairing.js';

const tool = { name: 'q', description: 'd', inputSchema: { type: 'object' }, readOnly: true };

describe('validateToolDescriptors', () => {
  it('requires an explicit readOnly flag, so a mutating tool cannot be left unmarked', () => {
    const { readOnly: _omitted, ...unmarked } = tool;
    expect(validateToolDescriptors([unmarked])).toMatchObject({ ok: false });
  });

  it('rejects the reserved bridge_status name, duplicates and non-object schemas', () => {
    expect(validateToolDescriptors([{ ...tool, name: 'bridge_status' }])).toMatchObject({ ok: false });
    expect(validateToolDescriptors([tool, tool])).toMatchObject({ ok: false });
    expect(validateToolDescriptors([{ ...tool, inputSchema: { type: 'string' } }])).toMatchObject({ ok: false });
    expect(validateToolDescriptors([{ ...tool, name: 'has space' }])).toMatchObject({ ok: false });
  });

  it('keeps only the protocol fields of a valid tool', () => {
    expect(validateToolDescriptors([{ ...tool, extra: 1 }])).toEqual({ ok: true, value: [tool] });
  });
});

describe('parseTabMessage', () => {
  it('accepts a hello and rejects an unknown permission', () => {
    const hello = { type: 'hello', protocol: BRIDGE_PROTOCOL_VERSION, pairingCode: 'X', permission: 'read-only', tools: [tool] };
    expect(parseTabMessage(JSON.stringify(hello))).toMatchObject({ ok: true, value: { type: 'hello' } });
    expect(parseTabMessage(JSON.stringify({ ...hello, permission: 'admin' }))).toMatchObject({ ok: false });
  });

  it('rejects a result whose content is not an array', () => {
    expect(parseTabMessage(JSON.stringify({ type: 'result', sessionId: 's', id: 'c1', result: { content: 'x' } }))).toMatchObject({ ok: false });
  });

  it('rejects non-JSON and unknown types', () => {
    expect(parseTabMessage('{')).toMatchObject({ ok: false });
    expect(parseTabMessage(JSON.stringify({ type: 'welcome' }))).toMatchObject({ ok: false });
  });
});

describe('pairing link', () => {
  it('carries port and code in the fragment and round-trips', () => {
    const code = generatePairingCode();
    const url = buildPairingUrl('https://ifclite.com/', 21517, code);
    expect(url).toBe(`https://ifclite.com/#mcp-bridge=1&port=21517&code=${code}`);
    expect(new URL(url).search).toBe('');
    expect(parsePairingFragment(new URL(url).hash)).toEqual({ protocol: 1, port: 21517, code });
  });

  it('replaces an existing fragment on the viewer URL', () => {
    expect(buildPairingUrl('http://localhost:5173/#old', 1, 'C')).toBe('http://localhost:5173/#mcp-bridge=1&port=1&code=C');
  });

  it('returns null for fragments that are not pairing links', () => {
    expect(parsePairingFragment('#model=abc')).toBeNull();
    expect(parsePairingFragment('#mcp-bridge=1&port=99999&code=C')).toBeNull();
    expect(parsePairingFragment('#mcp-bridge=1&port=1')).toBeNull();
  });

  it('generates 20-character Crockford codes that normalise case and separators away', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(normalizePairingCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code.replace(/-/g, ''));
    expect(generatePairingCode()).not.toBe(code);
  });
});
