/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const KEY = 'ifc-lite:pending-error-report';
/** Only a report identifier is stored. Text, model names, bytes and signer identity stay off browser storage. */
export function pendingReport(): string | undefined {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const id = sessionStorage.getItem(KEY);
    return id && /^[a-zA-Z0-9-]{1,100}$/.test(id) ? id : undefined;
  } catch (error) { console.warn('[error-report] Cannot read pending report', error); return undefined; }
}
export function rememberReport(id: string | undefined): void {
  if (typeof sessionStorage === 'undefined') return;
  try { if (id) sessionStorage.setItem(KEY, id); else sessionStorage.removeItem(KEY); }
  catch (error) { console.warn('[error-report] Cannot retain report reference', error); }
}
