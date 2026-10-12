/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { UploadedPart } from "@ifc-lite/report-contract";
import { verifyModelStream } from "./verify-stream.js";
import type { Config } from "./config.js";
export class ModelStorage {
  private readonly client: S3Client;
  private readonly verifications = new Map<string, AbortController>();
  constructor(private readonly config: Config) {
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
  async create(key: string): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: "application/octet-stream",
        ChecksumAlgorithm: "SHA256",
        ServerSideEncryption: "AES256",
      }),
    );
    if (!result.UploadId) throw new Error("Storage returned no upload ID");
    return result.UploadId;
  }
  signPart(
    key: string,
    id: string,
    partNumber: number,
    checksum: string,
    size: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: id,
        PartNumber: partNumber,
        ChecksumSHA256: checksum,
        ContentLength: size,
      }),
      {
        expiresIn: 300,
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      },
    );
  }
  async parts(key: string, id: string): Promise<UploadedPart[]> {
    const result: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.client.send(
        new ListPartsCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: id,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        if (
          part.PartNumber === undefined ||
          part.Size === undefined ||
          !part.ETag
        )
          throw new Error("Incomplete storage part metadata");
        result.push({
          partNumber: part.PartNumber,
          size: part.Size,
          etag: part.ETag,
          sha256: part.ChecksumSHA256 ?? "",
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return result;
  }
  async complete(
    key: string,
    id: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: id,
        MultipartUpload: {
          Parts: parts.map((p) => ({
            PartNumber: p.partNumber,
            ETag: p.etag,
            ChecksumSHA256: p.sha256,
          })),
        },
      }),
    );
  }
  async head(key: string): Promise<{ size: number; checksum?: string }> {
    const result = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ChecksumMode: "ENABLED",
      }),
    );
    if (result.ContentLength === undefined)
      throw new Error("Missing stored size");
    return { size: result.ContentLength, checksum: result.ChecksumSHA256 };
  }
  async verify(
    key: string,
    size: number,
    expected: Record<string, string>,
  ): Promise<string> {
    const controller = new AbortController();
    this.verifications.set(key, controller);
    const timer = setTimeout(
      () => controller.abort(new Error("model_verification_timeout")),
      15 * 60 * 1000,
    );
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { abortSignal: controller.signal },
      );
      if (!result.Body || result.ContentLength !== size) {
        if (result.Body) await result.Body.transformToWebStream().cancel();
        throw new Error("model_size_mismatch");
      }
      return await verifyModelStream(
        result.Body.transformToWebStream(),
        size,
        expected,
        controller.signal,
      );
    } catch (error) {
      if (
        controller.signal.aborted &&
        controller.signal.reason instanceof Error &&
        controller.signal.reason.message === "model_verification_cancelled"
      )
        throw new Error("model_verification_interrupted");
      throw error;
    } finally {
      clearTimeout(timer);
      this.verifications.delete(key);
    }
  }
  cancelVerification(key: string): void {
    this.verifications
      .get(key)
      ?.abort(new Error("model_verification_cancelled"));
  }
  cancelVerifications(): void {
    for (const controller of this.verifications.values())
      controller.abort(new Error("model_verification_cancelled"));
  }
  close(): void {
    this.cancelVerifications();
    this.client.destroy();
  }
  async abort(key: string, id: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: id,
        }),
      );
    } catch (error) {
      if (!(error instanceof Error && error.name === "NoSuchUpload"))
        throw error;
    }
  }
  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }
  download(key: string, name: string): Promise<string> {
    const extension = /\.(ifc|ifczip|ifcx)$/i.exec(name)?.[1]?.toLowerCase();
    if (!extension) throw new Error("Invalid model download extension");
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="model.${extension}"`,
        ResponseContentType: "application/octet-stream",
      }),
      { expiresIn: 60 },
    );
  }
}
