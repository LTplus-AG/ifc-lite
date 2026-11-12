/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { useTranslation } from '@/i18n';
import { updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import type { MirrorGesture } from '@/lib/commands/modeling/commands/element-mirror';

export function MirrorBar({ gesture, measuring }: CommandHudProps<MirrorGesture>) {
  const { t } = useTranslation();
  return <label className="flex items-center gap-2">
    <input id={measuring ? undefined : "mirror-keep-original"} tabIndex={measuring ? -1 : undefined} type="checkbox" checked={gesture.copy}
      onChange={event => updateCommandGesture(g => ({ ...(g as MirrorGesture), copy: event.target.checked }))} />
    {t('moveRotate.mirror.keepOriginal')}
  </label>;
}
