/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The formats a drop on the viewport opens, one row per family. Rows come
 * from `DROP_FORMAT_GROUPS`, the same definition the pickers and the drop
 * guard are built from, so the card cannot name a format that does not load
 * or leave out one that does.
 */

import { useTranslation } from '@/i18n';
import { DROP_FORMAT_GROUPS, type FileFormatGroup } from '@/services/supported-model-files';

/** `.las .laz`, or `LandXML (.xml)` where the extension does not name the format. */
function formatsText({ extensions, formatName }: FileFormatGroup): string {
  const list = extensions.join(' ');
  return formatName ? `${formatName} (${list})` : list;
}

export function WelcomeFormats() {
  const { t } = useTranslation();
  return (
    <dl data-welcome-formats="" className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs leading-relaxed text-muted-foreground">
      {DROP_FORMAT_GROUPS.map((group) => (
        <div key={group.labelKey} className="contents">
          <dt className="font-medium text-foreground">{t(group.labelKey)}</dt>
          <dd>{formatsText(group)}</dd>
        </div>
      ))}
    </dl>
  );
}
