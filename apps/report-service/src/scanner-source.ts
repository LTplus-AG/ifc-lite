/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
import { PUBLIC_MAX_BYTES, type ScanLease } from "./public-quarantine.js";

/** Trusted download boundary. Only the resulting fixed-name file enters the scanner. */
export class ScannerSource {
  private readonly client: S3Client;
  constructor(
    private readonly config: Pick<
      Config,
      | "region"
      | "endpoint"
      | "forcePathStyle"
      | "accessKeyId"
      | "secretAccessKey"
      | "bucket"
    >,
  ) {
    this.client = new S3Client({
      ...config,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }
  close(): void {
    this.client.destroy();
  }
  async download(
    lease: ScanLease,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(lease.byteSize) ||
      lease.byteSize < 1 ||
      lease.byteSize > PUBLIC_MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(lease.sha256)
    )
      throw new Error("scanner_source_invalid");
    const head = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: lease.objectKey,
      }),
      { abortSignal: signal },
    );
    if (!head.ETag || head.ContentLength !== lease.byteSize)
      throw new Error("scanner_source_changed");
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: lease.objectKey,
        IfMatch: head.ETag,
      }),
      { abortSignal: signal },
    );
    if (!response.Body) throw new Error("scanner_source_missing");
    const reader = response.Body.transformToWebStream().getReader();
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let failure: unknown;
    try {
      if (
        response.ContentLength !== lease.byteSize ||
        response.ETag !== head.ETag
      )
        throw new Error("scanner_source_changed");
      file = await open(path, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      let prefix = Buffer.alloc(0);
      let tail = Buffer.alloc(0);
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > lease.byteSize || value.includes(0))
          throw new Error("scanner_source_invalid");
        hash.update(value);
        if (prefix.length < 65536)
          prefix = Buffer.concat([
            prefix,
            value.subarray(0, 65536 - prefix.length),
          ]);
        tail = Buffer.concat([
          tail,
          value.subarray(Math.max(0, value.length - 65536)),
        ]).subarray(-65536);
        let offset = 0;
        while (offset < value.length) {
          const written = await file.write(
            value,
            offset,
            value.length - offset,
          );
          if (written.bytesWritten === 0)
            throw new Error("scanner_source_write");
          offset += written.bytesWritten;
        }
      }
      if (size !== lease.byteSize || hash.digest("hex") !== lease.sha256)
        throw new Error("scanner_source_changed");
      // Format envelope only; this is not IFC schema or geometric validation.
      if (
        !/^\s*ISO-10303-21;\s*HEADER;/i.test(prefix.toString("utf8")) ||
        !/ENDSEC;\s*END-ISO-10303-21;\s*$/i.test(tail.toString("utf8"))
      )
        throw new Error("scanner_format_unsupported");
      await file.chmod(0o444);
    } catch (error) {
      failure = error;
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
        await file?.close();
      }
    }
    if (failure) throw failure;
  }
}
