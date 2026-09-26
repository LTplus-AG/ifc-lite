/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measures the REAL WCAG contrast ratio of the panel secondary-text sites
 * fixed under #4792 (the tooltip-survey follow-up to #4788/#4783), against
 * each site's REAL surface, in light, dark and `.colorful` — the same real
 * headless-Chromium measurement `tooltip-secondary-text.test.ts` uses for
 * the popover-tooltip surface, generalized via `render-harness.ts`'s
 * `measureTextContrastOnSurface(theme, surfaceClass, textClass)` to the
 * non-tooltip surfaces (`bg-background`, `bg-popover`, and
 * `PropertiesPanel`'s literal `bg-white dark:bg-black`) these sites
 * actually sit on.
 *
 * #4792's survey measured every distinct `text-muted-foreground/NN` opacity
 * tier against the app's neutral panel surfaces and found every low-opacity
 * tier fails AA normal-text (4.5:1) in at least one shipped theme, while the
 * plain (no-opacity) `text-muted-foreground` clears it everywhere with
 * margin (survey's "Clean" section: 4.83:1 light / 5.42:1 dark / 5.76-6.66:1
 * colorful on `bg-background`/`bg-card`/`bg-popover`). The fix applied here
 * follows that same pattern already used for BsddCard's dataType line
 * (#4788/#4784): drop the opacity suffix rather than invent a new color.
 *
 * Each site's className is pulled from the component's SOURCE
 * (`extract-classname.ts`), not hardcoded here, so a future edit that
 * reintroduces a low-opacity tier is what turns this test red.
 *
 * Each className appears once per file even where the same component
 * renders it at several call sites (e.g. `MeasureQuantities.tsx`'s
 * quantity-row label is the same class repeated across many rows) — a WCAG
 * ratio for a given `(surfaceClass, textClass, theme)` triple is a pure
 * function of those three inputs, so measuring one representative
 * occurrence of a given className covers every other occurrence of that
 * exact className.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CountBadge, LISTED_STATES } from '../../components/viewer/compare/CompareResultsList';
import { measureTextContrastOnSurface, measureRenderedTextContrastOnSurface, closeContrastBrowser, type Theme } from './render-harness';
import { extractClassNameAfter, extractFirstStringLiteralAfter } from './extract-classname';
import { WCAG_AA_NORMAL_TEXT } from './wcag';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = join(__dirname, '../../components/viewer');
const CHAT_PANEL = join(VIEWER_DIR, 'ChatPanel.tsx');
const PROPERTIES_PANEL = join(VIEWER_DIR, 'PropertiesPanel.tsx');
const CLASH_PANEL = join(VIEWER_DIR, 'ClashPanel.tsx');
const TOUR_STEP_CARD = join(__dirname, '../../components/tours/TourStepCard.tsx');
const HOVER_TOOLTIP = join(VIEWER_DIR, 'HoverTooltip.tsx');
const MEASURE_GEO_READOUT = join(VIEWER_DIR, 'tools/MeasureHudReadouts.tsx');
const MEASURE_QUANTITIES = join(VIEWER_DIR, 'tools/MeasureQuantities.tsx');
const MEASURE_POINT_READOUT = join(VIEWER_DIR, 'tools/MeasurePointReadout.tsx');

// #4792's follow-up survey pass (the eleven files it named but did not
// individually verify): each of these is real, always-visible, always-enabled
// text — not an icon, not `aria-hidden`, not disabled-control styling —
// confirmed by reading the surrounding JSX before adding it here.
const CHUNK_ERROR_BOUNDARY = join(__dirname, '../../components/ChunkErrorBoundary.tsx');
const IDS_AUDIT_SUMMARY = join(VIEWER_DIR, 'IDSAuditSummary.tsx');
const ENTITY_CONTEXT_MENU = join(VIEWER_DIR, 'EntityContextMenu.tsx');
const ROOM_PANEL = join(VIEWER_DIR, 'RoomPanel.tsx');
const CUSTOMIZE_SIDEBAR = join(VIEWER_DIR, 'sidebar/CustomizeSidebar.tsx');
const SECTION_TOOLBAR = join(VIEWER_DIR, 'tools/SectionToolbar.tsx');
const RIBBON_PRIMITIVES = join(VIEWER_DIR, 'ribbon/primitives.tsx');
const CHANGE_DETAIL_VIEW = join(VIEWER_DIR, 'compare/ChangeDetailView.tsx');
const LAYERS_PANEL = join(VIEWER_DIR, 'layers/LayersPanel.tsx');

// Post-merge audit of #4792/#4794 (this file's own remaining `/NN` grep
// hits): ChatPanel's empty-state hint was outside both changesets' scope,
// not a botched merge — the survey never measured it. Fixed here, plus the
// other real always-visible text sites the same grep turned up that were
// still unverified. Icon colors, `aria-hidden` decorations and
// `disabled`-control dimming are exempt from WCAG's text-contrast rule and
// are deliberately excluded (see the sibling-sweep report, not repeated in
// this file).
const LEARN_TAB = join(__dirname, '../../components/tours/LearnTab.tsx');
const BULK_PROPERTY_EDITOR = join(VIEWER_DIR, 'BulkPropertyEditor.tsx');
const BYOK_KEY_MODAL = join(VIEWER_DIR, 'chat/ByokKeyModal.tsx');
const MODEL_SELECTOR = join(VIEWER_DIR, 'chat/ModelSelector.tsx');
const CLASS_VISIBILITY_MENU = join(VIEWER_DIR, 'toolbar/ClassVisibilityMenu.tsx');
const GEO_READOUT = join(VIEWER_DIR, 'tools/measure-modes/geo-readout.tsx');

/** `KeyboardShortcutsDialog`'s panel — a hand-rolled overlay (not the
 *  `Dialog`/`DialogContent` primitive), literal `bg-card` on its outer
 *  `<div>` (see the component's `return`, not `PROPERTIES_PANEL_SURFACE`
 *  or `bg-background`). `LearnTab` renders as one of its tabs. */
const KEYBOARD_SHORTCUTS_DIALOG_SURFACE = 'bg-card';

/** `PropertiesPanel`'s panel background — a literal `bg-white dark:bg-black`,
 *  not the `bg-background`/`bg-card` semantic tokens the rest of the viewer
 *  uses (see the panel's outer `<div>`, e.g. around its `ScrollArea`). No
 *  `.colorful`-specific override exists, so colorful renders the same
 *  `bg-white` as light. */
const PROPERTIES_PANEL_SURFACE = 'bg-white dark:bg-black';

/** `RibbonToolbar`'s outer wrapper (`apps/viewer/src/components/viewer/ribbon/RibbonToolbar.tsx`,
 *  the always-present ancestor of every `RibbonGroup`) — a literal
 *  `border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black`,
 *  not the `bg-background` semantic token. This matters in two themes:
 *  `.dark .bg-background` resolves to `var(--tokyo-night)` (`#16161e`), not
 *  the real surface's literal `#000`; and `.colorful` has a selector keyed
 *  specifically on `.border-b.bg-white` (`apps/viewer/src/index.css`) that
 *  tints it violet-glass, which the generic `.bg-background` rule (resolving
 *  to `var(--cf-glass)`) does not match. `border-b` is included here so the
 *  colorful selector actually applies. */
const RIBBON_TOOLBAR_SURFACE = 'border-b bg-white dark:bg-black';

const THEMES: Theme[] = ['light', 'dark', 'colorful'];

after(async () => {
  await closeContrastBrowser();
});

describe('panel secondary text meets WCAG AA on its real surface (#4792)', () => {
  const fixedCases: Array<{
    name: string;
    file: string;
    anchor: string;
    surface: string;
    extractor?: (file: string, anchor: string) => string;
    backdrop?: string;
  }> = [
    {
      name: 'ChatPanel "Streaming..." status',
      file: CHAT_PANEL,
      anchor: 'flex items-center justify-between mt-1 px-0.5">\n          {isActive ? (\n            <span ',
      surface: 'bg-background',
    },
    {
      name: 'ChatPanel usage percentage readout',
      file: CHAT_PANEL,
      anchor: '        />\n                  </div>\n                  <span ',
      surface: 'bg-background',
    },
    {
      name: 'ChatPanel "Shift+Enter new line" hint',
      file: CHAT_PANEL,
      anchor: 't>\n            </Tooltip>\n          ) : (\n            <span ',
      surface: 'bg-background',
    },
    {
      name: 'ChatPanel "⌘L" shortcut hint',
      file: CHAT_PANEL,
      // Localized (#4918 chat slice): the hint's own text moved into
      // `t('chat.panel.shiftEnterHint')`, so the anchor keys off that call
      // instead of the English literal it used to inline.
      anchor: "shiftEnterHint')}</span>\n          )}\n          <span ",
      surface: 'bg-background',
    },
    {
      name: 'PropertiesPanel "Size" label',
      file: PROPERTIES_PANEL,
      anchor: ' <div className="flex items-start gap-1.5">\n                    <span ',
      surface: PROPERTIES_PANEL_SURFACE,
    },
    {
      name: 'PropertiesPanel "Size" value',
      file: PROPERTIES_PANEL,
      anchor: "-wider w-[34px] shrink-0 pt-px\">{t('properties.panel.sizeLabel')}</span>\n                    <span ",
      surface: PROPERTIES_PANEL_SURFACE,
    },
    {
      name: 'ClashPanel active detection-mode label',
      file: CLASH_PANEL,
      anchor: "5 w-3.5\" />}\n              <span>{t('clashPanel.detectionSectionLabel')}</span>\n              <span ",
      surface: 'bg-background',
    },
    {
      name: 'TourStepCard "docked back" notice',
      file: TOUR_STEP_CARD,
      anchor: 'ted-foreground">{step.body}</p>\n\n      {redockedPanel && (\n        <p ',
      surface: 'bg-popover',
    },
    {
      name: 'TourStepCard "Stuck? Skip" hint',
      file: TOUR_STEP_CARD,
      anchor: '        </p>\n      )}\n      {hintVisible && !showNext && (\n        <p ',
      surface: 'bg-popover',
    },
    {
      name: 'TourStepCard step-count readout',
      file: TOUR_STEP_CARD,
      anchor: 'assName="mt-3 flex items-center justify-between gap-2">\n        <span ',
      surface: 'bg-popover',
    },
    {
      name: 'HoverTooltip world-coordinate readout',
      file: HOVER_TOOLTIP,
      anchor: 'e.entityId}\n      </div>\n      {hoverState.worldXYZ && (\n        <div ',
      surface: 'bg-popover',
    },
    {
      name: 'MeasureGeoReadout projected-CRS name',
      file: MEASURE_GEO_READOUT,
      anchor: "{t('measure.geo.unitMeters')}</span>\n          </span>\n        </div>\n        <div ",
      // The geo readout sits on the shared HUD card (`HudSurface`:
      // `bg-popover/[.94] backdrop-blur-md`, #5502) over the live 3D
      // viewport; measured on the opaque `bg-popover` proxy like the other
      // HUD/popover sites here.
      surface: 'bg-popover',
    },
    {
      name: 'MeasureQuantities row label',
      file: MEASURE_QUANTITIES,
      anchor: "e-nowrap\"\n              title={r.provenance.join('\\n')}\n            >\n              <span ",
      surface: 'bg-background',
    },
    {
      name: 'MeasureQuantities net/gross/mesh footnote',
      file: MEASURE_QUANTITIES,
      anchor: 'be compared\n          instead of quietly differing. */}\n      {!nothing && (\n        <div ',
      surface: 'bg-background',
    },
    {
      name: 'MeasurePointReadout coordinate-row label',
      file: MEASURE_POINT_READOUT,
      anchor: '\n  return (\n    <div className="flex items-baseline gap-2 whitespace-nowrap">\n      <span ',
      surface: 'bg-background',
    },
    {
      name: 'MeasurePointReadout rebased-frame notice',
      file: MEASURE_POINT_READOUT,
      anchor: "oFixed(6)}`}\n          />\n        )}\n      </div>\n\n      {frame.rebased && (\n        <div ",
      surface: 'bg-background',
    },
    {
      name: 'MeasurePointReadout projected-CRS readout',
      file: MEASURE_POINT_READOUT,
      anchor: "          })}\n        </div>\n      )}\n\n      {enh && anchor && (\n        <div ",
      surface: 'bg-background',
    },
    // #4792 follow-up (files the original PR named but did not verify):
    {
      name: 'ChunkErrorBoundary panel-tone error detail',
      file: CHUNK_ERROR_BOUNDARY,
      anchor: "className={night ? 'max-w-[280px] text-[11px]' : ",
      surface: 'bg-background',
      extractor: extractFirstStringLiteralAfter,
    },
    {
      name: 'IDSAuditSummary "path" label',
      file: IDS_AUDIT_SUMMARY,
      anchor: '{issue.path && (\n                <div className="flex gap-2 font-mono text-[11px]">\n                  <span ',
      surface: 'bg-card',
    },
    {
      name: 'IDSAuditSummary "facet" label',
      file: IDS_AUDIT_SUMMARY,
      anchor: '{issue.facetType && (\n                <div className="flex gap-2 font-mono text-[11px]">\n                  <span ',
      surface: 'bg-card',
    },
    {
      name: 'IDSAuditSummary detail key label',
      file: IDS_AUDIT_SUMMARY,
      anchor: '<div key={k} className="flex gap-2">\n                      <span ',
      surface: 'bg-card',
    },
    {
      name: 'EntityContextMenu "⌘D" duplicate shortcut',
      file: ENTITY_CONTEXT_MENU,
      anchor: "<span>{t('entityContextMenu.duplicateLabel')}</span>\n        <span ",
      surface: 'bg-popover',
    },
    {
      name: 'EntityContextMenu row shortcut hint',
      file: ENTITY_CONTEXT_MENU,
      anchor: '{shortcut && (\n        <span ',
      surface: 'bg-popover',
    },
    {
      name: 'RoomPanel "Got an invite?" hint',
      file: ROOM_PANEL,
      anchor: "{t('zonesPanel.roomPanel.createRoomButton')}\n        </Button>\n        <p ",
      surface: 'bg-background',
    },
    {
      name: 'CustomizeSidebar "Hidden" section header',
      file: CUSTOMIZE_SIDEBAR,
      anchor: '{hiddenList.length > 0 && (\n          <>\n            <div ',
      surface: 'bg-popover',
    },
    {
      name: 'SectionToolbar heading caption',
      file: SECTION_TOOLBAR,
      anchor: '2D + close — never inside one. */}\n      <span className={GROUP}>\n        <span ',
      // The caption replaced the Section panel's axis prompt (#5991) and sits
      // on the HUD toolbar (`HudSurface`); measured on the opaque `bg-popover`
      // proxy like the other HUD sites here.
      surface: 'bg-popover',
    },
    {
      name: 'ribbon/primitives RibbonGroup label',
      file: RIBBON_PRIMITIVES,
      anchor: "aria-label={label} className={cn('flex h-full shrink-0 flex-col px-1.5', className)}>\n      <div className=\"flex min-h-0 flex-1 items-stretch justify-center gap-0.5 pt-1\">\n        {children}\n      </div>\n      <div ",
      surface: RIBBON_TOOLBAR_SURFACE,
    },
    {
      name: 'compare/ChangeDetailView data-count parenthetical',
      file: CHANGE_DETAIL_VIEW,
      anchor: "{t('comparePanel.changeDetail.dataLabel')} <span ",
      surface: 'bg-background',
    },
    {
      name: 'compare/ChangeDetailView moved-delta detail',
      file: CHANGE_DETAIL_VIEW,
      anchor: "{moved && (\n        <div ",
      surface: 'bg-background',
    },
    {
      name: 'compare/ChangeDetailView reshaped-delta detail',
      file: CHANGE_DETAIL_VIEW,
      anchor: "{summary.reshaped && (\n        <div ",
      surface: 'bg-background',
    },
    {
      name: 'compare/ChangeDetailView "shape hash differs" notice',
      file: CHANGE_DETAIL_VIEW,
      anchor: '{!moved && !summary.reshaped && (\n        <div ',
      surface: 'bg-background',
    },
    {
      name: 'compare/ChangeDetailView before/after arrow',
      file: CHANGE_DETAIL_VIEW,
      anchor: "<span className=\"text-muted-foreground line-through truncate max-w-[45%]\">{delta.before ?? '—'}</span>\n        <span ",
      surface: 'bg-background',
    },
    {
      name: 'LayersPanel "drop .ifcx files anywhere" hint',
      file: LAYERS_PANEL,
      anchor: '/>\n          </div>\n          <p ',
      surface: 'bg-background',
    },
    // Post-merge audit follow-up (this file's own `/NN` grep, not #4792's):
    {
      name: 'ChatPanel empty-state "Try something:" hint',
      file: CHAT_PANEL,
      anchor: '{/* Empty state */}\n        {messages.length === 0 && !streamingContent && (\n          <div className="flex flex-col justify-end h-full px-3 pb-2">\n            <p ',
      surface: 'bg-background',
    },
    {
      name: 'LearnTab "X min" readout',
      file: LEARN_TAB,
      anchor: 'text-xs text-muted-foreground">{tour.description}</div>\n              </div>\n              <span ',
      surface: KEYBOARD_SHORTCUTS_DIALOG_SURFACE,
    },
    {
      name: 'BulkPropertyEditor "(N found)" annotation',
      file: BULK_PROPERTY_EDITOR,
      anchor: "{t('bulkPropertyEditor.propertySet')}\n                    {psetOptions.length > 0 && (\n                      <span ",
      surface: 'bg-background',
    },
    {
      name: 'ByokKeyModal pricing hint',
      file: BYOK_KEY_MODAL,
      anchor: '            </ol>\n            <p ',
      surface: 'bg-background',
    },
    {
      name: 'ModelSelector contextWindow readout',
      file: MODEL_SELECTOR,
      anchor: '<span>{m.name}</span>\n                  <span className="text-muted-foreground text-[10px]">{m.provider}</span>\n                  <span ',
      surface: 'bg-popover',
    },
    {
      name: 'ClassVisibilityMenu visible/total count',
      file: CLASS_VISIBILITY_MENU,
      anchor: '<div className="flex items-center gap-1">\n          <span ',
      surface: 'bg-popover',
    },
    {
      name: 'MeasurePointReadout CoordRow hint',
      file: MEASURE_POINT_READOUT,
      anchor: '{hint && <span ',
      surface: 'bg-background',
    },
    {
      name: 'geo-readout EnhLine label',
      file: GEO_READOUT,
      anchor: 'text-muted-foreground whitespace-nowrap">\n      {label && <span ',
      surface: 'bg-background',
    },
  ];

  for (const { name, file, anchor, surface, extractor, backdrop } of fixedCases) {
    for (const theme of THEMES) {
      it(`${name} clears AA (${WCAG_AA_NORMAL_TEXT}:1) in ${theme} theme`, async () => {
        const className = (extractor ?? extractClassNameAfter)(file, anchor);
        const ratio = await measureTextContrastOnSurface(theme, surface, className, backdrop);
        assert.ok(
          ratio >= WCAG_AA_NORMAL_TEXT,
          `expected >= ${WCAG_AA_NORMAL_TEXT}:1, measured ${ratio.toFixed(2)}:1 for className="${className}" ` +
            `on surface="${surface}"${backdrop ? ` over backdrop="${backdrop}"` : ''} in ${theme} theme`,
        );
      });
    }
  }

  for (const theme of THEMES) {
    it(`compare/CompareResultsList CountBadge hint clears AA in ${theme} theme`, async () => {
      const hint = '4 type objects';
      const markup = renderToStaticMarkup(createElement(CountBadge, {
        label: 'Changed', value: 4, color: LISTED_STATES[0].color, hint,
      }));
      const ratio = await measureRenderedTextContrastOnSurface(
        theme, 'bg-background', markup, '#surface span:nth-of-type(3)',
      );
      assert.ok(ratio >= WCAG_AA_NORMAL_TEXT,
        `rendered CountBadge hint measured ${ratio.toFixed(2)}:1 in ${theme} theme, expected >= ${WCAG_AA_NORMAL_TEXT}:1`);
    });
  }
});

describe('non-vacuousness proof: reintroducing the old opacity tiers reddens in every theme', () => {
  // Not extracted from source — deliberately renders the OLD, pre-fix
  // classes these sites shipped before #4792, to prove the harness and
  // threshold actually catch the regression rather than passing regardless
  // of input. Do not "fix" these by extracting from source.
  const regressedCases: Array<{ name: string; surface: string; className: string }> = [
    { name: 'ChatPanel hints (pre-#4792, /30-/50 tiers)', surface: 'bg-background', className: 'text-[10px] text-muted-foreground/40' },
    { name: 'PropertiesPanel "Size" (pre-#4792, /50)', surface: PROPERTIES_PANEL_SURFACE, className: 'text-[9px] font-medium text-muted-foreground/50' },
    { name: 'ClashPanel mode label (pre-#4792, /60)', surface: 'bg-background', className: 'normal-case tracking-normal text-muted-foreground/60' },
    { name: 'TourStepCard / HoverTooltip / MeasurePanel (pre-#4792, /80)', surface: 'bg-popover', className: 'text-[11px] text-muted-foreground/80' },
    { name: 'MeasureQuantities / MeasurePointReadout (pre-#4792, /70)', surface: 'bg-background', className: 'font-mono text-[9px] leading-tight text-muted-foreground/70' },
    { name: 'ChunkErrorBoundary / IDSAuditSummary / EntityContextMenu / RoomPanel / CustomizeSidebar / ribbon-primitives / compare-panels / LayersPanel (pre-follow-up, /70)', surface: 'bg-background', className: 'text-[10px] text-muted-foreground/70' },
    { name: 'compare/ChangeDetailView before/after arrow (pre-follow-up, /60)', surface: 'bg-background', className: 'text-muted-foreground/60 shrink-0' },
    { name: 'ChatPanel empty-state hint / BulkPropertyEditor / MeasurePointReadout / geo-readout (pre-audit-fix, /60)', surface: 'bg-background', className: 'text-xs text-muted-foreground/60' },
    { name: 'LearnTab "X min" (pre-audit-fix, /70)', surface: KEYBOARD_SHORTCUTS_DIALOG_SURFACE, className: 'shrink-0 text-[11px] tabular-nums text-muted-foreground/70' },
    { name: 'ModelSelector / ClassVisibilityMenu (pre-audit-fix, /50-/80 on bg-popover)', surface: 'bg-popover', className: 'text-muted-foreground/50 text-[10px]' },
  ];

  for (const { name, surface, className } of regressedCases) {
    for (const theme of THEMES) {
      it(`${name} in ${theme} theme measures under AA (proves the harness is non-vacuous)`, async () => {
        const ratio = await measureTextContrastOnSurface(theme, surface, className);
        assert.ok(
          ratio < WCAG_AA_NORMAL_TEXT,
          `expected the pre-#4792 regression to measure below AA; got ${ratio.toFixed(2)}:1 — ` +
            `either the harness stopped measuring correctly, or the theme tokens changed enough that ` +
            `this className is no longer a valid regression fixture`,
        );
      });
    }
  }
});
