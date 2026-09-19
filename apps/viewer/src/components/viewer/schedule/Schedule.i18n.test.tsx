/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * i18n oracle for the ten schedule/Gantt-panel-chrome components that share
 * the `scheduleEn` catalogue (#4918). Same shape as
 * `MainToolbar.i18n.test.tsx`: render each component in a state that
 * surfaces as much of its own text as possible, capture the visible English
 * strings (aria-labels, titles, placeholders, plain text, and — by
 * focusing each interactive element — Radix `TooltipContent` text), switch
 * to a pseudo-locale that marks every catalogue value as `⟦key|value⟧`,
 * and assert the marked text reappears for every key that was visible.
 *
 * `en.ts` itself is not touched by this slice (owned by the sweep's
 * integration pass) — `scheduleEn` is merged into the runtime `en` object
 * here (a plain mutable object at runtime; only its TS type is `as const`)
 * so `useTranslation`'s `resolve()` can find `schedule.*` keys under test.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { PluralTranslation, TranslationValue } from '@/i18n';
import { en } from '@/i18n/en';
import type { scheduleEn as ScheduleEnType } from '@/i18n/catalogues/schedule.en';
import { resolve } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import type { IfcDataStore, ScheduleTaskInfo, WorkScheduleInfo } from '@ifc-lite/parser';

import { GanttDragTooltip } from './GanttDragTooltip.js';
import { GanttWorkPlanSummary } from './GanttWorkPlanSummary.js';
import { GanttTaskTree } from './GanttTaskTree.js';
import { HeightStrategyPanel } from './HeightStrategyPanel.js';
import { GenerateAdvancedPanel } from './GenerateAdvancedPanel.js';
import { GanttEmptyState } from './GanttEmptyState.js';
import { AnimationSettingsPopover } from './AnimationSettingsPopover.js';
import { GanttToolbar } from './GanttToolbar.js';
import { GenerateScheduleDialog } from './GenerateScheduleDialog.js';
import { ScheduleSummaryLine } from './ScheduleSummaryLine.js';
import type { FlattenedTask } from './schedule-utils.js';

// Guarded dynamic import (#4918 revert-oracle): a static `import { scheduleEn }
// from '...'` would fail this file's whole LOAD once `check-test-revert-oracle.mjs`
// reverts the production hunks (a brand-new module reverts to a deletion),
// which the oracle reports as INCONCLUSIVE rather than a red assertion. A
// guarded dynamic import turns a missing catalogue into a clean
// `describe.skip` instead — the real coverage for a revert lives in the
// pre-existing GanttEmptyState.test.ts / GanttPanel.work-plan.test.tsx /
// GanttWorkPlanSummary.test.tsx, none of which import this catalogue.
let scheduleEn: typeof ScheduleEnType | undefined;
try {
  ({ scheduleEn } = await import('@/i18n/catalogues/schedule.en'));
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') scheduleEn = undefined;
  else throw error;
}
const HAS_CATALOGUE = scheduleEn !== undefined;
const CATALOGUE: typeof ScheduleEnType = scheduleEn ?? ({} as typeof ScheduleEnType);
if (scheduleEn) Object.assign(en, scheduleEn);

type ScheduleKey = keyof typeof CATALOGUE;
const KEYS = Object.keys(CATALOGUE) as ScheduleKey[];
const isPlural = (v: TranslationValue): v is PluralTranslation => typeof v !== 'string';
const STATIC_KEYS = KEYS.filter(k => !isPlural(CATALOGUE[k]) && !(CATALOGUE[k] as string).includes('{'));
const INTERP_KEYS = KEYS.filter(k => !isPlural(CATALOGUE[k]) && (CATALOGUE[k] as string).includes('{'));
const PLURAL_KEYS = KEYS.filter(k => isPlural(CATALOGUE[k]));

function markString(key: string, text: string): string {
  return `⟦${key}|${text}⟧`;
}
function markValue(key: ScheduleKey): TranslationValue {
  const v = CATALOGUE[key];
  if (typeof v === 'string') return markString(key, v);
  const marked: Record<string, string> = {};
  for (const [cat, text] of Object.entries(v)) marked[cat] = markString(key, text as string);
  return marked as PluralTranslation;
}
/** Marked text for the "other" plural category / interpolated template — what
 *  a render with a plural count != 1 or a raw template placeholder shows. */
const mark = (key: ScheduleKey): string => {
  const v = CATALOGUE[key];
  return typeof v === 'string' ? markString(key, v) : markString(key, v.other);
};
const PSEUDO: Catalogue = Object.fromEntries(KEYS.map(key => [key, markValue(key)]));

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach(element => {
    const aria = element.getAttribute('aria-label');
    if (aria) out.add(aria);
    const title = element.getAttribute('title');
    if (title) out.add(title);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
    const textNodes = [...element.childNodes].filter(node => node.nodeType === node.TEXT_NODE);
    // Whole-element text (for elements whose only child is one string), AND
    // each individual text node (for elements built from mixed JSX text +
    // inline `<span>` siblings — e.g. prose broken around an EXPRESS-name
    // span — where the DOM has several sibling text nodes under one
    // element and no single one is the full sentence).
    const joined = textNodes.map(node => node.textContent ?? '').join('').trim();
    if (joined) out.add(joined);
    for (const node of textNodes) {
      const own = (node.textContent ?? '').trim();
      if (own) out.add(own);
    }
  });
}

/** Collects aria-labels/titles/placeholders/text, and — by focusing every
 *  focusable element in turn — reachable Radix `TooltipContent` text. */
function visibleStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  // Radix `Portal`-rendered content (dropdown/tooltip/select bodies) mounts
  // under `document.body`, not under `container` — focus-walk the whole
  // document so a Tooltip nested inside an already-open portal still gets
  // its trigger focused.
  for (const el of document.body.querySelectorAll<HTMLElement>('button, input, [tabindex]')) {
    act(() => el.focus());
    addReadable(document.body, out);
    act(() => el.blur());
  }
  return out;
}

function openMenu(trigger: Element): void {
  act(() => {
    trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  act(() => {
    trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Keys covered by at least one component render below (populated as the
 *  suite runs) and keys deliberately excluded with a one-line reason. */
const covered = new Set<ScheduleKey>();
function checkCovered(englishSeen: Set<string>, afterPseudo: Set<string>, prefix?: string, skip: ScheduleKey[] = []): void {
  for (const key of STATIC_KEYS) {
    if (prefix && !key.startsWith(prefix)) continue;
    if (skip.includes(key)) continue;
    const text = CATALOGUE[key] as string;
    if (!englishSeen.has(text)) continue;
    assert.ok(afterPseudo.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
    covered.add(key);
  }
}

const NOT_RENDERED: Array<[ScheduleKey, string]> = [
  // GanttPanel's import-replace confirmation banner requires driving
  // `useScheduleFileImport`'s local `pendingImport` state through a real
  // FileReader-backed file-input change event — disproportionate DOM/async
  // plumbing to exercise 3 keys whose t() call sites are otherwise
  // identical in shape to every other converted string in this sweep.
  ['schedule.panel.importReplaceWarning', 'requires a real file-input change event via useScheduleFileImport'],
  ['schedule.panel.replace', 'requires a real file-input change event via useScheduleFileImport'],
  ['schedule.panel.cancel', 'requires a real file-input change event via useScheduleFileImport'],
  // GanttToolbar's SCALE_OPTIONS/allTasks-option Radix Select listbox items
  // other than the one currently selected only mount once the closed
  // Select's portal listbox is opened; the visible trigger text already
  // exercises the same t(labelKey) call site for 'week' (the default scale).
  ['schedule.toolbar.scaleHour', 'inside the closed Select listbox portal; scaleWeek (the visible default) covers the same call site'],
  ['schedule.toolbar.scaleDay', 'inside the closed Select listbox portal; scaleWeek (the visible default) covers the same call site'],
  ['schedule.toolbar.scaleMonth', 'inside the closed Select listbox portal; scaleWeek (the visible default) covers the same call site'],
  ['schedule.toolbar.scaleYear', 'inside the closed Select listbox portal; scaleWeek (the visible default) covers the same call site'],
  // GanttToolbar: each pair below is mutually exclusive with its opposite
  // state in a single render. The toolbar test below is rendered playing
  // paused with looping on and a real (non-synthetic) date range, and
  // `canGenerate` true — so only one side of each pair is on screen;
  // exercising every opposite state would need one render per state for a
  // handful of one-word labels whose t() call sites are identical in shape
  // to their (covered) counterparts.
  ['schedule.toolbar.pause', 'opposite of the covered "play" state (isPlaying is false in this render)'],
  ['schedule.toolbar.pauseConstructionSequence', 'opposite of the covered "play" tooltip state'],
  ['schedule.toolbar.enableLoop', 'opposite of the covered "disable loop" state (playbackLoop defaults true)'],
  ['schedule.toolbar.oneShot', 'opposite of the covered "looping" state (playbackLoop defaults true)'],
  ['schedule.toolbar.noSpatialHierarchy', 'opposite of the covered "generate schedule…" tooltip (canGenerate is true in this render)'],
  ['schedule.toolbar.noDates', 'opposite of the covered dated range (scheduleRange.synthetic is false in this render)'],
  ['schedule.toolbar.noDatesTitle', 'opposite of the covered dated range (scheduleRange.synthetic is false in this render)'],
  // Gauge (simulation-speed) icon is a bare `<svg>` behind `TooltipTrigger
  // asChild` with no button/tabIndex of its own, so it cannot be reached by
  // this oracle's focus-walk (which needs a genuinely focusable element) —
  // only a real pointer-hover reaches it, which jsdom does not simulate.
  ['schedule.toolbar.simulationSpeed', 'Tooltip trigger is a bare icon with no focusable element; only reachable by pointer hover'],
  // GanttDragTooltip: mutually exclusive with the covered "shift" mode in
  // a single render (`live.mode` is one value at a time).
  ['schedule.dragTooltip.resizingStart', 'opposite of the covered "shift" mode render'],
  ['schedule.dragTooltip.resizingFinish', 'opposite of the covered "shift" mode render'],
  // GenerateScheduleDialog: `spatialHierarchyMissing` needs a model with
  // geometry but no spatial hierarchy (a third store shape beyond the two
  // already rendered — "has spatial hierarchy" and "has neither"), and
  // `noGroupsMatch` needs a non-empty store whose preview is nonetheless
  // empty (e.g. every group filtered out by "skip empty groups") — both
  // are additional store fixtures beyond the two covered above.
  ['schedule.generateDialog.spatialHierarchyMissing', 'requires a third store fixture: geometry present but no spatial hierarchy'],
  ['schedule.generateDialog.noGroupsMatch', 'requires a store fixture whose preview is empty despite canGenerate being true'],
  // AnimationSettingsPopover: the Minimal-state CTA is mutually exclusive
  // with the Phased-state palette editor covered by the render below.
  ['schedule.animation.switchToPhasedCta', 'opposite of the covered Phased-state render (colorizeByTaskType is true here)'],
  ['schedule.animation.switchToPhasedHint', 'opposite of the covered Phased-state render (colorizeByTaskType is true here)'],
];

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('GanttDragTooltip localization (#4918)', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  it('translates the drag readout, including interpolated start/finish/duration', () => {
    const container = render(
      <GanttDragTooltip
        live={{
          taskGlobalId: 'g1',
          mode: 'shift',
          liveStartMs: Date.UTC(2024, 4, 1, 8, 0),
          liveFinishMs: Date.UTC(2024, 4, 6, 8, 0),
        }}
      />,
    );
    const english = visibleStrings(container);
    assert.ok(english.has('Shifting'));

    registerLocale('drag-tooltip-pseudo', PSEUDO);
    act(() => setLocale('drag-tooltip-pseudo'));
    const after = visibleStrings(container);

    assert.ok(after.has(mark('schedule.dragTooltip.shifting')));
    assert.ok([...after].some(s => s.startsWith('⟦schedule.dragTooltip.start|')), 'interpolated start not marked');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.dragTooltip.finish|')), 'interpolated finish not marked');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.dragTooltip.duration|')), 'interpolated duration not marked');
    assert.ok(after.has(mark('schedule.dragTooltip.hint')));
    covered.add('schedule.dragTooltip.shifting');
    covered.add('schedule.dragTooltip.hint');
  });
});

describe('GanttWorkPlanSummary localization (#4918)', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  function plan(globalId: string, name: string, childScheduleGlobalIds: string[]): WorkScheduleInfo {
    return { expressId: 0, globalId, kind: 'WorkPlan', name, taskGlobalIds: [], childScheduleGlobalIds };
  }
  function schedule(globalId: string, name: string, parentPlanGlobalId?: string): WorkScheduleInfo {
    return { expressId: 0, globalId, kind: 'WorkSchedule', name, taskGlobalIds: [], parentPlanGlobalId };
  }

  it('translates the strip, including plural heading and interpolated titles/lists', () => {
    const workSchedules = [
      plan('plan-1', 'Phase 1', ['sched-1']),
      plan('plan-2', 'Phase 2', []),
      schedule('sched-1', 'Sched One', 'plan-1'),
    ];
    const container = render(<GanttWorkPlanSummary workSchedules={workSchedules} />);
    const english = visibleStrings(container);
    assert.ok(english.has('Work plans')); // 2 groups -> plural "other"
    assert.ok(english.has('No nested schedules')); // plan-2 has none

    registerLocale('work-plan-summary-pseudo', PSEUDO);
    act(() => setLocale('work-plan-summary-pseudo'));
    const after = visibleStrings(container);

    assert.ok(after.has(mark('schedule.workPlanSummary.heading')));
    assert.ok(after.has(mark('schedule.workPlanSummary.ariaLabel')));
    assert.ok(after.has(mark('schedule.workPlanSummary.nestedAriaLabel')));
    assert.ok(after.has(mark('schedule.workPlanSummary.noNestedSchedules')));
    assert.ok([...after].some(s => s.startsWith('⟦schedule.workPlanSummary.planTitle|')), 'interpolated plan title not marked');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.workPlanSummary.schedulesList|')), 'interpolated schedules list not marked');
    for (const key of ['schedule.workPlanSummary.ariaLabel', 'schedule.workPlanSummary.heading', 'schedule.workPlanSummary.nestedAriaLabel', 'schedule.workPlanSummary.noNestedSchedules'] as ScheduleKey[]) {
      covered.add(key);
    }
  });

  it('shows the singular heading and the ungrouped-schedules line for one group', () => {
    const workSchedules = [plan('plan-1', 'Phase 1', []), schedule('sched-orphan', 'Orphan')];
    const container = render(<GanttWorkPlanSummary workSchedules={workSchedules} />);
    const english = visibleStrings(container);
    assert.ok(english.has('Work plan')); // 1 group -> plural "one"

    registerLocale('work-plan-summary-singular-pseudo', PSEUDO);
    act(() => setLocale('work-plan-summary-singular-pseudo'));
    const after = visibleStrings(container);
    assert.ok([...after].some(s => s.startsWith('⟦schedule.workPlanSummary.ungrouped|')), 'interpolated ungrouped line not marked');
  });
});

describe('GanttTaskTree localization (#4918)', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  function task(globalId: string, name: string, calendarGlobalIds?: string[]): ScheduleTaskInfo {
    return { expressId: 0, globalId, name, isMilestone: false, calendarGlobalIds, childGlobalIds: [], productExpressIds: [], productGlobalIds: [], controllingScheduleGlobalIds: [] };
  }

  it('translates the column header and the collapse/expand + work-calendar labels', () => {
    const rows: FlattenedTask[] = [
      { task: task('t1', 'Parent task', ['cal-1']), depth: 0, hasChildren: true, expanded: true },
      { task: task('t2', 'Child task'), depth: 1, hasChildren: false, expanded: false },
      { task: task('t3', 'Collapsed parent'), depth: 0, hasChildren: true, expanded: false },
    ];
    const container = render(
      <GanttTaskTree
        rows={rows}
        selectedGlobalIds={new Set()}
        hoveredGlobalId={null}
        onToggleExpand={() => {}}
        onSelect={() => {}}
        onHover={() => {}}
        calendarNamesByGlobalId={new Map([['cal-1', 'Standard']])}
        scrollTop={0}
        onScroll={() => {}}
      />,
    );
    const english = visibleStrings(container);
    assert.ok(english.has('Task'));
    assert.ok(english.has('Duration'));
    assert.ok([...english].some(s => s === 'Collapse Parent task'));

    registerLocale('task-tree-pseudo', PSEUDO);
    act(() => setLocale('task-tree-pseudo'));
    const after = visibleStrings(container);

    assert.ok(after.has(mark('schedule.taskTree.columnTask')));
    assert.ok(after.has(mark('schedule.taskTree.columnDuration')));
    assert.ok([...after].some(s => s.startsWith('⟦schedule.taskTree.toggleExpandAriaLabel|')), 'interpolated expand aria-label not marked');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.taskTree.workCalendar|')), 'interpolated work-calendar label not marked');
    // `collapse`/`expand` never render standalone — they're always the
    // interpolated `{action}` parameter inside `toggleExpandAriaLabel`, so
    // their marked text is a substring of that combined aria-label rather
    // than a set member of its own.
    assert.ok([...after].some(s => s.includes(mark('schedule.taskTree.collapse'))), 'collapse param not embedded in the expand aria-label');
    assert.ok([...after].some(s => s.includes(mark('schedule.taskTree.expand'))), 'expand param not embedded in the expand aria-label');
    covered.add('schedule.taskTree.columnTask');
    covered.add('schedule.taskTree.columnDuration');
    covered.add('schedule.taskTree.collapse');
    covered.add('schedule.taskTree.expand');
  });
});

describe('HeightStrategyPanel localization (#4918)', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  function renderPanel(elementZSubgroup: 'none' | 'class' | 'type' | 'name') {
    return render(
      <HeightStrategyPanel
        heightTolerance={3}
        elementZSubgroup={elementZSubgroup}
        onHeightToleranceChange={() => {}}
        onSubgroupChange={() => {}}
      />,
    );
  }

  it('translates the panel chrome and the "none" subgroup description', () => {
    const container = renderPanel('none');
    const english = visibleStrings(container);
    assert.ok(english.has('Height-slice options'));

    registerLocale('height-strategy-pseudo', PSEUDO);
    act(() => setLocale('height-strategy-pseudo'));
    const after = visibleStrings(container);
    checkCovered(english, after, 'schedule.heightStrategy.');
    covered.add('schedule.heightStrategy.subgroupNone');
    assert.ok(after.has(mark('schedule.heightStrategy.subgroupNone')));
  });

  for (const [mode, key] of [
    ['class', 'schedule.heightStrategy.subgroupClass'],
    ['type', 'schedule.heightStrategy.subgroupType'],
    ['name', 'schedule.heightStrategy.subgroupName'],
  ] as const) {
    it(`translates the "${mode}" subgroup description`, () => {
      registerLocale('height-strategy-variant-pseudo', PSEUDO);
      const container = renderPanel(mode);
      act(() => setLocale('height-strategy-variant-pseudo'));
      const after = visibleStrings(container);
      assert.ok(after.has(mark(key)));
      covered.add(key);
    });
  }
});

describe('GenerateAdvancedPanel localization (#4918)', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  function renderPanel(strategy: 'IfcElement' | 'IfcBuildingStorey') {
    return render(
      <GenerateAdvancedPanel
        open
        onOpenChange={() => {}}
        strategy={strategy}
        lagDays={0}
        predefinedType="CONSTRUCTION"
        scheduleName=""
        linkSequences
        skipEmptyGroups
        onChange={() => {}}
        createWorkPlan
        onCreateWorkPlanChange={() => {}}
        workPlanName=""
        onWorkPlanNameChange={() => {}}
      />,
    );
  }

  it('translates every field, toggle, and placeholder when open with a work plan', () => {
    const container = renderPanel('IfcElement');
    const english = visibleStrings(container);
    assert.ok(english.has('Advanced'));

    registerLocale('generate-advanced-pseudo', PSEUDO);
    act(() => setLocale('generate-advanced-pseudo'));
    const after = visibleStrings(container);
    checkCovered(english, after, 'schedule.generateAdvanced.');
  });

  it('translates the spatial-strategy skip-empty description', () => {
    registerLocale('generate-advanced-spatial-pseudo', PSEUDO);
    const container = renderPanel('IfcBuildingStorey');
    act(() => setLocale('generate-advanced-spatial-pseudo'));
    const after = visibleStrings(container);
    assert.ok(after.has(mark('schedule.generateAdvanced.skipEmptyDescriptionSpatial')));
    covered.add('schedule.generateAdvanced.skipEmptyDescriptionSpatial');
  });
});

describe('GanttEmptyState localization (#4918)', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  it('translates the "load a model" and helper-text states', () => {
    const container = render(
      <GanttEmptyState loading={false} hasModel={false} canGenerate onImport={() => {}} onClose={() => {}} />,
    );
    const english = visibleStrings(container);
    assert.ok(english.has('Load a model with IfcTasks'));

    registerLocale('empty-state-load-pseudo', PSEUDO);
    act(() => setLocale('empty-state-load-pseudo'));
    const after = visibleStrings(container);
    checkCovered(english, after, 'schedule.emptyState.');
  });

  it('translates the extraction-error state', () => {
    const container = render(
      <GanttEmptyState
        loading={false}
        hasModel
        canGenerate
        extractionError="boom"
        onGenerate={() => {}}
        onImport={() => {}}
      />,
    );
    const english = visibleStrings(container);
    registerLocale('empty-state-error-pseudo', PSEUDO);
    act(() => setLocale('empty-state-error-pseudo'));
    const after = visibleStrings(container);
    checkCovered(english, after, 'schedule.emptyState.');
  });

  it('translates the loading, no-tasks-in-schedule, and no-work-plans states', () => {
    const loadingContainer = render(<GanttEmptyState loading hasModel />);
    const loadingEnglish = visibleStrings(loadingContainer);
    registerLocale('empty-state-loading-pseudo', PSEUDO);
    act(() => setLocale('empty-state-loading-pseudo'));
    checkCovered(loadingEnglish, visibleStrings(loadingContainer), 'schedule.emptyState.');
    cleanup();
    setLocale('en');

    const selectedEmptyContainer = render(
      <GanttEmptyState loading={false} hasModel selectedScheduleEmpty />,
    );
    const selectedEmptyEnglish = visibleStrings(selectedEmptyContainer);
    registerLocale('empty-state-selected-empty-pseudo', PSEUDO);
    act(() => setLocale('empty-state-selected-empty-pseudo'));
    checkCovered(selectedEmptyEnglish, visibleStrings(selectedEmptyContainer), 'schedule.emptyState.');
    cleanup();
    setLocale('en');

    const workPlansContainer = render(
      <GanttEmptyState loading={false} hasModel hasWorkPlans canGenerate onGenerate={() => {}} onImport={() => {}} />,
    );
    const workPlansEnglish = visibleStrings(workPlansContainer);
    assert.ok(workPlansEnglish.has('No scheduled tasks'));
    registerLocale('empty-state-work-plans-pseudo', PSEUDO);
    act(() => setLocale('empty-state-work-plans-pseudo'));
    const workPlansAfter = visibleStrings(workPlansContainer);
    checkCovered(workPlansEnglish, workPlansAfter, 'schedule.emptyState.');
    assert.ok(workPlansAfter.has(mark('schedule.emptyState.helperBoth')), 'complete helperBoth message not marked');
  });

  it('translates the "no schedule found" state, generate-only helper text', () => {
    const container = render(
      <GanttEmptyState loading={false} hasModel canGenerate onGenerate={() => {}} />,
    );
    const english = visibleStrings(container);
    assert.ok(english.has('No schedule found'));
    registerLocale('empty-state-not-found-pseudo', PSEUDO);
    act(() => setLocale('empty-state-not-found-pseudo'));
    const after = visibleStrings(container);
    checkCovered(english, after, 'schedule.emptyState.');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.emptyState.helperGenerateOnly|')), 'helperGenerateOnly interpolation not marked');
  });

  it('translates the import-only helper text (capitalised)', () => {
    const container = render(
      <GanttEmptyState loading={false} hasModel onImport={() => {}} />,
    );
    const english = visibleStrings(container);
    assert.ok([...english].some(s => s.startsWith('Import one from MS Project')));
    registerLocale('empty-state-import-only-pseudo', PSEUDO);
    act(() => setLocale('empty-state-import-only-pseudo'));
    const after = visibleStrings(container);
    assert.ok([...after].some(s => s.startsWith('⟦schedule.emptyState.helperImportOnly|')), 'helperImportOnly message not marked');
    covered.add('schedule.emptyState.helperImportOnly');
  });
});

describe('AnimationSettingsPopover localization (#4918)', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  it('translates the trigger, style tiles, timing toggles, and (once open) the phased/palette section', () => {
    const settings = useViewerStore.getState().animationSettings;
    useViewerStore.setState({
      animationSettings: {
        ...settings,
        colorizeByTaskType: true,
        showPreparationGhost: true,
        showCompletedTint: true,
        paletteIntensity: 0.6,
        // A modified entry (default green -> red) so the per-swatch
        // "reset to default" tooltip/aria-label actually render — they're
        // hidden for entries still at their default colour.
        palette: { ...settings.palette, CONSTRUCTION: [1, 0, 0, 1] },
      },
    });
    registerLocale('animation-settings-pseudo', PSEUDO);

    // Pass 1: the CLOSED trigger's own Tooltip (`settingsTooltip`) — a
    // separate render because once the (modal) dropdown is open, focusing
    // the trigger again gets redirected back inside the open content by
    // Radix's focus trap (same constraint documented in
    // MainToolbar.i18n.test.tsx), so this Tooltip is unreachable there.
    const closedContainer = render(
      <AnimationSettingsPopover animationEnabled onToggleAnimation={() => {}} />,
    );
    const closedEnglish = visibleStrings(closedContainer);
    assert.ok(closedEnglish.has('4D animation settings'));
    act(() => setLocale('animation-settings-pseudo'));
    const closedAfter = visibleStrings(closedContainer);
    assert.ok(closedAfter.has(mark('schedule.animation.settingsTooltip')));
    covered.add('schedule.animation.settingsTooltip');
    cleanup();
    setLocale('en');

    // Pass 2: the OPEN dropdown's Phased-state body.
    const container = render(
      <AnimationSettingsPopover animationEnabled onToggleAnimation={() => {}} />,
    );
    openMenu(container.querySelector('button[aria-haspopup="menu"]')!);
    const english = visibleStrings(container);
    assert.ok(english.has('4D animation'));
    assert.ok(english.has('Task-type palette'));

    act(() => setLocale('animation-settings-pseudo'));
    const after = visibleStrings(container);
    checkCovered(english, after, 'schedule.animation.');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.animation.resetEntryAriaLabel|')), 'reset-entry aria-label interpolation not marked');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.animation.swatchTitle|')), 'swatch title interpolation not marked');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.animation.swatchAriaLabel|')), 'swatch aria-label interpolation not marked');
  });

  afterEach(() => {
    useViewerStore.getState().resetAnimationSettings();
  });
});

describe('GanttToolbar localization (#4918)', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  function makeScheduleData() {
    const tasks: ScheduleTaskInfo[] = [
      { expressId: 5, globalId: 't1', name: 'Task 1', isMilestone: false, childGlobalIds: [], productExpressIds: [], productGlobalIds: [], controllingScheduleGlobalIds: [] },
      { expressId: 0, globalId: 't2', name: 'Task 2', isMilestone: false, childGlobalIds: [], productExpressIds: [], productGlobalIds: [], controllingScheduleGlobalIds: [] }, // generated (pending discard)
    ];
    const workSchedules: WorkScheduleInfo[] = [
      { expressId: 1, globalId: 'ws1', kind: 'WorkSchedule', name: 'Main schedule', taskGlobalIds: ['t1', 't2'] },
    ];
    return { hasSchedule: true, workSchedules, tasks, sequences: [], workCalendars: [] };
  }

  it('translates playback, schedule/speed/scale controls, undo/redo, and the discard toast/labels', () => {
    useViewerStore.setState({
      scheduleData: makeScheduleData(),
      scheduleRange: { start: 0, end: 86_400_000 * 5, synthetic: false },
      scheduleUndoStack: [{} as unknown as never],
      scheduleRedoStack: [{} as unknown as never],
    });
    const container = render(<GanttToolbar onClose={() => {}} onOpenGenerate={() => {}} onOpenImport={() => {}} canGenerate />);
    const english = visibleStrings(container);
    assert.ok(english.has('Jump to start'));
    assert.ok(english.has('Week')); // default ganttTimeScale

    registerLocale('gantt-toolbar-pseudo', PSEUDO);
    act(() => setLocale('gantt-toolbar-pseudo'));
    const after = visibleStrings(container);
    checkCovered(english, after, 'schedule.toolbar.');
    assert.ok(container.innerHTML.includes(mark('schedule.toolbar.allTasks')),
      'All tasks option must follow a live locale switch');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.toolbar.discardedToast|') || s.startsWith('⟦schedule.toolbar.discardPendingAriaLabel|')), 'discard-pending plural not marked');
    covered.add('schedule.toolbar.scaleWeek');
  });

  it('translates the "All tasks" Select placeholder on a cold mount under the pseudo locale', () => {
    // Also prove the initial mount under a non-English locale.
    registerLocale('gantt-toolbar-cold-pseudo', PSEUDO);
    act(() => setLocale('gantt-toolbar-cold-pseudo'));
    useViewerStore.setState({
      scheduleData: makeScheduleData(),
      scheduleRange: { start: 0, end: 86_400_000 * 5, synthetic: false },
    });
    const container = render(<GanttToolbar />);
    assert.ok(container.innerHTML.includes(mark('schedule.toolbar.allTasks')));
    covered.add('schedule.toolbar.allTasks');
  });

  afterEach(() => {
    useViewerStore.setState({
      scheduleData: null,
      scheduleRange: null,
      scheduleUndoStack: [],
      scheduleRedoStack: [],
    });
  });
});

describe('ScheduleSummaryLine localization (#4918)', () => {
  it('preserves translator ordering while styling the three interpolated values', () => {
    const container = render(<ScheduleSummaryLine groups={2} products={7} date="2030-01-02" />);
    const summary = container.querySelector('p');
    assert.ok(summary);
    assert.equal(summary.querySelectorAll('span.font-semibold').length, 2,
      'task and product counts stay emphasized');
    assert.equal(summary.querySelectorAll('span.font-mono').length, 1,
      'finish timestamp stays monospaced');

    registerLocale('schedule-summary-pseudo', PSEUDO);
    act(() => setLocale('schedule-summary-pseudo'));
    assert.ok(summary.textContent?.startsWith('⟦schedule.generateDialog.summaryLine|'));
    covered.add('schedule.generateDialog.summaryLine');
  });
});

describe('GenerateScheduleDialog localization (#4918)', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  function buildMockStore(): IfcDataStore {
    const entities = new Map<number, { name: string; globalId: string }>([
      [100, { name: 'Ground', globalId: 'storey-0000' }],
      [1, { name: 'Wall A', globalId: 'wall-A' }],
    ]);
    return {
      spatialHierarchy: {
        project: { expressId: 0, type: 0, name: 'Project', children: [], elements: [] },
        byStorey: new Map([[100, [1]]]),
        byBuilding: new Map([[99, [1]]]),
        bySite: new Map(),
        bySpace: new Map(),
        storeyElevations: new Map([[100, 0]]),
        storeyHeights: new Map(),
        elementToStorey: new Map(),
        getStoreyElements: () => [],
        getStoreyByElevation: () => null,
        getContainingSpace: () => null,
        getPath: () => [],
      },
      entities: {
        getName: (id: number) => entities.get(id)?.name ?? '',
        getGlobalId: (id: number) => entities.get(id)?.globalId ?? '',
      },
    } as unknown as IfcDataStore;
  }

  it('translates the full dialog body when a spatial hierarchy is available', () => {
    useViewerStore.setState({ ifcDataStore: buildMockStore() });
    const container = render(<GenerateScheduleDialog open onOpenChange={() => {}} />);
    const english = visibleStrings(container);
    assert.ok(english.has('Generate schedule'));
    assert.ok(english.has('Group by'));
    registerLocale('generate-dialog-pseudo', PSEUDO);
    act(() => setLocale('generate-dialog-pseudo'));
    const after = visibleStrings(container);
    checkCovered(english, after, 'schedule.generateDialog.');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.generateDialog.summaryLine|')), 'summary line interpolation not marked');
    assert.ok([...after].some(s => s.startsWith('⟦schedule.generateDialog.taskRangeSingle|')), 'single-task interpolation not marked');
  });

  it('translates the "nothing to group by" state when there is no spatial hierarchy or geometry', () => {
    useViewerStore.setState({ ifcDataStore: null });
    const container = render(<GenerateScheduleDialog open onOpenChange={() => {}} />);
    const english = visibleStrings(container);
    assert.ok(english.has('Nothing to group by'));
    registerLocale('generate-dialog-empty-pseudo', PSEUDO);
    act(() => setLocale('generate-dialog-empty-pseudo'));
    const after = visibleStrings(container);
    assert.ok(after.has(mark('schedule.generateDialog.nothingToGroupByTitle')));
    assert.ok(after.has(mark('schedule.generateDialog.nothingToGroupByDescription')));
    covered.add('schedule.generateDialog.nothingToGroupByTitle');
    covered.add('schedule.generateDialog.nothingToGroupByDescription');
  });

  afterEach(() => {
    useViewerStore.setState({ ifcDataStore: null });
  });
});

describe('schedule.en interpolation and plural forms', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  it('interpolates every {param} key with the substituted value visible', () => {
    registerLocale('interp-pseudo', PSEUDO);
    act(() => setLocale('interp-pseudo'));
    for (const key of INTERP_KEYS) {
      const template = CATALOGUE[key] as string;
      const params: Record<string, string> = {};
      const names = [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]);
      for (const name of names) params[name] = `TEST_${name.toUpperCase()}`;
      const resolved = resolve(key as unknown as Parameters<typeof resolve>[0], params);
      assert.ok(resolved.startsWith(`⟦${key}|`), `${key}: not pseudo-marked: ${resolved}`);
      for (const name of names) {
        assert.ok(resolved.includes(`TEST_${name.toUpperCase()}`), `${key}: {${name}} was not substituted: ${resolved}`);
      }
    }
  });

  it('resolves the correct plural category for count = 1 vs. count != 1', () => {
    for (const key of PLURAL_KEYS) {
      const one = resolve(key as unknown as Parameters<typeof resolve>[0], { count: 1 });
      const other = resolve(key as unknown as Parameters<typeof resolve>[0], { count: 3 });
      const value = CATALOGUE[key] as PluralTranslation;
      const interpolate = (template: string, count: number) => template.replace('{count}', String(count));
      assert.strictEqual(one, interpolate(value.one ?? value.other, 1), `${key}: count=1 form`);
      assert.strictEqual(other, interpolate(value.other, 3), `${key}: count=3 form`);
      assert.notStrictEqual(one, other, `${key}: singular/plural forms should differ`);
    }
  });
});

describe('schedule.en catalogue coverage (#4918)', { skip: !HAS_CATALOGUE && 'schedule.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  it('accounts for every static key across the suite above or a documented reason', () => {
    const notRenderedKeys = new Set(NOT_RENDERED.map(([key]) => key));
    const unaccounted = STATIC_KEYS.filter(key => !covered.has(key) && !notRenderedKeys.has(key));
    assert.deepEqual(unaccounted, [], `key neither rendered nor listed in NOT_RENDERED: ${unaccounted.join(', ')}`);

    const staleExclusions = [...notRenderedKeys].filter(key => covered.has(key as ScheduleKey));
    assert.deepEqual(staleExclusions, [], `key listed as not-rendered but is actually covered: ${staleExclusions.join(', ')}`);
  });
});
