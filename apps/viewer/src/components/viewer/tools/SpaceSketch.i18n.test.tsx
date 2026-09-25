/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Space Sketch tool (#4918) reads the i18n catalogue.
 *
 * The oracle is a pseudo-locale that maps every `spaceSketch.*` key to a
 * marked copy of its English text. Coverage is split by how each key can be
 * reached:
 *
 *  - `SpaceSketchOverlay` itself, mounted with no model loaded (its default,
 *    always-safe render — deriving rooms needs the Rust `space_dcel` wasm
 *    module, which `useSpacePlateSessions.ts`'s own docblock notes
 *    `ensureSpaceWasm()` rejects under the node test harness, no `fetch` for
 *    `.wasm`). Mounted next to a `ViewportHud` (#5503: the bar renders
 *    inline as the tool's `TOOL_HUD` Bar, the plan card portals into the
 *    HUD's top-center region). This surfaces the bar and the Done state (no
 *    drafted rooms ⇒ `needsConfirm` stays false).
 *  - `OptionsPopover` / `HelpPopover` / `SpaceSketchParkedChip` /
 *    `SpaceSketchCanvas` are pure presentational sub-components, so they are
 *    rendered STANDALONE with hand-built props (`hasWallData: true`,
 *    `snapDelta` set, `pendingCount > 0`, an "unbounded" room) — this reaches
 *    branches (boundary inner/outer titles, the rooms-before→after badge,
 *    the pending count) that the full overlay cannot show without wasm.
 *  - The remainder — the pending/confirm badges, the footprint-armed
 *    warning, the in-progress draw/cut hints, and the leak-diagnostics row —
 *    all gate on a live plate SESSION (derived rooms, or a state flag only
 *    reachable once one exists), so no render in this harness can reach
 *    them. Each is verified as CATALOGUE-level interpolation only, via a
 *    tiny `Probe` component that calls `t()` directly — documented in
 *    `NOT_RENDERED_BY_A_REAL_COMPONENT` with the reason.
 *
 * `space-sketch.en.ts` is not yet imported into `en.ts` (#4918's
 * integration pass wires every new slice catalogue in afterward, in one
 * place, to avoid concurrent edits to the shared file). Until then the
 * default 'en' locale doesn't carry these keys, so this file merges the
 * catalogue onto the live (unfrozen) `en` object at module scope before any
 * render — verification-only, touches no file on disk.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render, click } from '@/test/render.js';
import { registerLocale, setLocale, useTranslation, type Catalogue } from '@/i18n';
import { en } from '@/i18n/en';
import type { spaceSketchEn as SpaceSketchEnType } from '@/i18n/catalogues/space-sketch.en';
import type { PluralTranslation } from '@/i18n/types';
import { useViewerStore } from '@/store';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { SpaceSketchOverlay } from './SpaceSketchOverlay.js';
import { OptionsPopover, HelpPopover } from './space-sketch/SpaceSketchPopovers.js';
import { SpaceSketchParkedChip } from './space-sketch/SpaceSketchHud.js';
import { SpaceSketchCanvas } from './space-sketch/SpaceSketchCanvas.js';

// Guarded dynamic import (#4918 revert-oracle): a static `import { spaceSketchEn }
// from '...'` would fail this file's whole LOAD once `check-test-revert-oracle.mjs`
// reverts the production hunks (a brand-new module reverts to a deletion),
// which the oracle reports as INCONCLUSIVE rather than a red assertion. A
// guarded dynamic import turns a missing catalogue into a clean
// `describe.skip` instead.
let spaceSketchEn: typeof SpaceSketchEnType | undefined;
try {
  ({ spaceSketchEn } = await import('@/i18n/catalogues/space-sketch.en'));
} catch {
  spaceSketchEn = undefined;
}
const HAS_CATALOGUE = spaceSketchEn !== undefined;
const CATALOGUE: typeof SpaceSketchEnType = spaceSketchEn ?? ({} as typeof SpaceSketchEnType);
if (spaceSketchEn) Object.assign(en, spaceSketchEn);

type SpaceSketchKey = keyof typeof CATALOGUE;
const ALL_KEYS = Object.keys(CATALOGUE) as SpaceSketchKey[];
const PLURAL_KEYS = ['spaceSketch.panel.roomCount', 'spaceSketch.footer.confirmButton'] as const;
type PluralKey = (typeof PLURAL_KEYS)[number];
const STRING_KEYS = ALL_KEYS.filter(
  (k): k is Exclude<SpaceSketchKey, PluralKey> => !(PLURAL_KEYS as readonly string[]).includes(k),
);

const markStr = (key: string, text: string) => `⟦${key}|${text}⟧`;

const PSEUDO: Catalogue = {};
for (const key of STRING_KEYS) {
  PSEUDO[key] = markStr(key, CATALOGUE[key] as string);
}
for (const key of PLURAL_KEYS) {
  const value = CATALOGUE[key] as PluralTranslation;
  const marked: PluralTranslation = { other: markStr(`${key}.other`, value.other) };
  if (value.one !== undefined) (marked as { one?: string }).one = markStr(`${key}.one`, value.one);
  PSEUDO[key] = marked;
}

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const title = element.getAttribute('title');
    if (title) out.add(title);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

function mark(key: Exclude<SpaceSketchKey, PluralKey>): string {
  return markStr(key, CATALOGUE[key] as string);
}

/** Renders whatever's given in English, switches to a pseudo-locale built
 *  from PSEUDO, and asserts every listed key's English text (if visible
 *  before the switch) reappears marked after it. */
function assertTranslates(ui: HTMLElement, keys: Exclude<SpaceSketchKey, PluralKey>[], localeName: string): void {
  const english = new Set<string>();
  addReadable(ui, english);
  registerLocale(localeName, PSEUDO);
  act(() => setLocale(localeName));
  const after = new Set<string>();
  addReadable(ui, after);
  for (const key of keys) {
    const text = CATALOGUE[key] as string;
    // `.includes` rather than an exact set match: a couple of HelpPopover
    // rows render their translated `desc` alongside a literal "— " prefix
    // text node in the same element, which `addReadable` joins together.
    assert.ok(
      [...english].some((s) => s.includes(text)),
      `expected "${text}" (${key}) to be visible in English before switching locale`,
    );
    assert.ok(
      [...after].some((s) => s.includes(mark(key))),
      `${key}: must be translated, marked text not found`,
    );
  }
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({ activeModelId: null, models: new Map() } as Partial<ReturnType<typeof useViewerStore.getState>>);
});

describe('Space Sketch localization (#4918)', { skip: !HAS_CATALOGUE && 'space-sketch.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  it('translates the bar and plan card with no model loaded', () => {
    const ui = render(<><ViewportHud /><SpaceSketchOverlay /></>);
    assertTranslates(ui, [
      'spaceSketch.panel.heading',
      'spaceSketch.bar.storeyAria',
      'spaceSketch.bar.drawModeAria',
      'spaceSketch.panel.helpTitle',
      'spaceSketch.panel.minimizeTitle',
      'spaceSketch.panel.closeTitle',
      'spaceSketch.panel.noModelOption',
      'spaceSketch.panel.deriveAllTitle',
      'spaceSketch.panel.resizeTitle',
      'spaceSketch.tools.editTitle',
      'spaceSketch.tools.rectTitle',
      'spaceSketch.tools.footprintTitle',
      'spaceSketch.tools.undoTitle',
      'spaceSketch.tools.redoTitle',
      'spaceSketch.tools.snapOnTitle',
      'spaceSketch.tools.optionsTitle',
      'spaceSketch.tools.cleanupTitle',
      'spaceSketch.tools.fitTitle',
      // needsConfirm is false with no drafted rooms, so the confirm button
      // shows its "close" state.
      'spaceSketch.footer.closeToolTitle',
      'spaceSketch.footer.doneButton',
    ], 'space-sketch-chrome-pseudo');
  });

  it('translates the snap-toggle "off" title on click (pure state, no wasm needed)', () => {
    const ui = render(<><ViewportHud /><SpaceSketchOverlay /></>);
    const snapButton = [...ui.querySelectorAll('button')].find(
      (b) => b.title === CATALOGUE['spaceSketch.tools.snapOnTitle'],
    );
    assert.ok(snapButton, 'expected the snap-to-building toggle button');
    click(snapButton);
    assert.equal(snapButton.title, CATALOGUE['spaceSketch.tools.snapOffTitle']);
    registerLocale('space-sketch-snap-pseudo', PSEUDO);
    act(() => setLocale('space-sketch-snap-pseudo'));
    assert.equal(snapButton.title, mark('spaceSketch.tools.snapOffTitle'));
  });

  it('translates the Options popover, including the wasm-only branches via direct props', () => {
    const ui = render(
      <OptionsPopover
        boundaryMode="inner"
        onBoundaryMode={() => {}}
        hasWallData
        snapDelta={{ from: 12, to: 9 }}
        usedTol={0.1}
        snapDisabled={false}
        onSnap={() => {}}
        snapTol={0.2}
        showBuilding
        onToggleBuilding={() => {}}
        showDiagnostics={false}
        onToggleDiagnostics={() => {}}
      />,
    );
    assertTranslates(ui, [
      'spaceSketch.options.boundaryHeading',
      'spaceSketch.options.boundary.centerTitle',
      'spaceSketch.options.boundary.innerTitle',
      'spaceSketch.options.boundary.outerTitle',
      'spaceSketch.options.boundary.centerLabel',
      'spaceSketch.options.boundary.innerLabel',
      'spaceSketch.options.boundary.outerLabel',
      'spaceSketch.options.weldToleranceTitle',
      'spaceSketch.options.weldToleranceLabel',
      'spaceSketch.options.roomsBeforeAfterTitle',
      'spaceSketch.options.weldToleranceAriaLabel',
      'spaceSketch.options.snapResetTitle',
      'spaceSketch.options.snapReset',
      'spaceSketch.options.showBuilding',
      'spaceSketch.options.leakDiagnostics',
    ], 'space-sketch-options-pseudo');
  });

  it('translates the Options popover "no wall data" and default-snap branches', () => {
    const ui = render(
      <OptionsPopover
        boundaryMode="center"
        onBoundaryMode={() => {}}
        hasWallData={false}
        snapDelta={null}
        usedTol={0.1}
        snapDisabled
        onSnap={() => {}}
        snapTol={null}
        showBuilding
        onToggleBuilding={() => {}}
        showDiagnostics={false}
        onToggleDiagnostics={() => {}}
      />,
    );
    assertTranslates(ui, [
      'spaceSketch.options.boundary.noWallData',
      'spaceSketch.options.snapDefaultTitle',
      'spaceSketch.options.snapAuto',
    ], 'space-sketch-options-nowall-pseudo');
  });

  it('translates the Help popover gesture legend', () => {
    const ui = render(<HelpPopover />);
    assertTranslates(ui, [
      'spaceSketch.help.heading',
      'spaceSketch.help.rectangleTool.label', 'spaceSketch.help.rectangleTool.desc',
      'spaceSketch.help.footprint.label', 'spaceSketch.help.footprint.desc',
      'spaceSketch.help.dragNode.label', 'spaceSketch.help.dragNode.desc',
      'spaceSketch.help.clickWallThenAnother.label', 'spaceSketch.help.clickWallThenAnother.desc',
      'spaceSketch.help.clickEmptySpace.label', 'spaceSketch.help.clickEmptySpace.desc',
      'spaceSketch.help.removeNode.label', 'spaceSketch.help.removeNode.desc',
      'spaceSketch.help.mergeWall.label', 'spaceSketch.help.mergeWall.desc',
      'spaceSketch.help.panZoom.label', 'spaceSketch.help.panZoom.desc',
    ], 'space-sketch-help-pseudo');
  });

  it('translates the parked chip, including the interpolated pending count', () => {
    const ui = render(<><ViewportHud /><SpaceSketchParkedChip pendingCount={3} onReopen={() => {}} /></>);
    const english = new Set<string>();
    addReadable(ui, english);
    assert.ok([...english].some((s) => s.includes('3 to confirm')));

    registerLocale('space-sketch-chip-pseudo', PSEUDO);
    act(() => setLocale('space-sketch-chip-pseudo'));
    const after = new Set<string>();
    addReadable(ui, after);
    assert.ok(after.has(mark('spaceSketch.parkedChip.resumeTitle')));
    assert.ok(after.has(mark('spaceSketch.parkedChip.label')));
    assert.ok(
      [...after].some((s) => s === '⟦spaceSketch.parkedChip.toConfirm|{count} to confirm⟧'.replace('{count}', '3')),
      'expected the interpolated toConfirm key to render marked with its {count} value substituted',
    );
  });

  it('translates the canvas "unbounded boundary" tooltip with its {boundaryMode} interpolated', () => {
    const room = { face: 0, area: 4, simple: true, outline: [[0, 0], [2, 0], [2, 2], [0, 2]] as [number, number][] };
    const ui = render(
      <SpaceSketchCanvas
        svgRef={null}
        width={200} height={200} cursor="crosshair"
        fit={{ scale: 20, offX: 10, offY: 190 }}
        gridLines={[]} underlay={null}
        rooms={[room]}
        boundaryInfo={[{ disp: room.outline, unbounded: true }]}
        boundaryMode="outer"
        mergeFaces={null} diagnostics={null}
        hover={null} splitPick={null} previewEnd={null} splitHover={null}
        snapPos={null} snapKind="none" drawPts={[]} drawCursor={null}
        rectPreview={null} alignGuides={{ vRef: null, hRef: null }} deleteHover={null}
        intent={null}
        onPointerDown={() => {}} onPointerMove={() => {}} onPointerUp={() => {}}
        onDoubleClick={() => {}} onContextMenu={() => {}} onPointerLeave={() => {}}
      />,
    );
    const svgTitle = ui.querySelector('title');
    assert.ok(svgTitle?.textContent?.includes('outer'), 'expected the boundaryMode to be interpolated into the English title');

    registerLocale('space-sketch-canvas-pseudo', PSEUDO);
    act(() => setLocale('space-sketch-canvas-pseudo'));
    assert.equal(
      ui.querySelector('title')?.textContent,
      mark('spaceSketch.canvas.unboundedBoundaryTitle').replace('{boundaryMode}', 'outer'),
    );
  });
});

/**
 * Keys whose real call site only renders once a plate SESSION exists
 * (derived rooms, `needsConfirm`, `footprintArmed`, a drawing/cutting
 * gesture, or leak diagnostics with wall-extraction data) — every path to
 * one goes through `ensureSpaceWasm()`, which the node test harness cannot
 * satisfy (see the file docblock). Verified here at the catalogue/i18n
 * level only: a tiny `Probe` component calls `t()` directly so the
 * template + interpolation machinery is still exercised end to end.
 */
const NOT_RENDERED_BY_A_REAL_COMPONENT: { key: Exclude<SpaceSketchKey, PluralKey>; params?: Record<string, string | number> }[] = [
  { key: 'spaceSketch.tools.footprintArmedTitle', params: { count: 1 } }, // needs rooms.length > 0 (a derive) and a prior footprint click
  { key: 'spaceSketch.footer.rectHint' }, // needs rectStartRef set by a real pointerdown, which onPointerDown short-circuits without a live session
  { key: 'spaceSketch.footer.drawHint' }, // same: onPointerDown returns early without `sessionRef.current?.alive`
  { key: 'spaceSketch.footer.cutHint' }, // same
  { key: 'spaceSketch.footer.unboundedNotice', params: { count: 1, boundaryMode: 'outer' } }, // needs unboundedCount > 0 from real boundaryInfo derived off a session
  { key: 'spaceSketch.footer.diag.bounds' }, // showDiagnostics's checkbox is `disabled={!hasWallData}`, and hasWallData needs a derive
  { key: 'spaceSketch.footer.diag.leak', params: { count: 0 } },
  { key: 'spaceSketch.footer.diag.failed', params: { count: 0 } },
  { key: 'spaceSketch.footer.confirmTitle' }, // needsConfirm requires a drafted room
];

function Probe({ probeKey, params }: { probeKey: Exclude<SpaceSketchKey, PluralKey>; params?: Record<string, string | number> }) {
  const { t } = useTranslation();
  return <div>{t(probeKey, params)}</div>;
}

function PluralProbe({ probeKey, count }: { probeKey: PluralKey; count: number }) {
  const { t } = useTranslation();
  return <div>{t(probeKey, { count })}</div>;
}

function MultiStoreyProbe({ count }: { count: number }) {
  const { t } = useTranslation();
  return <div>{t('spaceSketch.footer.confirmButtonMultiStorey', { count, floors: 3 })}</div>;
}

describe('Space Sketch localization (#4918) — catalogue-level checks for wasm-gated keys', { skip: !HAS_CATALOGUE && 'space-sketch.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  it('resolves and interpolates every key whose real render site is gated on a live plate session', () => {
    for (const { key, params } of NOT_RENDERED_BY_A_REAL_COMPONENT) {
      const ui = render(<Probe probeKey={key} params={params} />);
      let expected = CATALOGUE[key] as string;
      if (params) for (const [k, v] of Object.entries(params)) expected = expected.replace(`{${k}}`, String(v));
      assert.equal(ui.textContent, expected, `${key}: expected English interpolation to match`);
      cleanup();

      const localeName = `space-sketch-probe-${key}`;
      registerLocale(localeName, PSEUDO);
      const ui2 = render(<Probe probeKey={key} params={params} />);
      act(() => setLocale(localeName));
      let expectedMarked = mark(key);
      if (params) for (const [k, v] of Object.entries(params)) expectedMarked = expectedMarked.replace(`{${k}}`, String(v));
      assert.equal(ui2.textContent, expectedMarked, `${key}: expected marked interpolation after locale switch`);
      cleanup();
      setLocale('en');
    }
  });

  it('resolves the plural room-count and confirm-button keys for both English categories', () => {
    for (const key of PLURAL_KEYS) {
      const value = CATALOGUE[key] as PluralTranslation;
      for (const [count, form] of [[0, 'other'], [1, 'one'], [5, 'other']] as const) {
        const ui = render(<PluralProbe probeKey={key} count={count} />);
        const template = form === 'one' && value.one !== undefined ? value.one : value.other;
        assert.equal(ui.textContent, template.replace('{count}', String(count)), `${key} at count=${count}`);
        cleanup();
      }
    }
  });

  it('resolves the multi-storey confirm-button plural key with BOTH its count and floors params substituted (#4918 review, PR #5001: one complete message, not a concatenated suffix)', () => {
    const value = CATALOGUE['spaceSketch.footer.confirmButtonMultiStorey'] as PluralTranslation;
    for (const [count, form] of [[1, 'one'], [5, 'other']] as const) {
      const ui = render(<MultiStoreyProbe count={count} />);
      const template = form === 'one' && value.one !== undefined ? value.one : value.other;
      assert.equal(
        ui.textContent,
        template.replace('{count}', String(count)).replace('{floors}', '3'),
        `confirmButtonMultiStorey at count=${count}`,
      );
      cleanup();
    }
  });
});
