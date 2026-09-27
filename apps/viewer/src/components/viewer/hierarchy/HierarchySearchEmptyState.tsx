/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';

export function HierarchySearchEmptyState({ query, onClear }: { query: string; onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
      <output className="text-sm text-muted-foreground">{t('hierarchy.panel.noMatches', { query })}</output>
      <Button variant="outline" size="sm" onClick={onClear}>
        {t('hierarchy.panel.clearSearch')}
      </Button>
    </div>
  );
}
