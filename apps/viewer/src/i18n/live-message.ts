/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey, UseTranslationResult } from '@/i18n';

/**
 * A UI message set from an async callback is either a catalogue key —
 * re-translated on every render so a later locale switch updates it — or raw
 * runtime text such as a provider exception's `.message`. Storing the
 * resolved catalogue string would lose that distinction and freeze it in the
 * locale active when the callback ran (#4918 slice 5b review).
 */
export type LiveTranslationMessage =
  | { key: TranslationKey; params?: Record<string, string | number> }
  | { text: string };

/** Resolve against the current locale from render; never cache the result. */
export function resolveLiveMessage(
  t: UseTranslationResult['t'],
  msg: LiveTranslationMessage | null,
): string {
  if (!msg) return '';
  return 'key' in msg ? t(msg.key, msg.params) : msg.text;
}
