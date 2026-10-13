/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const KEY = 'ifc-lite:pending-error-report';
const RECENT_KEY = 'ifc-lite:recent-error-report';
const recentListeners = new Set<() => void>();
let recentInMemory: string | undefined;
export function subscribeRecentReport(listener: () => void): () => void {
  recentListeners.add(listener);
  return () => { recentListeners.delete(listener); };
}
export function recentReport(): string | undefined {
  if (typeof sessionStorage === 'undefined') return recentInMemory;
  try {
    const id = sessionStorage.getItem(RECENT_KEY);
    return id && /^[a-zA-Z0-9-]{1,100}$/.test(id) ? id : recentInMemory;
  } catch (error) { console.warn('[error-report] Cannot read recent report reference', error); return recentInMemory; }
}
function notifyRecent() { for (const listener of recentListeners) listener(); }
export function forgetReport(id: string): void {
  if (recentInMemory === id) recentInMemory = undefined;
  if (typeof sessionStorage !== 'undefined') {
    try {
      if (sessionStorage.getItem(KEY) === id) sessionStorage.removeItem(KEY);
      if (sessionStorage.getItem(RECENT_KEY) === id) sessionStorage.removeItem(RECENT_KEY);
    } catch (error) { console.warn('[error-report] Cannot remove report reference', error); }
  }
  notifyRecent();
}
/** Completion may clear only its own pending reference; keep private management. */
export function completeReport(id: string): void {
  if (!recentReport()) {
    recentInMemory = id;
    if (typeof sessionStorage !== 'undefined') {
      try { sessionStorage.setItem(RECENT_KEY, id); }
      catch (error) { console.warn('[error-report] Cannot retain completed report reference', error); }
    }
  }
  if (typeof sessionStorage !== 'undefined') {
    try { if (sessionStorage.getItem(KEY) === id) sessionStorage.removeItem(KEY); }
    catch (error) { console.warn('[error-report] Cannot complete report reference', error); }
  }
  notifyRecent();
}
/** Only a report identifier is stored. Text, model names, bytes and signer identity stay off browser storage. */
export function pendingReport(): string | undefined {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const id = sessionStorage.getItem(KEY);
    return id && /^[a-zA-Z0-9-]{1,100}$/.test(id) ? id : undefined;
  } catch (error) { console.warn('[error-report] Cannot read pending report', error); return undefined; }
}
export function rememberReport(id: string, onlyIfVacant = false): void {
  const current = pendingReport();
  if (onlyIfVacant && current && current !== id) return;
  if (id) recentInMemory = id;
  if (typeof sessionStorage === 'undefined') { notifyRecent(); return; }
  try {
    if (id) { sessionStorage.setItem(KEY, id); sessionStorage.setItem(RECENT_KEY, id); }

  }
  catch (error) { console.warn('[error-report] Cannot retain report reference', error); }
  notifyRecent();
}
