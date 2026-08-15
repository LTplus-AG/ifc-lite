/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, afterEach } from 'vitest';
import { IFCLiteEmbed } from '../src/index.js';
import { mount, DEFAULT_ORIGIN, type Harness } from './harness.js';

let h: Harness | undefined;
afterEach(() => { h?.cleanup(); h = undefined; });

function urlOf(opts: Parameters<typeof mount>[0]): URL {
  h = mount(opts);
  return new URL(h.iframe.src);
}

describe('iframe URL construction', () => {
  it('defaults to the production embed origin and the /v1 path', () => {
    const url = urlOf({});
    expect(url.origin).toBe(DEFAULT_ORIGIN);
    expect(url.pathname).toBe('/v1');
  });

  it('honours a custom origin', () => {
    const url = urlOf({ origin: 'https://embed.example.test' });
    expect(url.origin).toBe('https://embed.example.test');
    expect(url.pathname).toBe('/v1');
  });

  it('emits no query params when no options are given', () => {
    expect([...urlOf({}).searchParams.keys()]).toEqual([]);
  });

  it('passes through the scalar params verbatim', () => {
    const p = urlOf({
      modelUrl: 'https://cdn.example.test/a.ifc',
      theme: 'dark',
      bg: 'ff0000',
      controls: 'orbit',
      view: 'top',
    }).searchParams;
    expect(p.get('modelUrl')).toBe('https://cdn.example.test/a.ifc');
    expect(p.get('theme')).toBe('dark');
    expect(p.get('bg')).toBe('ff0000');
    expect(p.get('controls')).toBe('orbit');
    expect(p.get('view')).toBe('top');
  });

  it('encodes the boolean flags as the string "true" when set', () => {
    const p = urlOf({ hideAxis: true, hideScale: true }).searchParams;
    expect(p.get('hideAxis')).toBe('true');
    expect(p.get('hideScale')).toBe('true');
  });

  it('omits the boolean flags entirely when false (not "false")', () => {
    // Both directions: a viewer that parses `hideAxis` by presence would hide
    // the axis for every consumer who explicitly asked for it to stay.
    const p = urlOf({ hideAxis: false, hideScale: false }).searchParams;
    expect(p.has('hideAxis')).toBe(false);
    expect(p.has('hideScale')).toBe(false);
  });

  it('joins hideTypes with commas', () => {
    const p = urlOf({ hideTypes: ['IFCSPACE', 'IFCOPENINGELEMENT'] }).searchParams;
    expect(p.get('hideTypes')).toBe('IFCSPACE,IFCOPENINGELEMENT');
  });

  it('omits hideTypes for an empty array', () => {
    expect(urlOf({ hideTypes: [] }).searchParams.has('hideTypes')).toBe(false);
  });

  it('serialises camera as azimuth,elevation when zoom is absent', () => {
    const p = urlOf({ camera: { azimuth: 45, elevation: 30 } }).searchParams;
    expect(p.get('camera')).toBe('45,30');
  });

  it('appends zoom as a third camera component when present', () => {
    const p = urlOf({ camera: { azimuth: 45, elevation: 30, zoom: 2.5 } }).searchParams;
    expect(p.get('camera')).toBe('45,30,2.5');
  });

  it('keeps a zoom of 0, which is falsy but meaningful', () => {
    const p = urlOf({ camera: { azimuth: 0, elevation: 0, zoom: 0 } }).searchParams;
    expect(p.get('camera')).toBe('0,0,0');
  });

  it('never puts the auth token in the URL', () => {
    const url = urlOf({ token: 'secret-token-value' });
    expect(url.href).not.toContain('secret-token-value');
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('mounts the iframe into the container with the expected attributes', () => {
    h = mount({});
    expect(h.iframe.parentElement).toBe(h.container);
    expect(h.iframe.getAttribute('allow')).toBe('cross-origin-isolated');
    expect(h.iframe.getAttribute('loading')).toBe('eager');
    expect(h.iframe.style.cssText).toContain('border: none');
  });

  it('resolves a string container via querySelector', () => {
    const target = document.createElement('div');
    target.id = 'embed-host-under-test';
    document.body.appendChild(target);
    try {
      h = mount({ container: '#embed-host-under-test' });
      expect(target.querySelector('iframe')).toBe(h.iframe);
    } finally {
      target.remove();
    }
  });

  it('rejects with a named error when the container selector matches nothing', async () => {
    await expect(IFCLiteEmbed.create({ container: '#no-such-container' }))
      .rejects.toThrow(/Container not found: #no-such-container/);
  });
});
