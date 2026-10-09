/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Inspector for the document node (IDS-032): the IDS `<info>` block, one `doc.setInfo` op per committed field. */

import type { InfoField, StudioDocument } from '@ifc-lite/ids-authoring';
import { useTranslation, type TranslationKey } from '@/i18n';
import { setInfoOp } from '@/lib/ids-studio/ops';
import { CommitInput } from './CommitInput';
import { NodeDiagnostics } from './NodeDiagnostics';
import { useStudioDispatch } from './useStudio';

const FIELDS: ReadonlyArray<{ field: InfoField; label: TranslationKey; hint?: TranslationKey; multiline?: boolean; type?: 'email' | 'date' }> = [
  { field: 'title', label: 'idsStudio.info.title' },
  { field: 'description', label: 'idsStudio.info.description', multiline: true },
  { field: 'purpose', label: 'idsStudio.info.purpose' },
  { field: 'milestone', label: 'idsStudio.info.milestone', hint: 'idsStudio.info.milestoneHint' },
  { field: 'author', label: 'idsStudio.info.author', hint: 'idsStudio.info.authorHint', type: 'email' },
  { field: 'date', label: 'idsStudio.info.date', type: 'date' },
  { field: 'version', label: 'idsStudio.info.version' },
  { field: 'copyright', label: 'idsStudio.info.copyright' },
];

export function DocumentInfoEditor({ doc }: { doc: StudioDocument }) {
  const { t } = useTranslation();
  const dispatch = useStudioDispatch();
  const info = doc.ids.info;
  return <section aria-label={t('idsStudio.info.heading')} className="space-y-2">
    <h3 className="text-xs font-semibold">{t('idsStudio.info.heading')}</h3>
    <p className="text-2xs text-muted-foreground">{t('idsStudio.info.explain')}</p>
    {FIELDS.map(({ field, label, hint, multiline, type }) => <CommitInput key={field} label={t(label)} hint={hint ? t(hint) : undefined}
      multiline={multiline} type={type} value={info[field] ?? ''} onCommit={(value) => dispatch([setInfoOp(field, value)])} />)}
    <NodeDiagnostics nodeId={doc.nodes.document} />
  </section>;
}
