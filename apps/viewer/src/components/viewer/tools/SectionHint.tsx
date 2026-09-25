/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section tool's one hint line (#5500, charter #5478 §6): a `HudHint`
 * in the HUD's bottom-center region — bare ink text, no card — replacing
 * the black hint strip with its hard offset shadow. It says what the next
 * gesture is (hover/click while a face pick is armed, scrub the distance
 * while cutting, drag a face handle in box mode, turn Cut on while off); the numbers live on the bar, not
 * here. Rendered by the `section` row's `Scene` because the text depends on
 * store state, which the table's static `hint` key cannot express.
 */

import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { HudHint, HudItem } from '../../viewport-ui/hud';

export function SectionHint() {
  const { t } = useTranslation();
  const key = useViewerStore((s) =>
    s.sectionPickMode ? 'sectionTool.hint.pick'
      : !s.sectionPlane.enabled ? 'sectionTool.hint.off'
        : s.sectionPlane.box ? 'sectionTool.hint.box'
          : 'sectionTool.hint.cut',
  );
  return (
    <HudItem region="bottom-center" order={1}>
      <HudHint>{t(key)}</HudHint>
    </HudItem>
  );
}
