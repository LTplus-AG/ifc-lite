/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadFeature } from "./feature-loader.js";
import type { ScanLease } from "../src/public-quarantine.js";

const signatures = process.env.REPORT_SCANNER_SIGNATURE_DIRECTORY;
if (process.env.REPORT_REQUIRE_SCANNER === "true" && !signatures)
  throw new Error("Mandatory real scanner signatures missing");

describe.skipIf(!signatures)("#7495 real engine negative controls", () => {
  async function sandbox(
    bytes: Buffer,
    size = bytes.length,
    signal = AbortSignal.timeout(120000),
    database = signatures!,
  ) {
    const module = await loadFeature(
      "../src/scanner-sandbox.js",
      () => import("../src/scanner-sandbox.js"),
    );
    expect(module, "The real sandbox adapter must exist").toBeDefined();
    const directory = await mkdtemp(join(tmpdir(), "scanner-engine-"));
    const model = join(directory, "model.ifc");
    await writeFile(model, bytes, { mode: 0o600 });
    if (size !== bytes.length) {
      const file = await open(model, "r+");
      try {
        await file.truncate(size);
      } finally {
        await file.close();
      }
    }
    await chmod(model, 0o444);
    const lease: ScanLease = {
      reportId: randomUUID(),
      uploadId: randomUUID(),
      leaseId: randomUUID(),
      objectKey: "fixture",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: size,
      policyVersion: "ifc-step-clamav-v1",
    };
    try {
      // This directly tests the sandbox boundary. Format/hash admission belongs
      // to ScannerSource and is tested separately through actual storage.
      return await module!.scanSandbox(
        lease,
        model,
        database,
        directory,
        signal,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("canonical whole-file EICAR is detected by the pinned signed-database engine", async () => {
    const bytes = Buffer.from(
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f",
    );
    expect(await sandbox(bytes)).toMatchObject({
      outcome: "infected",
      complete: false,
    });
  }, 150000);

  it("interrupting the actual engine never returns a clean attestation", async () => {
    await expect(
      sandbox(
        Buffer.from("ISO-10303-21;\nHEADER;"),
        undefined,
        AbortSignal.timeout(3000),
      ),
    ).rejects.toThrow("scanner_process_interrupted");
  }, 150000);

  it("a stale copied daily database is rejected before any clean attestation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scanner-stale-"));
    try {
      await cp(signatures!, directory, { recursive: true });
      const file = join(directory, "daily.cvd");
      const handle = await open(file, "r+");
      try {
        const header = Buffer.alloc(512);
        await handle.read(header, 0, 512, 0);
        const fields = header.toString("ascii").trim().split(":");
        fields[8] = String(Math.floor(Date.now() / 1000) - 172800);
        await handle.write(
          Buffer.from(fields.join(":").padEnd(512, " ")),
          0,
          512,
          0,
        );
      } finally {
        await handle.close();
      }
      await expect(
        sandbox(
          Buffer.from("ISO-10303-21;\nHEADER;"),
          undefined,
          AbortSignal.timeout(120000),
          directory,
        ),
      ).rejects.toThrow("scanner_signatures_stale");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 150000);

  it("the actual 1 GiB engine file cap can never attest a skipped oversized file clean", async () => {
    // Sparse fixture crosses the production engine limit without allocating 1 GiB.
    const result = await sandbox(
      Buffer.from("ISO-10303-21;\nHEADER;"),
      1024 ** 3 + 1,
    );
    expect(result.outcome).not.toBe("clean");
    expect(result.complete).toBe(false);
  }, 150000);
});
