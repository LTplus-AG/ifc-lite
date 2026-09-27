/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';

/** How long a copy button shows its tick after a successful copy. */
const COPIED_FEEDBACK_MS = 1500;

/**
 * The Properties panel's one clipboard path (#5900): the GlobalId, the
 * coordinate rows and every attribute / property / quantity value copy through
 * here. It writes the text, flags which button copied (`copiedKey`, for the
 * transient tick), and confirms through the toast's polite live region so a
 * screen reader hears the copy too. A refused write (no clipboard permission,
 * an insecure context) says so instead of ticking.
 */
export function useCopyValue(): { copiedKey: string | null; copy: (text: string, key?: string) => void } {
  const { t } = useTranslation();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback((text: string, key = 'value') => {
    const fail = (error: unknown) => {
      console.warn('[properties] clipboard write failed', error);
      toast.error(t('properties.copy.failed'));
    };
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) return fail(new Error('Clipboard API unavailable'));
    clipboard.writeText(text).then(() => {
      if (timer.current) clearTimeout(timer.current);
      setCopiedKey(key);
      timer.current = setTimeout(() => setCopiedKey(null), COPIED_FEEDBACK_MS);
      toast.success(t('properties.copy.copied'));
    }, fail);
  }, [t]);

  return { copiedKey, copy };
}
