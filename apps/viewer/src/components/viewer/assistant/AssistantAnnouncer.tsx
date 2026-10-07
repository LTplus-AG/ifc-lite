/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Restrained screen-reader announcements and answer focus (#6926).
 *
 * The streamed answer is NOT a live region: announcing each token makes a
 * screen reader read fragments for as long as the model writes. Instead one
 * polite status region says that a request started and, once, that it ended
 * (answer received or cancelled). Failures already announce through their
 * `role="alert"` message, so they are not repeated here.
 *
 * When an answer completes, focus moves to it only if focus would otherwise be
 * lost (the Send button became Cancel and then disappeared). Focus in the
 * composer, or anywhere else the user has moved it, is never taken.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from '@/i18n';
import { resolveLiveMessage, type LiveTranslationMessage } from '@/i18n/live-message';
import { useAssistant } from '@/lib/assistant/conversation';

function useRequestTransitions(onEnd: (answered: boolean) => void, onStart?: () => void): void {
  const status = useAssistant((s) => s.status);
  const count = useAssistant((s) => s.messages.length);
  const previous = useRef({ status, count });
  const handlers = useRef({ onEnd, onStart });
  handlers.current = { onEnd, onStart };
  useEffect(() => {
    const before = previous.current;
    previous.current = { status, count };
    if (before.status !== 'streaming' && status === 'streaming') handlers.current.onStart?.();
    else if (before.status === 'streaming' && status !== 'streaming') handlers.current.onEnd(count > before.count);
  }, [status, count]);
}

export function AssistantAnnouncer() {
  const { t } = useTranslation();
  const [message, setMessage] = useState<LiveTranslationMessage | null>(null);
  useRequestTransitions((answered) => {
    const { error } = useAssistant.getState();
    if (answered) setMessage({ key: 'assistantA11y.answered' });
    else setMessage(error ? null : { key: 'assistantA11y.cancelled' });
  }, () => setMessage({ key: 'assistantA11y.answering' }));
  return <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{resolveLiveMessage(t, message)}</div>;
}

/** Move focus to the newest answer when, and only when, focus would otherwise be lost. */
export function useAnswerFocus(scope: RefObject<HTMLElement | null>): void {
  useRequestTransitions((answered) => {
    if (!answered) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const answers = scope.current?.querySelectorAll<HTMLElement>('[data-assistant-answer]');
    answers?.[answers.length - 1]?.focus({ preventScroll: false });
  });
}
