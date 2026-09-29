/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's Hosting section (charter #6232, M2 §1.7.4): a door
 * or window's host wall, "Select host", and its offset along the wall and
 * sill. A placeholder until hosted placement lands (M2.6), which owns the
 * host lookup and the offset / sill writes.
 */

import { useTranslation } from '@/i18n';
import { InspectorCaption, InspectorSection } from './InspectorControls';

export function HostingSection() {
  const { t } = useTranslation();
  return (
    <InspectorSection title={t('modelInspector.hosting.title')}>
      <InspectorCaption>{t('modelInspector.hosting.pending')}</InspectorCaption>
    </InspectorSection>
  );
}
