/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The volatile context block of a run: the document summary and the user's
 * attachments. It is built ONCE at the start of a run and sent unchanged
 * with every request, after the cached prefix (tools, system prompt), so
 * the conversation stays append-only. The model reads later document state
 * through `ids_read`.
 *
 * Attachment text is untrusted: it is fenced and labelled as data so the
 * model treats instructions inside it as content (prompt-injection guard,
 * `06-ai-agent.md` §6.7).
 */

import type { StudioDocument } from '@ifc-lite/ids-authoring';
import type { ContextPart } from './privacy.js';
import { summarizeDocument } from '../tools/ids-read.js';

export interface Attachment {
  /** Shown to the model as a label; never a file path. */
  label: string;
  text: string;
}

/** Strip anything that could close the data fence early. */
function fenced(text: string): string {
  return text.replace(/<\/?untrusted_data[^>]*>/gi, '[tag removed]');
}

export function buildContext(doc: StudioDocument, attachments: readonly Attachment[]): ContextPart[] {
  const parts: ContextPart[] = [{
    source: 'document',
    label: 'Document summary',
    text: `Current IDS document (node ids for ops; read details with ids_read):\n${JSON.stringify(summarizeDocument(doc))}`,
  }];
  attachments.forEach((a, i) => parts.push({
    source: 'attachments',
    label: a.label || `Attachment ${i + 1}`,
    text: `<untrusted_data source="attachment ${i + 1}" label="${a.label.replace(/["<>]/g, '')}">\n${fenced(a.text)}\n</untrusted_data>`,
  }));
  return parts;
}

export function joinContext(parts: readonly ContextPart[]): string {
  return parts.map((p) => p.text).join('\n\n');
}
