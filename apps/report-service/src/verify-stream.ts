/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from "node:crypto";
import { REPORT_LIMITS } from "@ifc-lite/report-contract";
/** Verify the actual stored bytes with O(one transport chunk) memory. Expected
 * hashes come from the immutable authorized-part ledger, not storage ETags. */
export async function verifyModelStream(
  stream: ReadableStream<Uint8Array>,
  size: number,
  expected: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  let total = 0;
  let partNumber = 1;
  let partSize = 0;
  let partHash = createHash("sha256");
  const fullHash = createHash("sha256");
  const cancel = () => {
    void reader.cancel("Verification cancelled").catch(error => console.warn("[report-service] verification stream cancellation failed", error instanceof Error ? error.name : "Unknown"));
  };
  signal.addEventListener("abort", cancel, { once: true });
  const finishPart = () => {
    if (partHash.digest("base64") !== expected[String(partNumber)])
      throw new Error("model_part_checksum_mismatch");
    partNumber++;
    partSize = 0;
    partHash = createHash("sha256");
  };
  try {
    signal.throwIfAborted();
    while (true) {
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) break;
      const chunk = result.value;
      if (total + chunk.byteLength > size)
        throw new Error("model_size_exceeded");
      fullHash.update(chunk);
      total += chunk.byteLength;
      let offset = 0;
      while (offset < chunk.byteLength) {
        const length = Math.min(
          REPORT_LIMITS.partBytes - partSize,
          chunk.byteLength - offset,
        );
        partHash.update(chunk.subarray(offset, offset + length));
        partSize += length;
        offset += length;
        if (partSize === REPORT_LIMITS.partBytes) finishPart();
      }
    }
    if (total !== size) throw new Error("model_size_truncated");
    if (partSize > 0) finishPart();
    if (partNumber - 1 !== Math.ceil(size / REPORT_LIMITS.partBytes))
      throw new Error("model_part_count_mismatch");
    return fullHash.digest("hex");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(error => console.warn("[report-service] verification stream cancellation failed", error instanceof Error ? error.name : "Unknown"));
    reader.releaseLock();
  }
}
