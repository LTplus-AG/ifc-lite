/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n';

export function BCFAuthorDialog({ value, onChange, onCancel, onSave }: {
  value: string; onChange: (value: string) => void; onCancel: () => void; onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 bg-background/90 flex items-center justify-center p-4">
      <div className="bg-card border rounded-lg p-4 w-full max-w-xs">
        <h4 className="font-medium mb-3">{t('bcf.panel.setAuthorHeading')}</h4>
        <Input aria-label={t('bcf.panel.authorEmailLabel')}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={t('bcf.shared.emailPlaceholder')}
          className="mb-4"
        />
        <div className="flex gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={onCancel}>{t('bcf.shared.cancel')}</Button>
          <Button size="sm" onClick={onSave}>{t('bcf.shared.save')}</Button>
        </div>
      </div>
    </div>
  );
}
