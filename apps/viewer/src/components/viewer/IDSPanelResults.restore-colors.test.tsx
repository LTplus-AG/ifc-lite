/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6373: after a validation run paints the model red (failed) / green
 * (passed), the results toolbar must be able to give the model its ORIGINAL
 * colours back, without discarding the report, and clearing the report must
 * not leave its colours behind.
 *
 * Before the fix the toolbar's only colour control was "Reapply Colors": it
 * re-sent the same red/green, so pressing it "showed no change" — exactly the
 * report. Clearing results or unloading the IDS left the red/green painted.
 *
 * Both hosts of the shared results view are driven: the IDS panel and the
 * Information validation (rule-set) side of `ValidationPanel`. What is
 * asserted is what the RENDERER would show: a stand-in for
 * `useColorOverlaySync` takes each `pendingColorUpdates` signal, records it as
 * the on-screen overrides (an empty map means "no overrides", i.e. the model's
 * own colours), and nulls the signal exactly as the real flush does. The
 * model's base colours are never written by this path at all — the overlay is
 * the only thing there is to take away.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactElement } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { installLayout } from '@/test/dom-layout.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import type { IDSDocument, ValidationReport } from '@ifc-lite/ids';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { DEFAULT_FAILED_COLOR, DEFAULT_PASSED_COLOR } from '@/hooks/ids/idsColorSystem';
import { IDSPanel } from './IDSPanel.js';
import { ValidationPanel } from './validation/ValidationPanel.js';

installLayout();
const initial = useViewerStore.getState();

type RGBA = [number, number, number, number];

const documentFixture: IDSDocument = {
  info: { title: 'Fixture IDS', version: '1.0' },
  specifications: [{
    id: 'spec-a', name: 'Wall requirements', ifcVersions: ['IFC4'],
    applicability: { facets: [] }, requirements: [],
  }],
};

/** Entity 1 fails, entity 2 passes. */
function reportFor(kind: 'ids' | 'rules', modelId: string): ValidationReport {
  const source = kind === 'ids'
    ? { kind: 'ids' as const, document: documentFixture }
    : { kind: 'rules' as const, ruleSet: { version: 1, name: 'Fixture rules', rules: [] } };
  return {
    source,
    modelInfo: [{ modelId, schemaVersion: 'IFC4', entityCount: 2 }],
    timestamp: new Date(0),
    summary: {
      totalSpecifications: 1, passedSpecifications: 0, failedSpecifications: 1,
      totalEntitiesChecked: 2, totalEntitiesPassed: 1, totalEntitiesFailed: 1, overallPassRate: 50,
    },
    specificationResults: [{
      specification: documentFixture.specifications[0],
      status: 'fail', applicableCount: 2, passedCount: 1, failedCount: 1, passRate: 50,
      entityResults: [
        { expressId: 1, modelId, entityType: 'IfcWall', entityName: 'Wall A', passed: false, requirementResults: [] },
        { expressId: 2, modelId, entityType: 'IfcWall', entityName: 'Wall B', passed: true, requirementResults: [] },
      ],
    }],
  } as unknown as ValidationReport;
}

// ─── Renderer stand-in ──────────────────────────────────────────────────────

/** The overrides the renderer is currently painting (`null`: never painted). */
let onScreen: Map<number, RGBA> | null = null;
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  onScreen = null;
  unsubscribe = useViewerStore.subscribe((state) => {
    if (state.pendingColorUpdates === null) return;
    onScreen = new Map(state.pendingColorUpdates);
    state.clearPendingColorUpdates();
  });
});

afterEach(() => {
  cleanup();
  unsubscribe?.();
  unsubscribe = null;
  setValidationSourceChoice(null);
  useViewerStore.setState({
    ...initial,
    models: new Map(),
    idsDocument: null,
    idsValidationReport: null,
    validationSource: null,
    idsAuditReport: null,
    idsError: null,
    idsLoading: false,
    idsProgress: null,
    pendingColorUpdates: null,
    lensAppliedColors: null,
    isolatedEntities: null,
    ghostExceptEntities: null,
  });
});

function button(ui: HTMLElement, label: string): HTMLButtonElement {
  const found = [...ui.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label);
  assert.ok(found, `expected a button labelled "${label}"`);
  return found as HTMLButtonElement;
}

function painted(): Array<[number, RGBA]> {
  assert.ok(onScreen, 'the renderer must have received a colour delivery');
  return [...onScreen].sort(([a], [b]) => a - b);
}

interface Host {
  name: string;
  kind: 'ids' | 'rules';
  mount: () => ReactElement;
}

const HOSTS: Host[] = [
  { name: 'IDS validation', kind: 'ids', mount: () => <IDSPanel /> },
  { name: 'Information validation', kind: 'rules', mount: () => <ValidationPanel /> },
];

/** One model at offset 0, or two with the report on the offset one. */
function seed(host: Host, modelCount: 1 | 2): { failed: number; passed: number } {
  const models = modelCount === 1
    ? fixtureModels(fixtureModel('m1'))
    : fixtureModels(fixtureModel('m0'), fixtureModel('m1', { idOffset: 1000 }));
  const offset = modelCount === 1 ? 0 : 1000;
  if (host.kind === 'rules') setValidationSourceChoice('rules');
  useViewerStore.setState({
    ...models,
    idsDocument: host.kind === 'ids' ? documentFixture : null,
    idsValidationReport: reportFor(host.kind, 'm1'),
    validationSource: host.kind,
    idsDisplayOptions: { ...initial.idsDisplayOptions, highlightFailed: true, highlightPassed: true },
  });
  return { failed: offset + 1, passed: offset + 2 };
}

for (const host of HOSTS) {
  for (const modelCount of [1, 2] as const) {
    describe(`${host.name}: restore original colors (#6373, ${modelCount} model(s))`, () => {
      it('the toolbar toggle restores the original colors and brings the report colors back', () => {
        const ids = seed(host, modelCount);
        const ui = render(host.mount());
        assert.deepEqual(painted(), [[ids.failed, DEFAULT_FAILED_COLOR], [ids.passed, DEFAULT_PASSED_COLOR]]);

        const restore = button(ui, 'Restore original colors');
        assert.equal(restore.getAttribute('aria-pressed'), 'true');
        click(restore);
        assert.deepEqual(painted(), [], 'no overrides left: the model shows its own colors');
        assert.ok(useViewerStore.getState().idsValidationReport, 'the report itself is kept');

        const show = button(ui, 'Show validation colors');
        assert.equal(show.getAttribute('aria-pressed'), 'false');
        click(show);
        assert.deepEqual(painted(), [[ids.failed, DEFAULT_FAILED_COLOR], [ids.passed, DEFAULT_PASSED_COLOR]]);
      });

      it('restores to an active lens, not to nothing', () => {
        const ids = seed(host, modelCount);
        const lens: RGBA = [0.1, 0.2, 0.9, 1];
        useViewerStore.setState({ lensAppliedColors: new Map([[ids.failed, lens], [77, lens]]) });
        const ui = render(host.mount());
        click(button(ui, 'Restore original colors'));
        assert.deepEqual(painted(), [[ids.failed, lens], [77, lens]].sort(([x], [y]) => (x as number) - (y as number)));
      });

      it('a later isolate/clear-isolation round trip does not repaint colors the user turned off', () => {
        seed(host, modelCount);
        const ui = render(host.mount());
        click(button(ui, 'Restore original colors'));
        click(button(ui, 'Isolate failed (whole IDS)'));
        click(button(ui, 'Clear isolation (show all)'));
        assert.deepEqual(painted(), []);
        assert.ok(button(ui, 'Show validation colors'));
      });

      it('clearing the report takes its colors with it', () => {
        seed(host, modelCount);
        render(host.mount());
        assert.ok(painted().length > 0);
        act(() => useViewerStore.getState().clearIdsValidationReport());
        assert.deepEqual(painted(), []);
      });

      it('clearing the report leaves colors another feature painted since', () => {
        seed(host, modelCount);
        render(host.mount());
        const scripted = new Map<number, RGBA>([[5, [1, 1, 0, 1]]]);
        act(() => useViewerStore.getState().setPendingColorUpdates(scripted));
        act(() => useViewerStore.getState().clearIdsValidationReport());
        assert.deepEqual(painted(), [[5, [1, 1, 0, 1]]]);
      });
    });
  }
}

describe('IDS validation: Clear results and Unload IDS restore original colors (#6373)', () => {
  for (const label of ['Clear results', 'Unload IDS']) {
    it(label, () => {
      seed(HOSTS[0], 1);
      const ui = render(<IDSPanel />);
      assert.ok(painted().length > 0);
      click(button(ui, label));
      assert.deepEqual(painted(), []);
    });
  }
});
