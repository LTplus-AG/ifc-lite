/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Browser-local choice shared by explicit events and PostHog's own captures. */
const OPT_OUT_KEY = 'ifc-lite:analytics-opt-out';
/**
 * Set once the first-visit privacy notice has been shown in this browser.
 * Analytics start only after it is set, so no analytics identifier exists
 * before the visitor has been told about the opt-out.
 */
export const PRIVACY_NOTICE_KEY = 'ifclite.extensions.privacy-disclosure.v2';

function readStoredOptOut(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(OPT_OUT_KEY) === 'true';
  } catch (error) {
    console.warn('[analytics] could not read opt-out setting', error);
    return false;
  }
}

let optedOut = readStoredOptOut();
// Covers a browser whose storage refuses the write: the notice was still shown in this tab.
let noticeShownInTab = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.warn('[analytics] consent listener failed', error);
    }
  }
}

/** Called after the opt-out choice or the notice state changes. */
export function subscribeAnalyticsConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function isAnalyticsOptedOut(): boolean {
  return optedOut;
}

export function persistAnalyticsOptOut(value: boolean): void {
  optedOut = value;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(OPT_OUT_KEY, String(value));
    } catch (error) {
      console.warn('[analytics] could not persist opt-out setting', error);
    }
  }
  emit();
}

/** Read live, so a notice shown in another tab counts too. */
export function isPrivacyNoticeShown(): boolean {
  if (noticeShownInTab) return true;
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(PRIVACY_NOTICE_KEY) !== null;
  } catch (error) {
    console.warn('[privacy] could not read disclosure acknowledgement', error);
    return false;
  }
}

/** The first-visit notice calls this once it is on screen. */
export function markPrivacyNoticeShown(): void {
  noticeShownInTab = true;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(PRIVACY_NOTICE_KEY, new Date().toISOString());
    } catch (error) {
      console.warn('[privacy] could not save disclosure acknowledgement', error);
    }
  }
  emit();
}

/** Test seam: forget the in-tab notice flag (storage is reset by the test itself). */
export function resetPrivacyNoticeForTest(): void {
  noticeShownInTab = false;
}

/**
 * Remove the identifier PostHog stored in an earlier visit. Run when the
 * visitor has opted out, since PostHog is then never started and would not
 * clean up after itself. Only PostHog's own `ph_<token>_posthog` entries and
 * cookie are touched; the opt-out choice itself stays.
 */
export function clearStoredAnalyticsIdentity(): void {
  const isIdentityKey = (key: string | null): key is string => !!key && /^ph_.+_posthog$/.test(key);
  for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
    if (!storage) continue;
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (isIdentityKey(key)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    } catch (error) {
      console.warn('[analytics] could not clear stored analytics identifier', error);
    }
  }
  if (typeof document === 'undefined') return;
  try {
    const names = document.cookie.split(';').map((part) => part.split('=')[0]!.trim()).filter(isIdentityKey);
    if (names.length === 0) return;
    // PostHog sets its cookie on the registrable domain when it can; expire both forms.
    const hostname = document.location?.hostname ?? '';
    const labels = hostname.split('.');
    const domains = ['', ...(labels.length >= 2 ? [`; domain=.${labels.slice(-2).join('.')}`] : [])];
    for (const name of names) {
      for (const domain of domains) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
      }
    }
  } catch (error) {
    console.warn('[analytics] could not clear analytics cookie', error);
  }
}
