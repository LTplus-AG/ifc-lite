/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Settings → Collaboration: the identity already used by live presence. */

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n';
import { MAX_COLLAB_DISPLAY_NAME_LENGTH, normalizeCollabDisplayName } from '@/lib/collab/identity';
import { useViewerStore } from '@/store';
import { SettingsGroup } from './SettingsGroup';

export function CollaborationSection() {
  const { t } = useTranslation();
  const name = useViewerStore((state) => state.collabIdentity.name);
  const setCollabIdentity = useViewerStore((state) => state.setCollabIdentity);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  const normalized = normalizeCollabDisplayName(draft);
  const empty = normalized === null;
  const canSave = normalized !== null && normalized !== name;

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (normalized !== null) setCollabIdentity({ name: normalized });
  };

  return (
    <SettingsGroup title={t('settings.collaboration.identityTitle')}>
      <form onSubmit={save} className="space-y-2">
        <label htmlFor="settings-collab-name" className="block text-sm font-medium">
          {t('settings.collaboration.displayName')}
        </label>
        <p id="settings-collab-name-hint" className="text-xs text-muted-foreground">
          {t('settings.collaboration.displayNameHint')}
        </p>
        <div className="flex items-center gap-2">
          <Input
            id="settings-collab-name"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={MAX_COLLAB_DISPLAY_NAME_LENGTH}
            aria-describedby="settings-collab-name-hint"
            aria-invalid={empty}
          />
          <Button type="submit" disabled={!canSave} className="shrink-0">
            {t('settings.collaboration.saveName')}
          </Button>
        </div>
        {empty && <p role="alert" className="text-xs text-destructive">{t('settings.collaboration.emptyName')}</p>}
      </form>
    </SettingsGroup>
  );
}
