/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';

const KEY = 'ifc-lite-source-provider-pins';
/** Provider pins contain only public provider ids, never account or folder names. */
export function useSourceProviderPins() {
  const { t } = useTranslation();
  const [ids, setIds] = useState<readonly string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(0, 100) : [];
    } catch (error) {
      console.warn('[sources] Cannot restore provider pins', error);
      return [];
    }
  });
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
    if (next.length > 100) { toast.error(t('sources.workspace.pinFailed')); return; }
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      setIds(next);
    } catch (error) {
      console.warn('[sources] Cannot save provider pins', error);
      toast.error(t('sources.workspace.pinFailed'));
    }
  };
  return { ids, toggle };
}
