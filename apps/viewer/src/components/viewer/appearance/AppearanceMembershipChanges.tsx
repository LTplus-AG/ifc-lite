/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { reviewRestoredAssignment } from '@/lib/appearance/assignments/restore.js';
import { useTranslation } from '@/i18n';
type Review = Awaited<ReturnType<typeof reviewRestoredAssignment>>;
/** Changed membership remains inspectable without mounting thousands of rows. */
export function AppearanceMembershipChanges({ review }: { review: Review }) {
  const { t, revision } = useTranslation();
  const [page, setPage] = useState(0);
  const changes = useMemo(() => [
    ...review.changes.added.map(GlobalId => t('appearance.membershipChanges.added', { GlobalId })),
    ...review.changes.removed.map(GlobalId => t('appearance.membershipChanges.removed', { GlobalId })),
    ...review.changes.renumbered.map(item => t('appearance.membershipChanges.renumbered', item)),
  ], [review, t, revision]);
  const last = Math.max(0, Math.ceil(changes.length / 50) - 1), current = Math.min(page, last);
  if (!changes.length) return null;
  return <details className="text-2xs">
    <summary>{t('appearance.membershipChanges.summary')}</summary>
    <ul className="my-2 max-h-40 space-y-1 overflow-y-auto break-all">
      {changes.slice(current * 50, (current + 1) * 50).map(change => <li key={change}>{change}</li>)}
    </ul>
    {last > 0 && <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" disabled={!current} onClick={() => setPage(current - 1)}>{t('appearance.membershipChanges.previous')}</Button>
      <span>{current + 1} / {last + 1}</span>
      <Button variant="ghost" size="sm" disabled={current === last} onClick={() => setPage(current + 1)}>{t('appearance.membershipChanges.next')}</Button>
    </div>}
  </details>;
}
