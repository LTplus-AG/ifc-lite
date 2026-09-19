/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `McpLanding` (#4918 sweep): the `/mcp` marketing page reads the i18n
 * catalogue for its own chrome (nav, hero, install/recipes/catalog
 * sections, footer) via `mcp.en.ts`'s `mcp.mcpLanding.*` / `mcp.heroScene.*`
 * keys.
 *
 * The oracle is the same pseudo-locale pattern `MainToolbar.i18n.test.tsx`
 * and `shared-commands.i18n.test.tsx` use: every STATIC (non-interpolated)
 * key gets mapped to a marked copy of its English text, the page is
 * rendered, the install dialog and the first catalog tool row are opened
 * (the only two pieces of chrome gated behind a click), the locale is
 * switched live, and every marked string that was readable in English must
 * reappear marked. Interpolated keys (`{version}`, `{count}`, …) are not
 * exercised here — the same `resolve()`/`interpolate()` machinery every
 * other catalogue's static keys go through, and this file follows the
 * established convention of leaving parameter substitution to the i18n
 * module's own tests rather than a per-catalogue locale test.
 *
 * Left un-driven, each for a stated reason:
 *  - the "Copied" transient (`mcp.mcpLanding.copied`) — needs a working
 *    `navigator.clipboard` and a 1.4s timer; happy-dom has no clipboard, so
 *    the copy buttons stay in their default "Copy" / "Copy JSON-RPC" state.
 *  - `HeroScene`'s per-step overlay badges (`ifcTypeLabel`, `bsddWallBadge`,
 *    `psetsCount`, `schemaOnly`) — gated behind `WireframeStage`'s internal
 *    step timer (2s per step, 12 steps), not driven here.
 *  - `mcp.playgroundViewer.*` keys live in the same catalogue file but
 *    belong to a component this page never mounts; `STATIC_KEYS` excludes
 *    that namespace before the completeness assertion below.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { mcpEn } from '@/i18n/catalogues/mcp.en';
import { McpLanding } from './McpLanding.js';

type McpKey = keyof typeof mcpEn;
const KEYS = Object.keys(mcpEn) as McpKey[];
// `mcp.en.ts` also carries `mcp.playgroundViewer.*` keys for a component
// this page never mounts (`PlaygroundViewer`) — one of them happens to share
// its English text verbatim with `mcp.heroScene.webglUnavailable`
// ("3D preview unavailable on this device" — the shared caption both
// WebGL-guarded surfaces show), which would make this oracle ambiguous
// about which key's marked form a match proves. Scoped to the keys this
// page's own components (`McpLanding`, `HeroScene`) can render.
const STATIC_KEYS = KEYS.filter((key) => {
  const value = mcpEn[key];
  if (typeof value !== 'string' || value.includes('{')) return false;
  return key.startsWith('mcp.mcpLanding.') || key.startsWith('mcp.heroScene.');
});

/** Static landing-page keys deliberately unreachable in this render state.
 * Every exception is named so removing any other call site makes this test
 * red instead of silently reducing an arbitrary coverage count. */
const NOT_RENDERED_STATIC_KEYS = new Set<McpKey>([
  // Copy success needs navigator.clipboard plus the transient 1.4s timer.
  'mcp.mcpLanding.copied',
  // WireframeStage advances to these overlay steps on its 2s timer.
  'mcp.mcpLanding.bsddWallBadge',
  'mcp.mcpLanding.schemaOnly',
  // The opened first client has no deep link, so the sibling dialog branch
  // is unreachable here (the grid still covers the one-click card label).
  'mcp.mcpLanding.oneClickOrCopy',
  // Only the first catalogue row is expanded, and that tool has parameters.
  'mcp.mcpLanding.noParameters',
  // Its parameters are all optional, so the required-value marker is absent.
  'mcp.mcpLanding.yes',
]);

/** Key-specific pseudo translation; keeps every `{placeholder}` of the English text. */
const mark = (key: McpKey) => `⟦${key}|${mcpEn[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, mark(key)]));

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
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

/** Opens the install dialog for the first client card and the first catalog
 *  tool row's detail — the only two pieces of `McpLanding`'s own chrome
 *  gated behind a click rather than always mounted. */
function openInteractiveChrome(container: HTMLElement): void {
  const firstClientCard = container.querySelector('#install button');
  if (firstClientCard) click(firstClientCard);
  const firstToolRow = container.querySelector('#tools li button');
  if (firstToolRow) click(firstToolRow);
}

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('McpLanding localization (#4918)', () => {
  it('translates every static key rendered on the /mcp landing page', () => {
    // `mcp.en.ts` is not wired into `en.ts` yet — a separate, central step
    // integrates every #4918-sweep catalogue at once (avoids every parallel
    // slice racing to edit the same aggregator file). Registering the
    // catalogue's own English text under its own locale name, rather than
    // relying on the real `en` fallback, keeps this oracle independent of
    // that integration step landing first.
    registerLocale('mcp-landing-en-baseline', mcpEn as unknown as Catalogue);
    act(() => setLocale('mcp-landing-en-baseline'));
    const container = render(<McpLanding />);
    openInteractiveChrome(container);
    const english = readableStrings();

    registerLocale('mcp-landing-pseudo', PSEUDO);
    act(() => setLocale('mcp-landing-pseudo'));
    const after = readableStrings();

    for (const key of STATIC_KEYS) {
      if (NOT_RENDERED_STATIC_KEYS.has(key)) continue;
      const text = mcpEn[key] as string;
      assert.ok(
        [...english].some((candidate) => candidate.includes(text)),
        `${key}: "${text}" must be rendered in this test state or explicitly excluded`,
      );
      assert.ok(
        [...after].some((candidate) => candidate.includes(mark(key))),
        `${key}: "${text}" must be translated, marked text not found`,
      );
    }
  });
});
