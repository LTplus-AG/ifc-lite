/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** User-initiated reports retain at most one failed source, never its copied bytes. */
export interface ReportContext {
  errorCode: string;
  sourceFile?: File;
  resumeReportId?: string;
}
export interface ReportPrompt { context: ReportContext; open: boolean }
let prompt: ReportPrompt | null = null;
const dismissed = new Map<string, number>();
const DISMISS_COOLDOWN_MS = 10 * 60_000;
const listeners = new Set<() => void>();
function emit() { for (const listener of listeners) listener(); }
export function subscribeReportPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getReportPrompt(): ReportPrompt | null { return prompt; }
export function offerErrorReport(context: ReportContext, explicit = false): void {
  const now = Date.now();
  for (const [code, until] of dismissed) if (until <= now) dismissed.delete(code);
  if (!explicit && !context.resumeReportId && dismissed.has(context.errorCode)) return;
  // An error during reporting must never replace the file the user reviewed.
  if (prompt?.open || (prompt?.context.sourceFile && context.errorCode === 'unhandled_viewer_error')) return;
  prompt = { context, open: false };
  emit();
}
export function openErrorReport(): void {
  if (!prompt) return;
  prompt = { ...prompt, open: true };
  emit();
}
export function dismissErrorReport(): void {
  if (prompt) {
    dismissed.set(prompt.context.errorCode, Date.now() + DISMISS_COOLDOWN_MS);
    if (dismissed.size > 50) dismissed.delete(dismissed.keys().next().value!);
  }
  prompt = null; emit();
}
export function clearLoadReport(): void {
  if (prompt && !prompt.open && !prompt.context.resumeReportId && (prompt.context.sourceFile || prompt.context.errorCode === 'load_failed')) { prompt = null; emit(); }
}
