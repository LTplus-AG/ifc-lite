/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PageFrameItem } from '@/lib/document/compose-page-frame';
import { DOCUMENT_FONT_FAMILIES } from '@/lib/document/text-typography';
import { previewTextPaint } from './preview-theme';
import type { PreviewImageSize } from './useDocumentLayout';

/** Only paints the canonical frame; it never measures or paginates. */
export function ComposedPageFrame({ items, scale, pending, preparing, imageError, failures, onImageSize, onImageError }:
  { items: PageFrameItem[]; scale: number; pending: boolean; preparing: string; imageError: string; failures: ReadonlySet<string>;
    onImageSize: (url: string, size: PreviewImageSize) => void; onImageError: (url: string) => void }) {
  return <>{items.map((item, index) => {
    if (item.kind === 'image' && failures.has(item.dataUrl)) return <span key={index} data-page-logo={item.band}
      className="flex items-center justify-center border border-dashed border-neutral-300 text-xs text-neutral-500"
      style={{ position: 'absolute', left: item.x * scale, top: item.y * scale, width: item.w * scale, height: item.h * scale }}>
      {imageError}</span>;
    if (item.kind === 'image') return <img key={`${index}:${item.dataUrl}`} src={item.dataUrl} alt="" data-page-logo={item.band}
      style={{ position: 'absolute', left: item.x * scale, top: item.y * scale, width: item.w * scale, height: item.h * scale }}
      onLoad={event => {
        const { naturalWidth: w, naturalHeight: h } = event.currentTarget;
        if (w > 0 && h > 0) onImageSize(item.dataUrl, { w, h });
        else onImageError(item.dataUrl);
      }}
      onError={() => onImageError(item.dataUrl)} />;
    const paint = previewTextPaint(item.gray, item.color);
    return <div key={index} data-page-heading={item.band === 'heading' && item.role === 'text' ? '' : undefined}
      data-page-footer={item.band === 'footer' && item.role === 'text' ? '' : undefined}
      data-page-counter={item.role === 'counter' ? item.band : undefined} data-page-date={item.role === 'date' ? item.band : undefined}
      className={paint.className} title={item.text} style={{ position: 'absolute', left: item.x * scale, top: (item.y - item.size) * scale,
        fontFamily: DOCUMENT_FONT_FAMILIES[item.font], fontSize: item.size * scale, lineHeight: 1.25, whiteSpace: 'pre', color: paint.color }}>
      {pending && item.role === 'counter' ? preparing : item.text}
    </div>;
  })}</>;
}
