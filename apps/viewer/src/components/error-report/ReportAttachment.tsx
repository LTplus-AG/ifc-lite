/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReportSession, UploadInput } from '@ifc-lite/report-contract';
import { useTranslation } from '@/i18n';
import type { ReportContext } from '@/lib/error-reports/context';
export interface AttachmentChoice {
  file?: File;
  visibility: 'private' | 'public';
  confidentiality: UploadInput['confidentiality'];
  uploadConsent: boolean;
  publicConfirmed: boolean;
  accepted: boolean;
  signerName: string;
  signerEmail: string;
  organization: string;
  customMessage: string;
}
export const emptyAttachment: AttachmentChoice = {
  visibility: 'private', confidentiality: 'none', uploadConsent: false, publicConfirmed: false,
  accepted: false, signerName: '', signerEmail: '', organization: '', customMessage: '',
};
export function validAttachment(choice: AttachmentChoice, session: ReportSession): boolean {
  if (!choice.file) return true;
  if (choice.file.size < 1 || choice.file.size > session.limits.maxFileBytes || !/\.(ifc|ifczip|ifcx)$/i.test(choice.file.name)) return false;
  if (choice.confidentiality === 'custom') return choice.visibility === 'private' && choice.customMessage.trim().length > 0;
  if (!choice.uploadConsent || (choice.visibility === 'public' && (!session.storage.publicSharingEnabled || !choice.publicConfirmed))) return false;
  return choice.confidentiality !== 'standard' || (choice.visibility === 'private' && session.agreement.signingEnabled && choice.accepted && !!choice.signerName.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(choice.signerEmail) && !!choice.organization.trim());
}
export function ReportAttachment({ context, session, value, onChange }: { context: ReportContext; session: ReportSession; value: AttachmentChoice; onChange: (next: AttachmentChoice) => void }) {
  const { t } = useTranslation();
  const patch = (next: Partial<AttachmentChoice>) => onChange({ ...value, ...next });
  return <fieldset className="space-y-3 rounded border p-3">
    <legend>{t('errorReport.attachment')}</legend>
    {context.sourceFile && <label className="block"><input type="checkbox" checked={value.file === context.sourceFile} onChange={event => patch({ file: event.target.checked ? context.sourceFile : undefined, uploadConsent: false, publicConfirmed: false })} /> {t('errorReport.useSource')}</label>}
    <label className="block">{t('errorReport.chooseFile')}<input className="block w-full" type="file" accept=".ifc,.ifczip,.ifcx" onChange={event => patch({ file: event.target.files?.[0], uploadConsent: false, publicConfirmed: false })} /></label>
    {value.file && (value.file.size < 1 || value.file.size > session.limits.maxFileBytes || !/\.(ifc|ifczip|ifcx)$/i.test(value.file.name)) && <p role="alert">{t('errorReport.invalidFile', { bytes: session.limits.maxFileBytes })}</p>}
    {value.file && <>
      <p className="break-all">{t('errorReport.source', { name: value.file.name, size: value.file.size })}</p>
      <button type="button" className="rounded border px-2 py-1" onClick={() => onChange({ ...emptyAttachment })}>{t('errorReport.removeModel')}</button>
      <label className="block"><input type="radio" name="model-visibility" checked={value.visibility === 'private'} onChange={() => patch({ visibility: 'private', publicConfirmed: false })} /> {t('errorReport.private')}</label>
      <label className="block"><input type="radio" name="model-visibility" disabled={!session.storage.publicSharingEnabled} checked={value.visibility === 'public'} onChange={() => patch({ visibility: 'public', confidentiality: 'none', accepted: false })} /> {t('errorReport.public')}</label>
      {!session.storage.publicSharingEnabled && <p>{t('errorReport.publicUnavailable')}</p>}
      <p>{t(value.visibility === 'private' ? 'errorReport.privateHelp' : 'errorReport.publicHelp')}</p>
      {value.visibility === 'public' && <label className="block"><input type="checkbox" checked={value.publicConfirmed} onChange={event => patch({ publicConfirmed: event.target.checked })} /> {t('errorReport.publicConsent')}</label>}
      {value.visibility === 'private' && <>
        <label className="block">{t('errorReport.nda')}<select className="block w-full border bg-background" value={value.confidentiality} onChange={event => {
          const confidentiality = event.target.value;
          if (confidentiality === 'none' || confidentiality === 'standard' || confidentiality === 'custom') patch({ confidentiality, accepted: false });
        }}>
          <option value="none">{t('errorReport.noNda')}</option>
          <option value="standard" disabled={!session.agreement.signingEnabled}>{t('errorReport.standardNda')}</option>
          <option value="custom">{t('errorReport.customOption')}</option>
        </select></label>
        {!session.agreement.signingEnabled && <p>{t('errorReport.ndaDisabled')}</p>}
      </>}
      {value.confidentiality === 'standard' && <>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap border p-2">{session.agreement.text}</pre>
        <label className="block">{t('errorReport.signer')}<input className="block w-full border bg-background" maxLength={200} autoComplete="name" value={value.signerName} onChange={event => patch({ signerName: event.target.value })} /></label>
        <label className="block">{t('errorReport.email')}<input className="block w-full border bg-background" type="email" maxLength={254} autoComplete="email" value={value.signerEmail} onChange={event => patch({ signerEmail: event.target.value })} /></label>
        <label className="block">{t('errorReport.organization')}<input className="block w-full border bg-background" maxLength={200} autoComplete="organization" value={value.organization} onChange={event => patch({ organization: event.target.value })} /></label>
        <label className="block"><input type="checkbox" checked={value.accepted} onChange={event => patch({ accepted: event.target.checked })} /> {t('errorReport.accept')}</label>
      </>}
      {value.confidentiality === 'custom' ? <label className="block">{t('errorReport.customContact')}<textarea className="block w-full border bg-background" maxLength={4000} value={value.customMessage} onChange={event => patch({ customMessage: event.target.value })} /></label> : <label className="block"><input type="checkbox" checked={value.uploadConsent} onChange={event => patch({ uploadConsent: event.target.checked })} /> {t('errorReport.uploadConsent')}</label>}
      <p>{t('errorReport.hosting', { provider: session.storage.provider, location: session.storage.location })}</p>
      <p>{session.storage.backupDisclosure}</p>
      <p>{t('errorReport.deletion', { days: session.storage.deletionDays })}</p>
      <p>{t('errorReport.retention', { days: session.limits.retentionDays })}</p>
    </>}
  </fieldset>;
}
