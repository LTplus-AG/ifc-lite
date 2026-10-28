/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settings → Performance: which geometry kernel the next load uses (#7955 M2).
 * Mounted only through the retained module, so it exists only in a
 * `VITE_RETAINED_GEOMETRY=on` build. Deliberately not called "exact mode":
 * that name belongs to the fast/exact fidelity switch.
 */

import { useState } from 'react';
import { registerEnglish, useTranslation } from '@/i18n';
import { retainedGeometryEn } from '@/i18n/catalogues/retained-geometry.en';
import { chooseGeometryKernel, requestedGeometryKernel, type GeometryKernel } from '@/store/geometryKernel';
import { SettingsChoice, SettingsGroup, SettingsRow } from './SettingsGroup';

registerEnglish(retainedGeometryEn);

export function GeometryKernelSetting() {
  const { t } = useTranslation();
  const [kernel, setKernel] = useState<GeometryKernel>(() => requestedGeometryKernel());
  return (
    <SettingsGroup title={t('retainedGeometry.setting.title')}>
      <SettingsRow label={t('retainedGeometry.setting.title')} hint={t('retainedGeometry.setting.hint')}>
        <SettingsChoice<GeometryKernel>
          id="settings-geometry-kernel"
          label={t('retainedGeometry.setting.title')}
          value={kernel}
          options={[
            { value: 'exact', label: t('retainedGeometry.setting.exact') },
            { value: 'retained', label: t('retainedGeometry.setting.retained') },
          ]}
          onChange={(next) => { chooseGeometryKernel(next); setKernel(next); }}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
