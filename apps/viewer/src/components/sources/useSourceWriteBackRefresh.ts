/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState } from 'react';
import { SOURCE_WRITEBACK_SAVED_EVENT } from '@/services/sources/source-writeback-command';

/** Refresh the open source after a confirmed write, without interrupting its download. */
export function useSourceWriteBackRefresh({ providerId, projectId, busy, onRefresh }: {
  providerId: string; projectId: string | undefined; busy: boolean; onRefresh: () => void;
}) {
  const [pending, setPending] = useState<{ providerId: string; projectId: string } | null>(null);
  useEffect(() => {
    const saved = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      if (detail && typeof detail === 'object' && 'providerId' in detail && 'projectId' in detail &&
          detail.providerId === providerId && detail.projectId === projectId && projectId !== undefined) setPending({ providerId, projectId });
    };
    window.addEventListener(SOURCE_WRITEBACK_SAVED_EVENT, saved);
    return () => window.removeEventListener(SOURCE_WRITEBACK_SAVED_EVENT, saved);
  }, [providerId, projectId]);
  useEffect(() => {
    if (!pending) return;
    if (pending.providerId !== providerId || pending.projectId !== projectId) { setPending(null); return; }
    if (busy) return;
    setPending(null);
    onRefresh();
  }, [pending, providerId, projectId, busy, onRefresh]);
}
