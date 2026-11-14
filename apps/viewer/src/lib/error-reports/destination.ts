/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react';
import type { TranslationKey } from '@/i18n';
import { getReportPrompt, offerErrorReport, openErrorReport, subscribeReportPrompt } from './context';
import { pendingReport, recentReport, subscribeRecentReport } from './pending';

// Registration reflects App's actual conditional mount, not an assumed build flag (#8947).
const owners = new Set<symbol>();
const listeners = new Set<() => void>();
function emit() { for (const listener of listeners) listener(); }
export function registerErrorReportHost(): () => void {
  const owner = Symbol();
  owners.add(owner); emit();
  return () => { owners.delete(owner); emit(); };
}
export function errorReportDestinationBlock(): TranslationKey | undefined {
  if (!owners.size) return 'commandPalette.availability.errorReportHost';
  if (!getReportPrompt() && !recentReport() && !pendingReport()) return 'commandPalette.availability.errorReportContext';
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const prompt = subscribeReportPrompt(listener);
  const recent = subscribeRecentReport(listener);
  return () => { listeners.delete(listener); prompt(); recent(); };
}
export function useErrorReportDestination() {
  return useSyncExternalStore(subscribe, errorReportDestinationBlock, () => 'commandPalette.availability.errorReportHost');
}
/** Buttons and palette share this live boundary; opening never submits or uploads. */
export function openErrorReportDestination(route: 'current' | 'recent' = 'current'): void {
  if (errorReportDestinationBlock()) return;
  const prompt = getReportPrompt();
  if (prompt?.open) return;
  if (!prompt || route === 'recent') {
    const resumeReportId = recentReport() ?? pendingReport();
    if (!resumeReportId) return;
    offerErrorReport({ errorCode: 'report_resume', resumeReportId }, true);
  }
  openErrorReport();
}
