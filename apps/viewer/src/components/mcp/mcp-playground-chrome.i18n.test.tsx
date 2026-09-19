/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `/mcp/playground`'s own chrome (#4918 sweep): `McpPlayground.tsx` (the
 * shell — sidebar, sample picker, footer, inline-viewer toggle) and
 * `PlaygroundChat.tsx` (the BYOK chat panel) read `mcp-playground.en.ts`'s
 * `mcp.mcpPlayground.*` / `mcp.playgroundChat.*` keys. `PlaygroundViewer.tsx`
 * and `HeroScene.tsx` read `mcp.en.ts`'s `mcp.playgroundViewer.*` /
 * `mcp.heroScene.*` keys — covered here rather than a third test file
 * because both are tiny (one WebGL-unavailable caption each under
 * happy-dom, which has no real WebGL context).
 *
 * Same pseudo-locale oracle as `McpLanding.i18n.test.tsx`: every STATIC key
 * (no `{placeholder}`) maps to a marked copy of its English text, each
 * component is rendered in a default (no model loaded / no BYOK key) state,
 * the locale is switched live, and every marked string readable in English
 * must reappear marked.
 *
 * Each component gets its own render + its own key-prefix filter — two
 * of the four catalogues coincidentally share the English caption
 * "3D preview unavailable on this device" (`mcp.playgroundViewer.
 * webglUnavailableTitle` / `mcp.heroScene.webglUnavailable`), and mounting
 * both together in one DOM would make a text match ambiguous about which
 * key it proves; separate renders sidestep that instead of asserting on
 * source text to disambiguate.
 *
 * Left un-driven, each for a stated reason — none of these are on screen in
 * a default idle render without user interaction (loading a sample, typing,
 * streaming a reply, attaching a file, an error, BYOK key present):
 *  - `mcp.mcpPlayground.downloadsCount` / `.clear` / `.fromSource` /
 *    `.removeAriaLabel` / `.removeTitle` / `.download` — `DownloadsPanel`
 *    renders nothing until a tool produces a file.
 *  - `mcp.playgroundChat.placeholderNoKey` / `.placeholderAddNote` /
 *    `.placeholderDefault` — the composer placeholder is a ternary; with no
 *    model loaded, `.placeholderNoModel` always wins first.
 *  - `mcp.playgroundChat.manageKeyAria` / `.keySetLabel` — the key-status
 *    pill's "has a key" branch; no BYOK key is configured in this render.
 *  - `mcp.playgroundChat.composingAnswer` / `.thinking` / `.statusError` /
 *    `.statusOk` / `.argsLabel` / `.resultLabel` / `.msSuffix` /
 *    `.savedLabel` / `.try` / starter prompts — all live inside a
 *    tool-call card or the "model loaded" welcome branch; no messages and
 *    no model exist in this render.
 *  - `mcp.playgroundChat.releaseToAttach` — only shown mid drag-over.
 *  - the transient error strings (`.anthropicKeyRequired`,
 *    `.fileTooLarge`, `.failedToReadFile`, `.requestFailed`) — surfaced via
 *    `setError()` on a failed `send()` / attach, not triggered here.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { mcpPlaygroundEn } from '@/i18n/catalogues/mcp-playground.en';
import { mcpEn } from '@/i18n/catalogues/mcp.en';
import { McpPlayground } from './McpPlayground.js';
import { PlaygroundChat, ToolCallView } from './PlaygroundChat.js';
import { PlaygroundViewer } from './PlaygroundViewer.js';
import { HeroScene } from './HeroScene.js';

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

function readableStrings(): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  out.add(document.title);
  return out;
}

/** Runs the render → English capture → pseudo-locale switch → assert-marked
 *  oracle for one component, scoped to keys whose name starts with any of
 *  `prefixes`. `baseline` is the catalogue slice this component actually
 *  reads (registered under its own locale name rather than `en` — `mcp.en.ts`
 *  / `mcp-playground.en.ts` are not wired into the real `en` catalogue yet;
 *  a separate, central step integrates every #4918-sweep catalogue at once). */
function runOracle<T extends Catalogue>(
  name: string,
  baseline: T,
  prefixes: string[],
  mount: () => ReturnType<typeof render>,
  requiredKeys: Array<keyof T & string>,
): void {
  const KEYS = Object.keys(baseline) as Array<keyof T & string>;
  const STATIC_KEYS = KEYS.filter((key) => {
    const value = baseline[key];
    if (typeof value !== 'string' || value.includes('{')) return false;
    return prefixes.some((p) => (key as string).startsWith(p));
  });
  const mark = (key: keyof T & string) => `⟦${key}|${baseline[key] as string}⟧`;
  const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, mark(key)]));

  registerLocale(`${name}-en-baseline`, baseline);
  act(() => setLocale(`${name}-en-baseline`));
  mount();
  const english = readableStrings();
  for (const key of requiredKeys) {
    const value = baseline[key];
    assert.equal(typeof value, 'string', `${name}: required key ${key} must be a string`);
    assert.ok(english.has(value as string), `${name}: required key ${key} must be visible before locale switch`);
  }

  registerLocale(`${name}-pseudo`, PSEUDO);
  act(() => setLocale(`${name}-pseudo`));
  const after = readableStrings();

  let covered = 0;
  for (const key of STATIC_KEYS) {
    const text = baseline[key] as string;
    if (!english.has(text)) continue; // not on screen in this default-state render
    assert.ok(after.has(mark(key)), `${key as string}: "${text}" must be translated, marked text not found`);
    covered += 1;
  }
  assert.ok(covered > 0, `${name}: expected at least one static key to be covered, saw 0`);
}

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('mcp/playground chrome localization (#4918)', () => {
  it('McpPlayground translates its shell chrome', () => {
    runOracle('mcp-playground-shell', mcpPlaygroundEn, ['mcp.mcpPlayground.'], () => render(<McpPlayground />), [
      'mcp.mcpPlayground.documentTitle', 'mcp.mcpPlayground.title', 'mcp.mcpPlayground.backToMcp',
      'mcp.mcpPlayground.sampleModels',
    ]);
  });

  it('PlaygroundChat translates its idle-state chrome', () => {
    runOracle('playground-chat', mcpPlaygroundEn, ['mcp.playgroundChat.'], () => render(<PlaygroundChat model={null} />), [
      'mcp.playgroundChat.attachFileTitle', 'mcp.playgroundChat.placeholderNoModel',
    ]);
  });

  it('PlaygroundViewer translates its WebGL-unavailable caption', () => {
    runOracle('playground-viewer', mcpEn, ['mcp.playgroundViewer.'], () => render(<PlaygroundViewer model={null} />), [
      'mcp.playgroundViewer.webglUnavailableTitle',
    ]);
  });

  it('HeroScene translates its WebGL-unavailable caption', () => {
    runOracle('hero-scene', mcpEn, ['mcp.heroScene.'], () => render(<HeroScene step={0} />), [
      'mcp.heroScene.webglUnavailable',
    ]);
  });

  it('PlaygroundChat keeps a shown error banner reactive to a live locale switch (#4918 slice 5b review)', async () => {
    // The real bug path: attaching an oversized file sets a real error
    // banner through the actual `attachFiles` handler — not a fixture — the
    // same way playground-attach-dupes.test.tsx drives a real file input.
    const container = render(<PlaygroundChat model={null} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    assert.ok(input, 'file input must be present');

    const oversized = new File([new Uint8Array(1)], 'huge.ifc', { type: 'application/octet-stream' });
    Object.defineProperty(oversized, 'size', { value: 26 * 1024 * 1024, configurable: true });
    Object.defineProperty(input, 'files', { value: [oversized], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const english = mcpPlaygroundEn['mcp.playgroundChat.fileTooLarge'] as string;
    assert.ok(
      document.body.textContent?.includes(english.replace('{name}', 'huge.ifc')),
      'the English error banner must be showing after the oversized attach',
    );

    // Switch locale WITHOUT touching the file input again — a stored,
    // already-resolved string would leave the banner in English forever.
    registerLocale('playground-chat-error-pseudo', {
      'mcp.playgroundChat.fileTooLarge': 'MARKED {name} too large',
    });
    act(() => setLocale('playground-chat-error-pseudo'));

    assert.ok(
      document.body.textContent?.includes('MARKED huge.ifc too large'),
      'the shown error banner must retranslate live, not stay pinned to the locale active when it was set',
    );
  });

  it('keeps an existing WebGL tool result reactive to a live locale switch', () => {
    registerLocale('tool-result-en', mcpEn);
    act(() => setLocale('tool-result-en'));
    render(<ToolCallView call={{
      id: 'webgl-result', name: 'viewer_isolate', args: {}, startedAt: 0, finishedAt: 1,
      result: {
        text: mcpEn['mcp.playgroundDispatcher.webglUnavailable'] as string,
        textKey: 'mcp.playgroundDispatcher.webglUnavailable',
        hint: mcpEn['mcp.playgroundDispatcher.webglUnavailableHint'] as string,
        hintKey: 'mcp.playgroundDispatcher.webglUnavailableHint',
        structured: null, isError: true,
      },
    }} />);
    const button = document.querySelector('button');
    assert.ok(button);
    act(() => button.click());
    assert.ok(document.body.textContent?.includes(mcpEn['mcp.playgroundDispatcher.webglUnavailable'] as string));

    registerLocale('tool-result-pseudo', {
      'mcp.playgroundDispatcher.webglUnavailable': 'MARKED WebGL unavailable',
      'mcp.playgroundDispatcher.webglUnavailableHint': 'MARKED use non-viewer tools',
    });
    act(() => setLocale('tool-result-pseudo'));
    assert.ok(document.body.textContent?.includes('MARKED WebGL unavailable'));
    assert.ok(document.body.textContent?.includes('MARKED use non-viewer tools'));
  });
});
