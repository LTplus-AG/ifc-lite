/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { loadFeature } from "./feature-loader.js";
const enabled = Boolean(process.env.REPORT_TEST_S3_ENDPOINT);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled)
  throw new Error("Mandatory real report integration environment is missing");
describe.skipIf(!enabled)(
  "#7495 immutable approved public copies use actual S3 bytes",
  () => {
    const config = {
      bucket: `public-copy-${randomUUID()}`,
      region: "us-east-1",
      endpoint: process.env.REPORT_TEST_S3_ENDPOINT,
      forcePathStyle: true,
      accessKeyId: process.env.REPORT_TEST_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.REPORT_TEST_S3_SECRET_ACCESS_KEY ?? "",
    };
    const client = new S3Client({
      ...config,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    let feature: typeof import("../src/public-storage.js") | undefined;
    let storage: InstanceType<
      typeof import("../src/public-storage.js").PublicModelStorage
    >;
    let initialized = false;
    const keys = new Set<string>();
    const key = (prefix = "published") => {
      const value = `${prefix}/${randomBytes(32).toString("hex")}`;
      keys.add(value);
      return value;
    };
    const hash = (value: Uint8Array) =>
      createHash("sha256").update(value).digest("hex");
    const put = async (name: string, bytes: Uint8Array) =>
      client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: name,
          Body: bytes,
          ServerSideEncryption: "AES256",
        }),
      );
    const get = async (name: string) => {
      const object = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: name }),
      );
      return object.Body!.transformToByteArray();
    };
    function api() {
      expect(
        feature,
        "Immutable verified-copy delivery must be implemented",
      ).toBeDefined();
      return storage;
    }
    beforeAll(async () => {
      feature = await loadFeature(
        "../src/public-storage.js",
        () => import("../src/public-storage.js"),
      );
      if (!feature) return;
      await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
      initialized = true;
      storage = new feature.PublicModelStorage(config);
    });
    afterAll(async () => {
      try {
        if (initialized) {
          storage.close();
          for (const name of keys)
            await client.send(
              new DeleteObjectCommand({ Bucket: config.bucket, Key: name }),
            );
          await client.send(new DeleteBucketCommand({ Bucket: config.bucket }));
        }
      } finally {
        client.destroy();
      }
    });
    it("rejects private keys at every public destination boundary without changing their bytes", async () => {
      const models = api();
      const privateKey = key("private");
      const bytes = Buffer.from("private model fixture");
      const original = await put(privateKey, bytes);
      await expect(
        models.copy(privateKey, privateKey, bytes.length, hash(bytes)),
      ).rejects.toThrow("public_copy_key");
      await expect(
        models.open(
          privateKey,
          bytes.length,
          original.ETag!,
          new AbortController().signal,
        ),
      ).rejects.toThrow("public_copy_key");
      await expect(models.delete(privateKey)).rejects.toThrow(
        "public_copy_key",
      );
      expect(hash(await get(privateKey))).toBe(hash(bytes));
    });
    it("copies real bytes, re-verifies their hash and reconciles an already-created identical destination", async () => {
      const models = api();
      const source = key("private"),
        destination = key();
      const bytes = Buffer.alloc(2 * 1024 ** 2 + 19, 0x61);
      await put(source, bytes);
      const result = await models.copy(
        source,
        destination,
        bytes.length,
        hash(bytes),
      );
      expect(result.etag).toBeTruthy();
      expect(hash(await get(destination))).toBe(hash(bytes));
      const reopened = await models.open(
        destination,
        bytes.length,
        result.etag,
        new AbortController().signal,
      );
      expect(
        hash(new Uint8Array(await new Response(reopened).arrayBuffer())),
      ).toBe(hash(bytes));
      expect(
        await models.copy(source, destination, bytes.length, hash(bytes)),
      ).toEqual(result);
    }, 30000);
    it("never overwrites or deletes a preexisting different destination, and changed source bytes cannot pass the approved hash", async () => {
      const models = api();
      const source = key("private"),
        occupied = key(),
        changed = key();
      const approved = Buffer.from("approved model bytes");
      const other = Buffer.alloc(approved.length, 0x78);
      await put(source, approved);
      await put(occupied, other);
      await expect(
        models.copy(source, occupied, approved.length, hash(approved)),
      ).rejects.toThrow("public_copy_failed");
      expect(hash(await get(occupied))).toBe(hash(other));
      await put(source, other);
      await expect(
        models.copy(source, changed, approved.length, hash(approved)),
      ).rejects.toThrow("public_copy_failed");
    }, 30000);
    for (const fault of ["lost-put-response", "changed-destination"] as const) {
      it(`reconciles ${fault} only by reading actual destination bytes`, async () => {
        api();
        const source = key("private"),
          destination = key();
        const bytes = Buffer.from("approved bytes after an ambiguous write");
        await put(source, bytes);
        let injected = false;
        const proxy = createServer((req, res) => {
          const path = req.url!;
          const forwarding = httpRequest(
            new URL(path, config.endpoint!),
            { method: req.method, headers: req.headers },
            (response) => {
              if (
                !injected &&
                req.method === "PUT" &&
                new URL(path, "http://fixture").pathname.endsWith(
                  "/" + destination,
                ) &&
                response.statusCode === 200
              ) {
                injected = true;
                response.resume();
                response.on("end", () => {
                  if (fault === "lost-put-response") {
                    res.destroy();
                    return;
                  }
                  void put(destination, Buffer.alloc(bytes.length, 0x78))
                    .then(() => {
                      res.writeHead(response.statusCode!, response.headers);
                      res.end();
                    })
                    .catch(() => {
                      res.writeHead(502);
                      res.end();
                    });
                });
              } else {
                res.writeHead(response.statusCode!, response.headers);
                response.pipe(res);
              }
            },
          );
          forwarding.on("error", () => {
            res.writeHead(502);
            res.end();
          });
          req.pipe(forwarding);
        });
        await new Promise<void>((resolve) =>
          proxy.listen(0, "127.0.0.1", resolve),
        );
        const address = proxy.address();
        if (!address || typeof address === "string")
          throw new Error("Proxy did not bind");
        const adapter = new feature!.PublicModelStorage({
          ...config,
          endpoint: `http://127.0.0.1:${address.port}`,
        });
        try {
          const copy = adapter.copy(
            source,
            destination,
            bytes.length,
            hash(bytes),
          );
          if (fault === "lost-put-response") {
            expect((await copy).etag).toBeTruthy();
            expect(hash(await get(destination))).toBe(hash(bytes));
          } else {
            await expect(copy).rejects.toThrow("public_copy_failed");
            expect(hash(await get(destination))).not.toBe(hash(bytes));
          }
          expect(injected).toBe(true);
        } finally {
          adapter.close();
          proxy.closeAllConnections();
          await new Promise<void>((resolve) => proxy.close(() => resolve()));
        }
      }, 30000);
    }
    it("rejects obsolete ETags and wrong sizes, and abort/close cancel open streams", async () => {
      const models = api();
      const source = key("private"),
        destination = key();
      const bytes = Buffer.alloc(2 * 1024 ** 2, 0x62);
      await put(source, bytes);
      const result = await models.copy(
        source,
        destination,
        bytes.length,
        hash(bytes),
      );
      await expect(
        models.open(
          destination,
          bytes.length - 1,
          result.etag,
          new AbortController().signal,
        ),
      ).rejects.toThrow("public_download_failed");
      const controller = new AbortController();
      const stream = await models.open(
        destination,
        bytes.length,
        result.etag,
        controller.signal,
      );
      const reader = stream.getReader();
      expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
      controller.abort();
      await expect(reader.read()).rejects.toThrow("public_download_cancelled");
      reader.releaseLock();
      const separate = new feature!.PublicModelStorage(config);
      const closing = await separate.open(
        destination,
        bytes.length,
        result.etag,
        new AbortController().signal,
      );
      separate.close();
      await expect(closing.getReader().read()).rejects.toThrow(
        "public_download_cancelled",
      );
      await put(destination, Buffer.alloc(bytes.length, 0x63));
      await expect(
        models.open(
          destination,
          bytes.length,
          result.etag,
          new AbortController().signal,
        ),
      ).rejects.toThrow("public_download_failed");
    }, 30000);
  },
);
