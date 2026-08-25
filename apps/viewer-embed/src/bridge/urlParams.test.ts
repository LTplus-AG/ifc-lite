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

  it.each(['select', 'isolate'] as const)(
    '%s ignores empty segments rather than treating them as express id 0',
    (key) => {
      // `Number('') === 0`, not `NaN` — a `,` alone, or any empty segment
      // from a trailing/doubled comma, must not survive as a real id.
      // `?isolate=,` in particular used to isolate express id 0 (which
      // matches nothing) and blank the whole model with no error.
      setSearch(`?${key}=,`);
      expect(parseUrlParams()[key]).toBeUndefined();
      setSearch(`?${key}=1,,3`);
      expect(parseUrlParams()[key]).toEqual([1, 3]);
    },
  );

  it.each(['select', 'isolate'] as const)('%s rejects zero and negative ids', (key) => {
    setSearch(`?${key}=0,-1,2`);
    expect(parseUrlParams()[key]).toEqual([2]);
  });

  it('splits and trims hideTypes', () => {
    setSearch('?hideTypes=' + encodeURIComponent('IfcSpace, IfcOpeningElement'));
    expect(parseUrlParams().hideTypes).toEqual(['IfcSpace', 'IfcOpeningElement']);
  });

  it('rejects an EMPTY camera segment instead of steering to azimuth 0', () => {
    // `Number('')` is 0, so a plain `!isNaN` filter reads `?camera=,` as a
    // legitimate azimuth 0 / elevation 0 and SNAPS the view, instead of
    // leaving the camera on its `home` fallback. On main the `?camera=`
    // branch was inert, so the bad parse never bit; applying the parameter
    // is what makes it reachable.
    //
    // The guard cannot be "reject 0" -- the SDK ships `camera: {0,0,0}` as a
    // legitimate pose. It has to reject a BLANK SEGMENT before `Number` sees
    // it, which is the same shape as the fix already applied to
    // `select`/`isolate`.
    setSearch('?camera=,');
    expect(parseUrlParams().camera).toBeUndefined();
    // The SDK joins [azimuth, elevation], so a host that omits azimuth emits
    // exactly this.
    setSearch('?camera=,30');
    expect(parseUrlParams().camera).toBeUndefined();
    setSearch('?camera=45,');
    expect(parseUrlParams().camera).toBeUndefined();
    // ... while a real all-zero pose still parses.
    setSearch('?camera=0,0,0');
    expect(parseUrlParams().camera).toEqual({ azimuth: 0, elevation: 0, zoom: 0 });
  });

  it('rejects a NON-FINITE camera segment instead of steering to Infinity', () => {
    // `Number('Infinity')` is `Infinity`, not `NaN`, so an `!isNaN` filter
    // lets `?camera=Infinity,0` through and hands a non-finite azimuth to
    // `setCameraRotation`. The blank-segment guard does not catch it either:
    // the segment is non-empty. Only a finiteness test rejects it.
    setSearch('?camera=Infinity,0');
    expect(parseUrlParams().camera).toBeUndefined();
    setSearch('?camera=0,-Infinity');
    expect(parseUrlParams().camera).toBeUndefined();
    // The optional zoom is subject to the same rule.
    setSearch('?camera=30,-10,Infinity');
    expect(parseUrlParams().camera).toBeUndefined();
    // ... while a finite pose with the same shape still parses.
    setSearch('?camera=30,-10,2');
    expect(parseUrlParams().camera).toEqual({ azimuth: 30, elevation: -10, zoom: 2 });
  });

  it('rejects a NON-INTEGER id rather than passing it through as an express id', () => {
    // The `Number.isInteger` half of the id filter had no covering case: both
    // existing ones (`?select=,` and `?select=0,-1,2`) are decided entirely
    // by `n > 0`, so dropping the integer check left the suite green.
    // A fractional id matches no entity, so isolation blanks the model --
    // the exact failure the filter was added to prevent.
    setSearch('?isolate=1.5');
    expect(parseUrlParams().isolate).toBeUndefined();
    setSearch('?select=1.5,2');
    expect(parseUrlParams().select).toEqual([2]);
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
