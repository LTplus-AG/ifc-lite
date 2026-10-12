/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { rememberReport } from '@/lib/error-reports/pending';
import type { AgreementAcceptanceInput, AgreementReceipt, ModelUpload, ReportDraftInput, ReportReceipt, UploadInput } from '@ifc-lite/report-contract';
import { ReportClient } from './client';
import { uploadModel } from './upload';
export interface ReviewedReport {
  draft: ReportDraftInput;
  file?: File;
  confidentiality: UploadInput['confidentiality'];
  publicModelConfirmed: boolean;
  acceptance?: AgreementAcceptanceInput;
  customNdaMessage?: string;
}
/** Retains one immutable review across transport retries; never creates a second issue. */
export class ReportSubmission {
  receipt?: ReportReceipt;
  agreementReceipt?: AgreementReceipt;
  private upload?: ModelUpload;
  private started = false;
  constructor(readonly reviewed: ReviewedReport, private readonly client: ReportClient, existing?: ReportReceipt) {
    this.receipt = existing; this.upload = existing?.upload;
  }
  async send(signal: AbortSignal, progress: (done: number) => void): Promise<ReportReceipt> {
    this.started = true;
    const review = this.reviewed;
    if (!this.receipt) this.receipt = await this.client.request<ReportReceipt>('/drafts', 'POST', review.draft, signal);
    rememberReport(this.receipt.id);
    const path = `/${encodeURIComponent(this.receipt.id)}`;
    if (review.confidentiality === 'custom' && review.file && this.receipt.customNdaStatus !== 'approved') {
      this.receipt = await this.client.request<ReportReceipt>(`${path}/custom-nda`, 'POST', { message: review.customNdaMessage ?? 'Please contact me to arrange a custom NDA before any model upload.' }, signal);
      if (this.receipt.status !== 'manual_review') throw new Error('The NDA request was not accepted for review');
      return this.receipt;
    }
    if (review.file) {
      if (review.confidentiality === 'standard' && !this.agreementReceipt && !this.receipt.agreementAccepted) {
        if (!review.acceptance) throw new Error('Accept the displayed agreement before uploading');
        this.agreementReceipt = await this.client.request<AgreementReceipt>(`${path}/consent`, 'POST', review.acceptance, signal);
        if (this.agreementReceipt.agreementSha256 !== review.acceptance.agreementSha256) throw new Error('The accepted agreement does not match your review');
      }
      if (!this.upload) this.upload = await this.client.request<ModelUpload>(`${path}/uploads`, 'POST', {
        name: review.file.name, size: review.file.size, type: 'application/octet-stream',
        confidentiality: review.confidentiality, uploadConsent: true, publicModelConfirmed: review.publicModelConfirmed,
      } satisfies UploadInput, signal);
      await uploadModel(this.client, this.receipt.id, this.upload, review.file, signal, progress);
    }
    this.receipt = await this.client.request<ReportReceipt>(`${path}/submit`, 'POST', { publicModelConfirmed: review.publicModelConfirmed }, signal);
    if (!['submitted', 'published'].includes(this.receipt.status)) throw new Error('The report is not yet submitted');
    rememberReport(this.receipt.status === 'published' ? undefined : this.receipt.id);
    return this.receipt;
  }
  async cancel(): Promise<void> {
    // Reconcile a lost create response by its idempotency key before deleting.
    if (this.started && !this.receipt) this.receipt = await this.client.request<ReportReceipt>('/drafts', 'POST', this.reviewed.draft);
    if (this.receipt && !['submitted', 'published', 'deleted'].includes(this.receipt.status)) {
      await this.client.request(`/${encodeURIComponent(this.receipt.id)}`, 'DELETE');
    }
    rememberReport(undefined);
  }
}
