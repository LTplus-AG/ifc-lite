/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Input surface for the custom 3D Tiles URL (issue #3607).
 *
 * Lives under the Base map selector in the Environment panel, shown only when
 * the `custom-3dtiles` source is picked. One field: this build validates only
 * the URL's shape (http(s), no embedded credentials) — whether it actually
 * resolves to a tileset is a runtime concern surfaced by `CesiumOverlay`'s
 * `basemapWarning` once the layer attempts to load, the same way the custom
 * XYZ basemap's CORS problems surface at render time rather than at Save.
 */

import { useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { validateTilesetUrl } from '@/lib/geo/custom-3dtiles';

const FIELD_CLASS = 'w-full bg-muted/40 rounded px-1.5 py-1 border text-foreground text-2xs';
const LABEL_CLASS = 'text-2xs uppercase tracking-wider text-muted-foreground';

export function CustomTilesetEditor() {
  const { t } = useTranslation();
  const stored = useViewerStore((s) => s.cesiumCustomTilesetUrl);
  const saveUrl = useViewerStore((s) => s.setCesiumCustomTilesetUrl);

  const [url, setUrl] = useState(stored ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const onSave = () => {
    const result = validateTilesetUrl(url);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setProblem(null);
    saveUrl(result.url);
  };

  const onRemove = () => {
    saveUrl(null);
    setProblem(null);
  };

  return (
    <div className="flex flex-col gap-1 pt-1 border-t">
      <label className="flex flex-col gap-0.5">
        <span className={LABEL_CLASS}>{t('cesiumGeo.tileset.urlLabel')}</span>
        <input
          aria-label={t('cesiumGeo.tileset.urlLabel')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('cesiumGeo.tileset.urlPlaceholder')}
          spellCheck={false}
          className={FIELD_CLASS}
        />
      </label>

      {/* Privacy, same disclosure as the XYZ basemap: a custom tileset sends
          the viewport to a third party on every pan. */}
      <p className="text-2xs leading-tight text-muted-foreground">
        {t('cesiumGeo.tileset.privacyNote')}
      </p>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onSave}
          className="px-2 py-0.5 rounded text-2xs font-semibold uppercase bg-primary text-primary-foreground"
        >
          {t('cesiumGeo.tileset.saveButton')}
        </button>
        {stored && (
          <button
            type="button"
            onClick={onRemove}
            className="px-2 py-0.5 rounded text-2xs uppercase text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t('cesiumGeo.shared.removeButton')}
          </button>
        )}
      </div>

      {problem && (
        <p role="alert" className="text-2xs leading-tight text-red-400">{problem}</p>
      )}
    </div>
  );
}
