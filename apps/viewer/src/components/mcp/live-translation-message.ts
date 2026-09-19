/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey, UseTranslationResult } from '@/i18n';

/**
 * A status/error message set from an async callback (a geometry-load phase,
 * a chat validation failure) is either a catalogue key — re-translated live
 * on every render, so a locale switch after the callback fired still
 * retranslates it — or raw text (an exception's own `.message`, which is
 * not UI copy and never a translation key). Storing the RESOLVED string
 * instead loses this distinction: `t()` runs once at call time, and a later
 * locale switch has nothing left to retranslate (#4918 slice 5b review).
 *
 * Shared by `PlaygroundViewer.tsx`'s phase HUD and `PlaygroundChat.tsx`'s
 * error banner — the same bug, found twice in review, fixed once here.
 */
export type LiveTranslationMessage =
  | { key: TranslationKey; params?: Record<string, string | number> }
  | { text: string };

/** Resolves a `LiveTranslationMessage` against the CURRENT locale — call
 *  from render, never cache the result. */
export function resolveLiveMessage(t: UseTranslationResult['t'], msg: LiveTranslationMessage | null): string {
  if (!msg) return '';
  return 'key' in msg ? t(msg.key, msg.params) : msg.text;
}
