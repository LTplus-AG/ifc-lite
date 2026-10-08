/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plain-language list of what a layout migration or profile import changed
 * (#6927). Shared by the sidebar's review notice and the profile import
 * preview, so both explain the same rule the same way.
 */

import { useTranslation, type UseTranslationResult } from '@/i18n';
import { layoutChangeKey, type LayoutChange } from '@/lib/panels/layout-migration';
import { panelTitleKey, type WorkspacePanelId } from '@/lib/panels/registry';

type Translate = UseTranslationResult['t'];

export function describeLayoutChange(change: LayoutChange, t: Translate): string {
  const title = (id: WorkspacePanelId) => t(panelTitleKey(id));
  switch (change.kind) {
    case 'added':
      return change.after
        ? t('workspaceMigration.layout.added', { panel: title(change.id), anchor: title(change.after) })
        : t('workspaceMigration.layout.addedTop', { panel: title(change.id) });
    case 'renamed': return t('workspaceMigration.layout.renamed', { from: change.from, panel: title(change.to) });
    case 'restored': return t('workspaceMigration.layout.restored', { panel: title(change.id) });
    case 'preserved': return t('workspaceMigration.layout.preserved', { id: change.id });
    case 'regrouped': return t('workspaceMigration.layout.regrouped');
    case 'mode': return t('workspaceMigration.layout.mode');
    case 'unreadable': return t('workspaceMigration.layout.unreadable');
  }
}

export function LayoutChangeList({ changes }: { changes: readonly LayoutChange[] }) {
  const { t } = useTranslation();
  return <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
    {changes.map((change) => <li key={layoutChangeKey(change)}>{describeLayoutChange(change, t)}</li>)}
  </ul>;
}
