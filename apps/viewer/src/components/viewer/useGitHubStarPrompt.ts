/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTourStore } from '@/lib/tours/tour-store';

const KEY = 'ifc-lite:github-star';
const DAY = 86_400_000;
const ACTIVE_TIME = 120_000;
const QUIET_TIME = 5_000;

/** Fail closed: a promotional prompt must never repeat because storage failed. */
function readVisit(): number | null {
  const value = localStorage.getItem(KEY);
  if (value === null) {
    localStorage.setItem(KEY, String(Date.now()));
    return null;
  }
  const firstVisit = Number(value);
  return Number.isFinite(firstVisit) && firstVisit > 0 && Date.now() - firstVisit >= DAY
    ? firstVisit : null;
}

function viewerReady(): boolean {
  const s = useViewerStore.getState();
  return !s.isMobile && s.models.size > 0 && !s.loading && !s.geometryStreamingActive
    && !s.error && s.activeTool === 'select' && useTourStore.getState().status === 'idle';
}

function overlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [data-toast-seq]');
}

/** #8806: one durable impression, counted only in a focused, recently used viewer. */
export function useGitHubStarPrompt() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (window.self !== window.top) return;
    let eligible: number | null;
    try { eligible = readVisit(); } catch (error) {
      console.warn('[GitHubStarPrompt] Preferences unavailable; invitation suppressed.', error);
      return;
    }
    if (eligible === null) return;
    let lastInput = 0;
    let previous = performance.now();
    let active = 0;
    let pressed = false;
    let finished = false;
    let claiming = false;
    const input = () => { lastInput = performance.now(); };
    const down = () => { pressed = true; input(); };
    const up = () => { pressed = false; input(); };
    const blur = () => { pressed = false; lastInput = 0; };
    const changed = (event: StorageEvent) => {
      if (event.key === KEY) { finished = true; setVisible(false); }
    };
    const claim = async () => {
      // Web Locks serializes competing tabs. Without it, skip this optional UI.
      if (!navigator.locks) { finished = true; return; }
      claiming = true;
      try {
        await navigator.locks.request(KEY, () => {
          if (finished || !viewerReady() || overlayOpen() || !document.hasFocus()
            || document.visibilityState !== 'visible' || pressed
            || performance.now() - lastInput < QUIET_TIME || performance.now() - lastInput > 30_000) return;
          if (localStorage.getItem(KEY) !== String(eligible)) { finished = true; return; }
          localStorage.setItem(KEY, 'shown');
          finished = true;
          setVisible(true);
        });
      } catch (error) {
        finished = true;
        console.warn('[GitHubStarPrompt] Could not persist invitation; suppressed.', error);
      } finally { claiming = false; }
    };
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min(now - previous, 1000);
      previous = now;
      const ready = viewerReady() && !overlayOpen() && document.hasFocus()
        && document.visibilityState === 'visible';
      if (finished) { if (!ready) setVisible(false); return; }
      if (!ready || !lastInput || now - lastInput > 30_000) return;
      active += elapsed;
      if (active >= ACTIVE_TIME && now - lastInput >= QUIET_TIME && !pressed && !claiming) void claim();
    }, 1000);
    window.addEventListener('pointermove', input);
    window.addEventListener('keydown', input);
    window.addEventListener('wheel', input, { passive: true });
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', blur);
    window.addEventListener('storage', changed);
    return () => {
      finished = true;
      clearInterval(timer);
      window.removeEventListener('pointermove', input);
      window.removeEventListener('keydown', input);
      window.removeEventListener('wheel', input);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('storage', changed);
    };
  }, []);
  return { visible, dismiss: () => setVisible(false) };
}
