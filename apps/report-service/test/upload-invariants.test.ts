/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { verifyParts } from "../src/uploads.js";
import { verifyModelStream } from "../src/verify-stream.js";
import { createHash } from "node:crypto";
describe("#7495 upload invariants", () => {
  it("rejects missing, wrong size, reordered, and altered storage parts", () => {
    const input = {
      name: "model.ifc",
      size: 20,
      type: "application/octet-stream" as const,
      confidentiality: "none" as const,
      uploadConsent: true as const,
    };
    const part = { partNumber: 1, size: 20, etag: "etag", sha256: "checksum" };
    expect(() => verifyParts(input, [part], { "1": "checksum" })).not.toThrow();
    for (const parts of [
      [],
      [{ ...part, size: 19 }],
      [{ ...part, partNumber: 2 }],
      [{ ...part, sha256: "other" }],
    ])
      expect(() => verifyParts(input, parts, { "1": "checksum" })).toThrow();
  });
  it("verifies actual stored bytes and rejects wrong bytes, truncation and excess independently of metadata", async () => {
    const bytes = new TextEncoder().encode("verified model bytes");
    const digest = createHash("sha256").update(bytes).digest("base64");
    const stream = (value: Uint8Array) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(value);
          controller.close();
        },
      });
    expect(
      await verifyModelStream(
        stream(bytes),
        bytes.length,
        { "1": digest },
        new AbortController().signal,
      ),
    ).toBe(createHash("sha256").update(bytes).digest("hex"));
    await expect(
      verifyModelStream(
        stream(new Uint8Array(bytes.length)),
        bytes.length,
        { "1": digest },
        new AbortController().signal,
      ),
    ).rejects.toThrow("checksum");
    await expect(
      verifyModelStream(
        stream(bytes.subarray(1)),
        bytes.length,
        { "1": digest },
        new AbortController().signal,
      ),
    ).rejects.toThrow("truncated");
    await expect(
      verifyModelStream(
        stream(bytes),
        bytes.length - 1,
        { "1": digest },
        new AbortController().signal,
      ),
    ).rejects.toThrow("exceeded");
  });
});
