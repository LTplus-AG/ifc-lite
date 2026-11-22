/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CreateSurfaceMessage } from '@ifc-lite/a2ui';
import { useTranslation } from '@/i18n';

interface ScriptSurfacesProps {
  surfaces: CreateSurfaceMessage[][];
  onFollowUp?: (text: string, context: Record<string, unknown>) => void;
}

export function ScriptSurfaces({ surfaces }: ScriptSurfacesProps) {
  const { t } = useTranslation();
  if (!surfaces.length) return null;
  return (
    <details className="mt-1 border-t border-border/50 pt-1">
      <summary className="cursor-pointer">{t('scriptPanel.output.surfaces', { count: surfaces.length })}</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(surfaces, null, 2)}</pre>
    </details>
  );
}
