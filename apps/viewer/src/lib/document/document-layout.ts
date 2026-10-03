/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReportDoc } from '../export/report/generate-report-pdf.js';
import { composeDocument, estimateTextWidth, type ComposeDocumentInput, type ResolvedBlock } from './compose.js';
import type { DocumentSpec } from './types.js';
import { pageBandImageAspects } from './page-band.js';
import type { DocumentLabelFormatter } from './document-labels.js';

/** PDF standard-font metrics shared by the composed preview and printed pages (#6610). */
export function documentTextMeasure(doc: Pick<ReportDoc, 'setFont' | 'setFontSize' | 'textWidth'>): ComposeDocumentInput['measure'] {
  return (text, size, bold, font = 'helvetica') => {
    if (!doc.textWidth) return estimateTextWidth(text, size, bold);
    doc.setFont(font, bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    return doc.textWidth(text);
  };
}

/** Both consumers paginate the same resolved blocks with the same document options. */
export function composeResolvedDocument(document: DocumentSpec, blocks: ResolvedBlock[],
  generatedAt: string, measure: ComposeDocumentInput['measure'], labels?: DocumentLabelFormatter, logoAspects?: ReadonlyMap<string, number>, stampedDate?: string) {
  return composeDocument({ name: document.name, pageHeading: document.pageHeading, pageFooter: document.pageFooter, logoAspects, stampedDate,
    page: document.page, blocks, generatedAt, measure, labels });
}

/** Frame and body assets share one decode/measurement seam. */
export { pageBandImageAspects };
