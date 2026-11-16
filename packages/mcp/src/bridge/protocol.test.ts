/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `--bridge` wire protocol (#9523) is the contract the browser side is
 * built against, so its validators and the pairing-link format are pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  buildPairingUrl,
  parseServerMessage,
  normalizePairingCode,
  parsePairingFragment,
  parseTabMessage,
  validateToolDescriptors,
} from './bridge-protocol.js';
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

describe('image result content', () => {
  const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
  const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const WEBP = b64([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
  const result = (...content: unknown[]) => parseTabMessage(JSON.stringify({ type: 'result', sessionId: 's', id: 'c1', result: { content } }));
  const text = { type: 'text', text: 'shot' };

  it.each([['image/png', PNG], ['image/jpeg', JPEG], ['image/webp', WEBP]])('accepts a %s image and keeps only the protocol fields', (mimeType, data) => {
    expect(result(text, { type: 'image', data, mimeType, extra: 1 })).toEqual({
      ok: true,
      value: { type: 'result', sessionId: 's', id: 'c1', result: { content: [text, { type: 'image', data, mimeType }] } },
    });
  });

  it.each([
    ['a signature that does not match the declared type', { data: JPEG, mimeType: 'image/png' }, /file signature/],
    ['a PNG declared as WebP', { data: PNG, mimeType: 'image/webp' }, /file signature/],
    ['an unknown MIME type', { data: PNG, mimeType: 'image/gif' }, /mimeType must be one of/],
    ['an SVG', { data: PNG, mimeType: 'image/svg+xml' }, /mimeType must be one of/],
    ['characters outside base64', { data: `${PNG.slice(0, -4)}#AAA`, mimeType: 'image/png' }, /canonical base64/],
    ['a length that is not a multiple of 4', { data: `${PNG}A`, mimeType: 'image/png' }, /canonical base64/],
    ['padding in the middle', { data: `${PNG.slice(0, 8)}=${PNG.slice(9)}`, mimeType: 'image/png' }, /canonical base64/],
    ['a data URL instead of bare base64', { data: `data:image/png;base64,${PNG}`, mimeType: 'image/png' }, /canonical base64/],
    ['data that is not a string', { data: 42, mimeType: 'image/png' }, /base64 string/],
    ['an image over maxImageBytes', { data: PNG + 'A'.repeat(BRIDGE_LIMITS.maxImageBytes), mimeType: 'image/png' }, /limit is 3145728/],
  ])('refuses %s', (_label, image, error) => {
    const parsed = result(text, { type: 'image', ...image });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toMatch(error);
  });

  it('refuses more than maxImagesPerResult images', () => {
    const image = { type: 'image', data: PNG, mimeType: 'image/png' };
    expect(result(...Array(BRIDGE_LIMITS.maxImagesPerResult).fill(image))).toMatchObject({ ok: true });
    expect(result(...Array(BRIDGE_LIMITS.maxImagesPerResult + 1).fill(image))).toMatchObject({ ok: false, error: expect.stringMatching(/at most 2 images/) });
  });

  it('keeps one image under the whole-result limit', () => {
    expect(BRIDGE_LIMITS.maxImageBytes).toBeLessThan(BRIDGE_LIMITS.maxResultBytes);
  });

  it('still refuses resource content', () => {
    expect(result({ type: 'resource', resource: { uri: 'file:///etc/passwd' } })).toMatchObject({ ok: false });
  });
});

describe('welcome features (tab side)', () => {
  const welcome = { type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION, sessionId: 's', permission: 'read-only', readOnlyCeiling: false, bridge: { name: 'b', version: '1' } };

  it('reads the features a bridge advertises, and none from an older bridge', () => {
    expect(parseServerMessage(JSON.stringify({ ...welcome, features: ['image-content', 7] }))).toMatchObject({ ok: true, value: { features: ['image-content'] } });
    expect(parseServerMessage(JSON.stringify(welcome))).toMatchObject({ ok: true, value: { features: [] } });
    expect(parseServerMessage(JSON.stringify({ ...welcome, features: 'image-content' }))).toMatchObject({ ok: true, value: { features: [] } });
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
