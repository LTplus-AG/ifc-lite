/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which kind of run produced a clash result, so "Re-run" repeats THAT run
 * (#5818). The panel's Re-run button used to call `runAll()` unconditionally:
 * a user who ran the rule matrix, one preset or the duplicate scan got the
 * all-elements self-clash instead, usually a much larger, different result.
 *
 * The request travels WITH the result object, like its federation identity
 * (`rememberFederationIdentity`) and model-tag inputs
 * (`rememberModelTagInputs`): the result lives in the store and outlives the
 * panel, so a hook- or component-local "last run" would be lost on remount and
 * would describe the wrong result after a superseded run.
 */

import type { ClashMode, ClashRule } from '@ifc-lite/clash';
import type { useTranslation } from '@/i18n';

export type ClashRunRequest =
  | { kind: 'all' }
  | { kind: 'matrix' }
  | { kind: 'preset'; presetId: string; name: string }
  | { kind: 'duplicates' };

const requests = new WeakMap<object, ClashRunRequest>();

/** Record the request that produced `result`. `null` records nothing. */
export function rememberRunRequest(result: object, request: ClashRunRequest | null): void {
  if (request) requests.set(result, request);
}

/** The request that produced `result`, or `null` when none was recorded. */
export function runRequestOf(result: object | null | undefined): ClashRunRequest | null {
  return result ? requests.get(result) ?? null : null;
}

/** The single self-clash rule behind "Detect all": every element vs every other. */
export function allElementsRule(mode: ClashMode, clearance: number, reportTouch: boolean): ClashRule {
  return {
    id: 'all-clashes',
    name: 'All elements',
    a: '*',
    mode,
    ...(mode === 'clearance' ? { clearance } : {}),
    ...(reportTouch ? { reportTouch: true } : {}),
  };
}

export interface ClashRunners {
  runAll: () => Promise<void>;
  runMatrix: () => Promise<void>;
  runPreset: (presetId: string) => Promise<void>;
  runDuplicates: () => Promise<void>;
}

/** Repeat `request`; with nothing recorded, fall back to "Detect all". */
export function rerunClashRequest(request: ClashRunRequest | null, runners: ClashRunners): Promise<void> {
  switch (request?.kind) {
    case 'matrix': return runners.runMatrix();
    case 'preset': return runners.runPreset(request.presetId);
    case 'duplicates': return runners.runDuplicates();
    default: return runners.runAll();
  }
}

/** The Re-run tooltip naming what will be repeated. */
export function rerunTooltip(t: ReturnType<typeof useTranslation>['t'], request: ClashRunRequest | null): string {
  switch (request?.kind) {
    case 'matrix': return t('clashPanel.rerunTooltipMatrix');
    case 'preset': return t('clashPanel.rerunTooltipPreset', { name: request.name });
    case 'duplicates': return t('clashPanel.rerunTooltipDuplicates');
    default: return t('clashPanel.rerunTooltip');
  }
}
