/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
export type JournalAction = "delete" | "withdraw" | "remove-model";
export type JournalCheckpoint = { epoch: string; sequence: number; hash: string };
export type JournalIntent = JournalCheckpoint & { previous: string; reportId: string; action: JournalAction };
type Envelope = { payload: string; signature: string };
type StorageConfig = Pick<Config, "region" | "endpoint" | "forcePathStyle" | "accessKeyId" | "secretAccessKey" | "bucket">;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sameCheckpoint = (a: JournalCheckpoint, b: JournalCheckpoint) => a.epoch === b.epoch && a.sequence === b.sequence && a.hash === b.hash;
const ZERO = "0".repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function validCheckpoint(value: JournalCheckpoint): void {
  if (!value || !/^[a-f0-9]{64}$/.test(value.epoch) || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !/^[a-f0-9]{64}$/.test(value.hash))
    throw new Error("restore_checkpoint_invalid");
}
/** Dormant operational primitive. Neither a missing head nor an old DB is a
 * bootstrap signal. The independent checkpoint must come from outside the DB
 * being restored; this object store alone cannot prove its own rollback absence. */
export class RestoreJournal {
  private readonly client: S3Client;
  constructor(private readonly config: StorageConfig, private readonly epoch: string, private readonly key: string) {
    if (!/^[a-f0-9]{64}$/.test(epoch) || Buffer.byteLength(key) < 32) throw new Error("restore_journal_config");
    this.client = new S3Client({ ...config, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 2 });
  }
  private path(suffix: string) { return `operations/restore/${this.epoch}/${suffix}`; }
  private encode(value: unknown): string {
    const payload = JSON.stringify(value);
    return JSON.stringify({ payload, signature: createHmac("sha256", this.key).update(payload).digest("hex") });
  }
  private decode<T>(value: string): T {
    const envelope = JSON.parse(value) as Envelope;
    if (typeof envelope.payload !== "string" || !/^[a-f0-9]{64}$/.test(envelope.signature)) throw new Error("restore_signature_invalid");
    const expected = createHmac("sha256", this.key).update(envelope.payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(envelope.signature, "hex"))) throw new Error("restore_signature_invalid");
    return JSON.parse(envelope.payload) as T;
  }
  private async read(suffix: string): Promise<{ text: string; etag: string }> {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.path(suffix) }), { abortSignal: AbortSignal.timeout(15000) });
    if (!object.Body || !object.ETag || object.ContentLength === undefined || object.ContentLength > 4096) {
      if (object.Body) await object.Body.transformToWebStream().cancel();
      throw new Error("restore_object_invalid");
    }
    const reader = object.Body.transformToWebStream().getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > 4096) throw new Error("restore_object_invalid");
        chunks.push(chunk.value);
      }
      return { text: Buffer.concat(chunks).toString("utf8"), etag: object.ETag };
    } finally {
      try { await reader.cancel(); } catch { console.warn("restore_journal_reader_cancel_failed"); }
      reader.releaseLock();
    }
  }
  private async write(suffix: string, value: unknown, etag?: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: this.path(suffix), Body: this.encode(value),
      ContentType: "application/json", ServerSideEncryption: "AES256", ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }) }),
      { abortSignal: AbortSignal.timeout(15000) });
  }
  /** Explicit provisioning only, never called on service start or recovery. */
  async initialize(): Promise<JournalCheckpoint> {
    const checkpoint = { epoch: this.epoch, sequence: 0, hash: ZERO };
    await this.write("head", checkpoint);
    return checkpoint;
  }
  async checkpoint(): Promise<JournalCheckpoint> {
    const head = this.decode<JournalCheckpoint>((await this.read("head")).text);
    validCheckpoint(head);
    if (head.epoch !== this.epoch) throw new Error("restore_epoch_mismatch");
    return head;
  }
  /** Caller authenticates and locks the parent before append. A failed/ambiguous
   * append never permits the effective deletion to be acknowledged. An orphan
   * immutable intent is harmless; only the CAS-published chain is authoritative. */
  async append(reportId: string, action: JournalAction): Promise<JournalCheckpoint> {
    if (!UUID.test(reportId) || !["delete", "withdraw", "remove-model"].includes(action)) throw new Error("restore_intent_invalid");
    const current = await this.read("head");
    const head = this.decode<JournalCheckpoint>(current.text); validCheckpoint(head);
    if (head.epoch !== this.epoch) throw new Error("restore_epoch_mismatch");
    if (head.sequence >= 100000) throw new Error("restore_chain_budget");
    const body = { epoch: this.epoch, sequence: head.sequence + 1, previous: head.hash, reportId, action };
    const hash = digest(JSON.stringify(body));
    const entry = { ...body, hash };
    try { await this.write(`entries/${hash}`, entry); }
    catch {
      // Lost response or same retry is accepted only with exact authenticated bytes.
      const existing = this.decode<JournalIntent>((await this.read(`entries/${hash}`)).text);
      if (JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error("restore_entry_conflict");
    }
    const next = { epoch: this.epoch, sequence: entry.sequence, hash };
    // Never retry a stale CAS as an unconditional write. Concurrent actors retry
    // their whole authenticated operation after a conflict.
    await this.write("head", next, current.etag);
    return next;
  }
  async verify(witness: JournalCheckpoint): Promise<JournalIntent[]> {
    validCheckpoint(witness);
    const head = await this.checkpoint();
    if (!sameCheckpoint(head, witness)) throw new Error("restore_external_witness_mismatch");
    if (head.sequence > 100000) throw new Error("restore_chain_budget");
    const entries: JournalIntent[] = [];
    let hash = head.hash;
    for (let sequence = head.sequence; sequence > 0; sequence--) {
      const entry = this.decode<JournalIntent>((await this.read(`entries/${hash}`)).text);
      const body = { epoch: entry.epoch, sequence: entry.sequence, previous: entry.previous, reportId: entry.reportId, action: entry.action };
      if (entry.epoch !== this.epoch || entry.sequence !== sequence || entry.hash !== hash || digest(JSON.stringify(body)) !== hash ||
          !/^[a-f0-9]{64}$/.test(entry.previous) || !UUID.test(entry.reportId) || !["delete", "withdraw", "remove-model"].includes(entry.action))
        throw new Error("restore_chain_invalid");
      entries.push(entry); hash = entry.previous;
    }
    if (hash !== ZERO) throw new Error("restore_chain_truncated");
    // A writer racing verification invalidates the selected restore checkpoint.
    if (!sameCheckpoint(await this.checkpoint(), witness)) throw new Error("restore_checkpoint_moved");
    return entries.reverse();
  }
  close(): void { this.client.destroy(); }
}
