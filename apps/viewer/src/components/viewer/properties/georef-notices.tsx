/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read-only notices and the WKT row for `GeoreferencingPanel`, extracted so
 * that file stays within its size budget.
 */

import { Globe } from 'lucide-react';
import type { GeoreferenceInfo } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n';
import { GeorefRow } from './georef-rows';

/**
 * The exporter writes IfcProjectedCRS/IfcMapConversion edits only: an edit
 * beside an IfcRigidOperation would author a second coordinate operation on
 * the same context, and a renamed CRS would keep its IfcWellKnownText.
 */
export function isReadOnlyCoordinateOperation(georef: GeoreferenceInfo | null | undefined): boolean {
  return georef?.source === 'rigidOperation' || Boolean(georef?.projectedCRS?.wellKnownText);
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1.5 flex items-center gap-2 border-b border-zinc-100 dark:border-zinc-900">
      <Globe className="h-3 w-3 text-zinc-400 shrink-0" />
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{children}</span>
    </div>
  );
}

/**
 * `schemaNotice`: only flag the legacy-site / unsupported-schema state when
 * there is nothing extractable to show. With a projectedCRS or mapConversion
 * (even partial) the data sections speak for themselves, and a schema notice
 * would contradict the live data the properties panel already renders.
 */
export function GeorefReadOnlyNotices({ georef, schemaNotice }: {
  georef: GeoreferenceInfo | null | undefined;
  schemaNotice: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {schemaNotice && (
        <Notice>
          {georef?.source === 'siteLocation'
            ? t('properties.georef.legacySiteNotice')
            : t('properties.georef.unsupportedSchemaNotice')}
        </Notice>
      )}
      {isReadOnlyCoordinateOperation(georef) && <Notice>{t('properties.georef.coordinateOperationReadOnlyNotice')}</Notice>}
    </>
  );
}

/** `IfcWellKnownText` of the CRS: truncated in the row, in full behind a disclosure. */
export function WellKnownTextRow({ wkt }: { wkt: string | undefined }) {
  const { t } = useTranslation();
  if (!wkt) return null;
  if (wkt.length <= 96) return <GeorefRow label="WellKnownText" value={wkt} />;
  return (
    <>
      <GeorefRow label="WellKnownText" value={`${wkt.slice(0, 96)}…`} />
      <details className="px-3 py-1.5 text-xs">
        <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400">{t('properties.georef.showFullWellKnownText')}</summary>
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-2xs text-teal-700 dark:text-teal-400">{wkt}</pre>
      </details>
    </>
  );
}
