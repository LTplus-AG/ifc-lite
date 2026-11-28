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
 * Remove everything PostHog stored in this browser: its identifier
 * (`ph_<token>_posthog`), the window and tab markers it keeps in session
 * storage (`ph_<token>_window_id`, `ph_<token>_primary_window_exists`) and any
 * other `ph_` entry or cookie. Run at start for a visitor who has opted out
 * (PostHog is then never started and would not clean up after itself) and on
 * every opt-out, since PostHog's own opt-out leaves the session-storage keys.
 * The opt-out choice itself stays.
 */
export function clearStoredAnalyticsIdentity(): void {
  const isPostHogKey = (key: string | null): key is string => !!key && key.startsWith('ph_');
  for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
    if (!storage) continue;
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (isPostHogKey(key)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    } catch (error) {
      console.warn('[analytics] could not clear stored analytics identifier', error);
    }
  }
  if (typeof document === 'undefined') return;
  try {
    const names = document.cookie.split(';').map((part) => part.split('=')[0]!.trim()).filter(isPostHogKey);
    if (names.length === 0) return;
    // PostHog scopes its cookie to the widest domain the browser accepts, which
    // is not always the last two labels (`.example.co.uk`). Expire it as a
    // host-only cookie and on every parent domain; the browser ignores the
    // ones it would never have accepted.
    const labels = (document.location?.hostname ?? '').split('.').filter(Boolean);
    const domains = [''];
    for (let i = 0; i < labels.length - 1; i++) domains.push(`; domain=.${labels.slice(i).join('.')}`);
    for (const name of names) {
      for (const domain of domains) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
      }
    }
  } catch (error) {
    console.warn('[analytics] could not clear analytics cookie', error);
  }
}
