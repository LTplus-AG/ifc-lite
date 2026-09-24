/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Info dialog's Preferences tab (#5509): Navigation → SpaceMouse today,
 * grows as more settings leave floating panels for here — each gets its own
 * labelled section like this one. Split out of `KeyboardShortcutsDialog.tsx`
 * to keep that file's module-size budget flat rather than raising it
 * (AGENTS.md prefers splitting to allowlisting).
 */

import { useTranslation } from '@/i18n';
import { SpaceMousePanel } from './SpaceMousePanel';

export function PreferencesTab() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">
        {t('keyboardShortcuts.preferences.navigationSectionTitle')}
      </h3>
      <div className="rounded-md border p-3">
        <h4 className="mb-2 text-xs font-semibold">
          {t('keyboardShortcuts.preferences.spaceMouseSectionTitle')}
        </h4>
        <SpaceMousePanel />
      </div>
    </div>
  );
}
