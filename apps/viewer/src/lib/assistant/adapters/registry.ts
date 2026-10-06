/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The adapter register (#6833): one native evidence adapter per assistant
 * source, the panel → source mapping, and the explicit boundary for every
 * panel that has no analysis result to discuss. `registry.test.ts` holds the
 * completeness invariants (every source has one adapter; every workspace
 * panel is either mapped or an explained boundary).
 */

import type { TranslationKey } from '@/i18n';
import type { ViewerState } from '@/store';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import type { AssistantSource } from '../sources';
import type { AdapterGroup, EvidenceAdapter } from './types';
import { clashAdapter } from './clash';
import { validationAdapter } from './validation';
import { compareAdapter } from './compare';
import { flowAdapter } from './flow';
import { loadReportAdapter } from './load-report';
import { PACK as CHECKS } from './pack-checks';
import { PACK as COORDINATION } from './pack-coordination';
import { PACK as SITE } from './pack-site';
import { PACK as TABLES } from './pack-tables';
import { PACK as MEASURE } from './pack-measure';
import { PACK as AUTOMATION } from './pack-automation';

export const ADAPTER_GROUPS: ReadonlyArray<{ id: AdapterGroup; labelKey: TranslationKey }> = [
  { id: 'checks', labelKey: 'assistantSources.groupChecks' },
  { id: 'coordination', labelKey: 'assistantSources.groupCoordination' },
  { id: 'quantities', labelKey: 'assistantSources.groupQuantities' },
  { id: 'model', labelKey: 'assistantSources.groupModel' },
  { id: 'automation', labelKey: 'assistantSources.groupAutomation' },
];

export const ADAPTERS: readonly EvidenceAdapter[] = [
  clashAdapter, validationAdapter, compareAdapter, flowAdapter, loadReportAdapter,
  ...CHECKS, ...COORDINATION, ...SITE, ...TABLES, ...MEASURE, ...AUTOMATION,
];

const BY_ID = new Map(ADAPTERS.map(adapter => [adapter.id, adapter]));

export function adapterFor(source: AssistantSource): EvidenceAdapter {
  const adapter = BY_ID.get(source);
  if (!adapter) throw new Error(`No evidence adapter is registered for ${source}`);
  return adapter;
}

/** The source a panel's Discuss with AI attaches now, or null when the panel has none. */
export function panelSource(panel: WorkspacePanelId | null, state: ViewerState): AssistantSource | null {
  if (!panel) return null;
  const candidates = ADAPTERS.filter(adapter => adapter.panelIds.includes(panel));
  return candidates.find(adapter => adapter.panelSubject ? adapter.panelSubject(state) : true)?.id ?? null;
}

/**
 * Panels with no native analysis result. They are shown in the source picker
 * as not discussable, with the reason, instead of being silently omitted.
 */
export const UNSUPPORTED_PANELS: Partial<Record<WorkspacePanelId, TranslationKey>> = {
  appearance: 'assistantSources.boundaryAppearance',
  model: 'assistantSources.boundaryModel',
  extensions: 'assistantSources.boundaryExtensions',
  collab: 'assistantSources.boundaryCollab',
  sources: 'assistantSources.boundarySources',
  presentation: 'assistantSources.boundaryPresentation',
  assistant: 'assistantSources.boundaryAssistant',
  environment: 'assistantSources.boundaryEnvironment',
};
