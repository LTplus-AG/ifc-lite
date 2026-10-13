/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
import { PUBLIC_MAX_BYTES } from "./public-quarantine.js";

type StorageConfig = Pick<
  Config,
  | "region"
  | "endpoint"
  | "forcePathStyle"
  | "accessKeyId"
  | "secretAccessKey"
  | "bucket"
>;
const DEADLINE_MS = 15 * 60 * 1000;
function requirePublicKey(key: string): void {
  if (!/^published\/[a-f0-9]{64}$/.test(key))
    throw new Error("public_copy_key");
}
function requireSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0 || size > PUBLIC_MAX_BYTES)
    throw new Error("public_model_size");
}
async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    console.warn("public_storage_stream_cancel_failed");
  } finally {
    reader.releaseLock();
  }
}
/** Private bucket copy adapter. Public eligibility and download admission live
 * above this layer; no object URL or original key is returned to the caller. */
export class PublicModelStorage {
  private readonly client: S3Client;
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(private readonly config: StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }
  private operation(signal?: AbortSignal) {
    if (this.closed) throw new Error("public_storage_closed");
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort(new Error("public_storage_cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, DEADLINE_MS);
    return {
      controller,
      finish: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.active.delete(controller);
      },
    };
  }
  async copy(
    sourceKey: string,
    destinationKey: string,
    size: number,
    approvedSha256: string,
  ): Promise<{ etag: string }> {
    requireSize(size);
    requirePublicKey(destinationKey);
    if (sourceKey === destinationKey || !/^[a-f0-9]{64}$/.test(approvedSha256))
      throw new Error("public_copy_identity");
    const operation = this.operation();
    const signal = operation.controller.signal;
    let body: Readable | undefined;
    let stoppingSource = false;
    let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let sourceClosed = false;
    const finishSource = async () => {
      if (!sourceReader || sourceClosed) return;
      sourceClosed = true;
      await cancelReader(sourceReader);
    };
    try {
      const source = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: sourceKey,
        }),
        { abortSignal: signal },
      );
      if (!source.Body) throw new Error("public_source_missing");
      const reader = source.Body.transformToWebStream().getReader();
      sourceReader = reader;
      if (source.ContentLength !== size) {
        await finishSource();
        throw new Error("public_source_size");
      }
      const chunks = async function* () {
        let read = 0;
        const hash = createHash("sha256");
        try {
          while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) break;
            read += chunk.value.byteLength;
            if (read > size) throw new Error("public_source_size");
            hash.update(chunk.value);
            yield chunk.value;
          }
          if (read !== size || hash.digest("hex") !== approvedSha256)
            throw new Error("public_source_integrity");
        } finally {
          await finishSource();
        }
      };
      body = Readable.from(chunks(), { objectMode: false });
      // SDK transport may stop listening after ContentLength bytes, before the
      // generator's final digest check. Own that error and abort the operation.
      body.on("error", () => {
        if (!stoppingSource)
          operation.controller.abort(new Error("public_source_failed"));
      });
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: destinationKey,
            Body: body,
            ContentLength: size,
            ContentType: "application/octet-stream",
            ChecksumSHA256: Buffer.from(approvedSha256, "hex").toString(
              "base64",
            ),
            ServerSideEncryption: "AES256",
            IfNoneMatch: "*",
          }),
          { abortSignal: signal },
        );
      } catch {
        // A conflict or lost PUT response is only successful if an independent
        // read proves this exact approved object. Never overwrite/delete it.
        stoppingSource = true;
        body.destroy();
      }
      signal.throwIfAborted();
      return await this.verify(destinationKey, size, approvedSha256, signal);
    } catch {
      throw new Error("public_copy_failed");
    } finally {
      stoppingSource = true;
      body?.destroy();
      await finishSource();
      operation.finish();
    }
  }
  private async verify(
    key: string,
    size: number,
    sha256: string,
    signal: AbortSignal,
  ): Promise<{ etag: string }> {
    const object = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
      { abortSignal: signal },
    );
    if (!object.Body) throw new Error("public_copy_missing");
    const reader = object.Body.transformToWebStream().getReader();
    let total = 0;
    const hash = createHash("sha256");
    try {
      if (object.ContentLength !== size || !object.ETag)
        throw new Error("public_copy_metadata");
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > size) throw new Error("public_copy_size");
        hash.update(chunk.value);
      }
      if (total !== size || hash.digest("hex") !== sha256)
        throw new Error("public_copy_integrity");
      return { etag: object.ETag };
    } finally {
      await cancelReader(reader);
    }
  }
  async open(
    key: string,
    size: number,
    etag: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    requireSize(size);
    requirePublicKey(key);
    if (!etag || /[\r\n]/.test(etag)) throw new Error("public_copy_etag");
    const operation = this.operation(signal);
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          IfMatch: etag,
        }),
        { abortSignal: operation.controller.signal },
      );
      if (!object.Body) throw new Error("public_copy_missing");
      const reader = object.Body.transformToWebStream().getReader();
      if (object.ContentLength !== size || object.ETag !== etag) {
        await cancelReader(reader);
        throw new Error("public_copy_metadata");
      }
      let total = 0;
      let finished = false;
      let abort: () => void;
      const finish = async () => {
        if (finished) return;
        finished = true;
        operation.controller.signal.removeEventListener("abort", abort);
        operation.finish();
        await cancelReader(reader);
      };
      return new ReadableStream<Uint8Array>({
        start(controller) {
          abort = () => {
            if (finished) return;
            controller.error(new Error("public_download_cancelled"));
            void finish();
          };
          operation.controller.signal.addEventListener("abort", abort, {
            once: true,
          });
          if (operation.controller.signal.aborted) abort();
        },
        async pull(controller) {
          if (finished) return;
          try {
            const chunk = await reader.read();
            if (finished) return;
            if (chunk.done) {
              if (total !== size) throw new Error("public_download_size");
              controller.close();
              await finish();
              return;
            }
            total += chunk.value.byteLength;
            if (total > size) throw new Error("public_download_size");
            controller.enqueue(chunk.value);
          } catch {
            if (!finished)
              controller.error(new Error("public_download_failed"));
            await finish();
          }
        },
        cancel: finish,
      });
    } catch {
      operation.finish();
      throw new Error("public_download_failed");
    }
  }
  async delete(key: string): Promise<void> {
    requirePublicKey(key);
    const operation = this.operation();
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { abortSignal: operation.controller.signal },
      );
    } catch {
      throw new Error("public_copy_delete_failed");
    } finally {
      operation.finish();
    }
  }
  close(): void {
    this.closed = true;
    for (const controller of this.active)
      controller.abort(new Error("public_storage_closed"));
    this.client.destroy();
  }
}
