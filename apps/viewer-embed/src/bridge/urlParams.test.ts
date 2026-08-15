/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * URL-parameter parsing tests.
 *
 * These params are attacker-influenceable (anyone can craft the iframe src),
 * so every validator here — the http(s) scheme gate, the hex-colour gate and
 * the origin normalisation feeding the bridge allowlist — is pinned in both
 * the accept and the reject direction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFetchableUrl, parseUrlParams } from './urlParams.js';

function setSearch(search: string, origin = 'https://embed.example') {
  (globalThis as any).window = { location: { search, origin } };
}

beforeEach(() => {
  setSearch('');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
});

describe('assertFetchableUrl', () => {
  it.each([
    ['https://cdn.example/model.ifc', 'https://cdn.example/model.ifc'],
    ['http://cdn.example/model.ifc', 'http://cdn.example/model.ifc'],
    ['/demo/house.ifc', 'https://embed.example/demo/house.ifc'],
  ])('accepts %s and returns the resolved href', (input, expected) => {
    expect(assertFetchableUrl(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/plain,hi',
    'file:///etc/passwd',
    'blob:https://embed.example/abc',
    'ftp://cdn.example/model.ifc',
  ])('rejects the unsupported scheme in %s', (input) => {
    expect(() => assertFetchableUrl(input)).toThrow(/Unsupported URL scheme/);
  });

  it.each([['an empty string', ''], ['a non-string', 42 as unknown as string]])(
    'rejects %s',
    (_label, input) => {
      expect(() => assertFetchableUrl(input)).toThrow('Model URL must be a non-empty string');
    },
  );

  it('rejects a malformed URL', () => {
    expect(() => assertFetchableUrl('http://')).toThrow();
  });
});

describe('parseUrlParams', () => {
  it('returns an empty object for an empty query string', () => {
    setSearch('');
    expect(parseUrlParams()).toEqual({});
  });

  it('accepts an http(s) modelUrl verbatim', () => {
    setSearch('?modelUrl=https://cdn.example/a.ifc');
    expect(parseUrlParams().modelUrl).toBe('https://cdn.example/a.ifc');
  });

  it('drops a modelUrl with an unsupported scheme', () => {
    setSearch('?modelUrl=' + encodeURIComponent('javascript:alert(1)'));
    expect(parseUrlParams().modelUrl).toBeUndefined();
  });

  it('resolves ?demo to a bundled model and lets modelUrl override it', () => {
    setSearch('?demo');
    expect(parseUrlParams().modelUrl).toBe('/demo/AC20-FZK-Haus.ifc');
    setSearch('?demo=unknown-key');
    expect(parseUrlParams().modelUrl).toBe('/demo/AC20-FZK-Haus.ifc');
    setSearch('?demo&modelUrl=https://cdn.example/a.ifc');
    expect(parseUrlParams().modelUrl).toBe('https://cdn.example/a.ifc');
  });

  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
  ])('accepts theme=%s', (input, expected) => {
    setSearch(`?theme=${input}`);
    expect(parseUrlParams().theme).toBe(expected);
  });

  it('ignores an unknown theme', () => {
    setSearch('?theme=neon');
    expect(parseUrlParams().theme).toBeUndefined();
  });

  it.each(['abc', 'a1b2c3', 'a1b2c3d4'])('accepts hex bg %s', (bg) => {
    setSearch(`?bg=${bg}`);
    expect(parseUrlParams().bg).toBe(bg);
  });

  it.each(['ab', 'a1b2c3d4e', 'ggg', 'red', 'a1b2c;'])('rejects bg %j', (bg) => {
    setSearch(`?bg=${encodeURIComponent(bg)}`);
    expect(parseUrlParams().bg).toBeUndefined();
  });

  it('accepts the four known controls values and rejects others', () => {
    for (const c of ['orbit', 'pan', 'all', 'none']) {
      setSearch(`?controls=${c}`);
      expect(parseUrlParams().controls).toBe(c);
    }
    setSearch('?controls=fly');
    expect(parseUrlParams().controls).toBeUndefined();
  });

  it('treats autoLoad as true unless it is literally "false"', () => {
    setSearch('?autoLoad');
    expect(parseUrlParams().autoLoad).toBe(true);
    setSearch('?autoLoad=false');
    expect(parseUrlParams().autoLoad).toBe(false);
    setSearch('?autoLoad=0');
    expect(parseUrlParams().autoLoad).toBe(true);
    setSearch('');
    expect(parseUrlParams().autoLoad).toBeUndefined();
  });

  it.each(['hideAxis', 'hideScale'] as const)('sets %s only for the exact string "true"', (key) => {
    setSearch(`?${key}=true`);
    expect(parseUrlParams()[key]).toBe(true);
    setSearch(`?${key}=1`);
    expect(parseUrlParams()[key]).toBeUndefined();
    setSearch(`?${key}=TRUE`);
    expect(parseUrlParams()[key]).toBeUndefined();
  });

  it.each(['select', 'isolate'] as const)('parses %s as a numeric id list', (key) => {
    setSearch(`?${key}=1,2,3`);
    expect(parseUrlParams()[key]).toEqual([1, 2, 3]);
    setSearch(`?${key}=1,oops,3`);
    expect(parseUrlParams()[key]).toEqual([1, 3]);
    setSearch(`?${key}=oops`);
    expect(parseUrlParams()[key]).toBeUndefined();
  });

  it('splits and trims hideTypes', () => {
    setSearch('?hideTypes=' + encodeURIComponent('IfcSpace, IfcOpeningElement'));
    expect(parseUrlParams().hideTypes).toEqual(['IfcSpace', 'IfcOpeningElement']);
  });

  it('parses camera with an optional zoom and rejects partial or non-numeric input', () => {
    setSearch('?camera=30,-10');
    expect(parseUrlParams().camera).toEqual({ azimuth: 30, elevation: -10, zoom: undefined });
    setSearch('?camera=30,-10,2');
    expect(parseUrlParams().camera).toEqual({ azimuth: 30, elevation: -10, zoom: 2 });
    setSearch('?camera=30');
    expect(parseUrlParams().camera).toBeUndefined();
    setSearch('?camera=30,north');
    expect(parseUrlParams().camera).toBeUndefined();
  });

  it('accepts only the six view presets', () => {
    for (const v of ['top', 'bottom', 'front', 'back', 'left', 'right']) {
      setSearch(`?view=${v}`);
      expect(parseUrlParams().view).toBe(v);
    }
    setSearch('?view=isometric');
    expect(parseUrlParams().view).toBeUndefined();
  });

  it('normalises allowOrigin entries to bare origins and drops invalid ones', () => {
    setSearch('?allowOrigin=' + encodeURIComponent('https://a.example/path, https://b.example:8443'));
    expect(parseUrlParams().allowOrigins).toEqual(['https://a.example', 'https://b.example:8443']);
  });

  it('leaves allowOrigins unset when every entry is invalid', () => {
    // A bare host is not a URL — leaving allowOrigins unset means the bridge
    // falls back to accepting all senders, so this must not silently "work".
    setSearch('?allowOrigin=' + encodeURIComponent('a.example,not a url'));
    expect(parseUrlParams().allowOrigins).toBeUndefined();
  });

  it('normalises parentOrigin and ignores an invalid one', () => {
    setSearch('?parentOrigin=' + encodeURIComponent('https://host.example/embed?x=1'));
    expect(parseUrlParams().parentOrigin).toBe('https://host.example');
    setSearch('?parentOrigin=host.example');
    expect(parseUrlParams().parentOrigin).toBeUndefined();
  });
});
