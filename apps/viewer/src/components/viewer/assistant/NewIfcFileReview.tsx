/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { prepareNewIfcFile, type NewIfcProposal, type NewIfcFileReview as PreparedFile } from '@/lib/actions/new-ifc-file';
export function NewIfcFileReview({ proposal }: { proposal: NewIfcProposal }) {
  const { t } = useTranslation(), [review, setReview] = useState<PreparedFile | null>(null), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string | null>(null), [downloaded, setDownloaded] = useState(false), [requested, setRequested] = useState(false);
  const owner = useRef({ active: true, generation: 0, review: null as PreparedFile | null });
  useEffect(() => { const current = owner.current; current.active = true; return () => { current.active = false; current.generation++; current.review = null; }; }, [proposal]);
  const prepare = async () => {
    const generation = ++owner.current.generation; setBusy(true); setProblem(null); setReview(null); owner.current.review = null; setDownloaded(false); setRequested(false);
    try { const next = await prepareNewIfcFile(proposal); if (!owner.current.active || owner.current.generation !== generation) return; owner.current.review = next; setReview(next); }
    catch (error) { console.warn('[Assistant] Native file preparation refused', error); if (owner.current.active && owner.current.generation === generation) setProblem(error instanceof Error ? error.message : String(error)); }
    finally { if (owner.current.active && owner.current.generation === generation) setBusy(false); }
  };
  const publish = (load: boolean) => {
    if (!owner.current.active || !review || owner.current.review !== review) return;
    try { if (load) { review.requestPrimaryLoad(); setRequested(true); } else { review.download(); setDownloaded(true); } setProblem(null); }
    catch (error) { console.warn('[Assistant] Reviewed file publication refused', error); setProblem(error instanceof Error ? error.message : String(error)); }
  };
  return <section aria-label={t('newIfc.title')} className="mx-3 my-2 rounded border border-border p-3 text-xs space-y-2">
    <h3 className="font-medium">{proposal.title}</h3><p>{t('newIfc.scope')}</p><p>{t('newIfc.noUndo')}</p>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void prepare()}>{t(busy ? 'newIfc.preparing' : 'newIfc.prepare')}</Button>
    {review && <><output className="block">{t('newIfc.preview', { name: review.filename, bytes: review.byteLength, count: review.entityCount, schema: review.proposal.project.Schema, unit: review.proposal.project.LengthUnit })}</output>
      <details><summary>{t('newIfc.defaults')}</summary><pre className="whitespace-pre-wrap">{JSON.stringify(review.roots, null, 2)}</pre></details>
      <details><summary>{t('newIfc.content')}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{review.content}</pre></details>
      <Button size="sm" disabled={downloaded} onClick={() => publish(false)}>{t('newIfc.download')}</Button>
      <p>{t('newIfc.loadWarning')}</p><Button size="sm" variant="outline" disabled={requested} onClick={() => publish(true)}>{t('newIfc.requestLoad')}</Button>
    </>}
    {downloaded && <output className="block">{t('newIfc.downloaded')}</output>}{requested && <output className="block">{t('newIfc.requested')}</output>}{problem && <p role="alert">{problem}</p>}
  </section>;
}
