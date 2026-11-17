/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The EPSG area of use (#10398) as the Georeference panel shows it: in the
 * EPSG lookup results and in the out-of-area warning (#10608). The extents
 * themselves are a lazily loaded module of `@ifc-lite/data`, fetched the
 * first time a box is asked for.
 */

import { useEffect, useState } from 'react';
import { getEpsgAreaOfUse, type EpsgAreaOfUse } from '@ifc-lite/data';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

type Translate = ReturnType<typeof useTranslation>['t'];

/** Signed decimal degrees, west to east (west > east crosses the antimeridian, as EPSG writes it). */
export function formatAreaOfUse(t: Translate, locale: string, area: Pick<EpsgAreaOfUse, 'west' | 'south' | 'east' | 'north'>): string {
  const deg = (value: number) => formatLocaleNumber(locale, value, { maximumFractionDigits: 2 });
  return t('properties.georef.areaOfUse', { west: deg(area.west), east: deg(area.east), south: deg(area.south), north: deg(area.north) });
}

/** The primary area of use of an EPSG code; undefined while loading and for a code without one. */
export function useEpsgAreaOfUse(code: string | number | undefined): EpsgAreaOfUse | undefined {
  const [loaded, setLoaded] = useState<{ code: string | number; area: EpsgAreaOfUse | undefined }>();
  useEffect(() => {
    if (code === undefined) return;
    let live = true;
    getEpsgAreaOfUse(code).then(
      (area) => { if (live) setLoaded({ code, area }); },
      (error) => { console.warn('[EPSG Lookup] Area of use unavailable', error); },
    );
    return () => { live = false; };
  }, [code]);
  return loaded && loaded.code === code ? loaded.area : undefined;
}

/** One muted line with the code's area of use; nothing while it loads or when EPSG has none. */
export function EpsgAreaOfUseLine({ code }: { code: string }) {
  const { t, locale } = useTranslation();
  const area = useEpsgAreaOfUse(code);
  if (!area) return null;
  return <div className="mt-0.5 text-xs text-muted-foreground truncate">{formatAreaOfUse(t, locale, area)}</div>;
}
