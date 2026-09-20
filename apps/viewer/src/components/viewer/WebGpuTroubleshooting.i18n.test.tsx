/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for the #4918 webgpu/script localization slice's
 * `webgpu-troubleshooting.en.ts` catalogue and its three consumers in
 * `WebGpuTroubleshooting.tsx`: `WebGpuDisabledCaption`,
 * `webGpuBannerBlurb`, and `WebGpuTroubleshootingDetails` (which also
 * renders the always-present `WebGpuFallbackNotice`).
 *
 * Same pseudo-locale-oracle shape as `PrivacyPanel.i18n.test.tsx`: a
 * pseudo-locale marks every `webgpuTroubleshooting.*` string, the three
 * `WebGPUUnavailableReason` branches are mounted (one render each, since
 * `WebGpuTroubleshootingDetails` shows only one branch per category), the
 * locale is switched live, and every marked string that was readable in
 * English must reappear marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { webgpuTroubleshootingEn } from '@/i18n/catalogues/webgpu-troubleshooting.en';
import {
  WebGpuDisabledCaption,
  WebGpuTroubleshootingDetails,
  webGpuBannerBlurb,
} from './WebGpuTroubleshooting.js';

type Key = keyof typeof webgpuTroubleshootingEn;
const ALL_KEYS = Object.keys(webgpuTroubleshootingEn) as Key[];

const mark = (key: Key) => `⟦${key}|${String(webgpuTroubleshootingEn[key])}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, mark(key)])) as Catalogue;

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('WebGpuTroubleshooting localization (#4918)', () => {
  it('renders the English catalogue by default across every category', () => {
    const insecure = render(<WebGpuTroubleshootingDetails category="insecure-context" />);
    assert.match(insecure.textContent ?? '', /Insecure Origin/);
    assert.match(insecure.textContent ?? '', /Rest Of The Toolkit/);

    const noApi = render(<WebGpuTroubleshootingDetails category="no-api" />);
    assert.match(noApi.textContent ?? '', /Browser Not Exposing WebGPU/);
    assert.match(noApi.textContent ?? '', /navigator\.gpu/);

    const noGpu = render(<WebGpuTroubleshootingDetails category="no-gpu" />);
    assert.match(noGpu.textContent ?? '', /Blocklist Override/);
    assert.match(noGpu.textContent ?? '', /Firefox/);
    assert.match(noGpu.textContent ?? '', /Safari/);
    assert.match(noGpu.textContent ?? '', /Verify Status/);
    assert.match(
      noGpu.textContent ?? '',
      /If none of the above helped, this is likely a hardware or driver limit/,
    );

    const caption = render(<WebGpuDisabledCaption />);
    assert.match(caption.textContent ?? '', /file upload disabled/);
    assert.match(caption.textContent ?? '', /CLI/);
    assert.match(caption.textContent ?? '', /MCP server/);
  });

  it('translates webGpuBannerBlurb for every category via the locale registry, not just English', () => {
    assert.match(webGpuBannerBlurb('insecure-context'), /secure connection/i);
    assert.match(webGpuBannerBlurb('no-api'), /does not expose the WebGPU API/i);
    assert.match(webGpuBannerBlurb('no-gpu'), /could not create a GPU adapter/i);
    assert.match(webGpuBannerBlurb(null), /could not create a GPU adapter/i);

    registerLocale('webgpu-banner-test', {
      'webgpuTroubleshooting.banner.insecureContext': 'CONNEXION NON SÉCURISÉE (fr)',
    } as Catalogue);
    setLocale('webgpu-banner-test');
    assert.equal(webGpuBannerBlurb('insecure-context', resolve), 'CONNEXION NON SÉCURISÉE (fr)');
    // A key the test locale did not override still falls back to English.
    assert.match(webGpuBannerBlurb('no-gpu', resolve), /could not create a GPU adapter/i);
  });

  it('lets a registered locale translate a key and falls back to English for one it omits', () => {
    registerLocale('webgpu-details-test', {
      'webgpuTroubleshooting.insecureOrigin.heading': 'ORIGINE NON SÉCURISÉE',
    } as Catalogue);
    setLocale('webgpu-details-test');
    const container = render(<WebGpuTroubleshootingDetails category="insecure-context" />);
    assert.match(container.textContent ?? '', /ORIGINE NON SÉCURISÉE/);
    // 'insecureOrigin.textStart' was not overridden: still English, not blank.
    assert.match(container.textContent ?? '', /WebGPU is only available on a secure context/);
  });

  it('translates every catalogue key rendered across the three categories and the disabled caption', () => {
    const englishRenders = [
      render(<WebGpuTroubleshootingDetails category="insecure-context" />),
      render(<WebGpuTroubleshootingDetails category="no-api" />),
      render(<WebGpuTroubleshootingDetails category="no-gpu" />),
      render(<WebGpuDisabledCaption />),
    ];
    const english = englishRenders.map((c) => c.textContent ?? '').join('\n');

    registerLocale('webgpu-pseudo', PSEUDO);
    act(() => setLocale('webgpu-pseudo'));
    const after = englishRenders.map((c) => c.textContent ?? '').join('\n');

    for (const key of ALL_KEYS) {
      const text = String(webgpuTroubleshootingEn[key]);
      if (!english.includes(text)) continue; // banner-only keys: not rendered by these components
      assert.ok(after.includes(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
    }
  });
});
