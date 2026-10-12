/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { openDatabase, migrate } from "../src/database.js";
import { loadConfig, type Config } from "../src/config.js";
import { createReport } from "../src/reports.js";
import { acceptAgreement, validateAgreementFont } from "../src/agreement.js";
const enabled = Boolean(
  process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_FONT_FILE,
);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled)
  throw new Error(
    "Mandatory agreement integration needs REPORT_TEST_DATABASE_URL and REPORT_TEST_FONT_FILE",
  );
describe.skipIf(!enabled)("#7495 approved agreement durable binding", () => {
  const db = openDatabase(process.env.REPORT_TEST_DATABASE_URL ?? "");
  const text =
    "Confidentiality agreement\nLTplus AG, Switzerland\nUse the model only to diagnose the reported defect.";
  const digest = createHash("sha256").update(text).digest("hex");
  const owner = {
    id: randomUUID(),
    csrf: randomUUID(),
    admission: randomUUID(),
  };
  let config: Config;
  let directory: string;
  beforeAll(async () => {
    await migrate(db);
    directory = await mkdtemp(join(tmpdir(), "ifclite-agreement-test-"));
    config = {
      origin: "https://viewer.example.com",
      port: 0,
      databaseUrl: process.env.REPORT_TEST_DATABASE_URL ?? "",
      bucket: "unused",
      region: "us-east-1",
      accessKeyId: "unused",
      secretAccessKey: "unused",
      admissionSecret: "a".repeat(32),
      adminToken: "b".repeat(32),
      githubAppId: "1",
      githubInstallationId: "1",
      githubPrivateKey: "unused",
      githubRepository: "owner/repo",
      storageProvider: "test",
      storageLocation: "test",
      backupDisclosure: "none",
      agreementFont: await readFile(process.env.REPORT_TEST_FONT_FILE!),
      agreement: {
        version: "test-approved-v1",
        sha256: digest,
        text,
        issuer: "LTplus AG",
        jurisdiction: "Switzerland",
        signingEnabled: true,
      },
      maxDailyReports: 20,
      maxDailyBytes: 10000,
      maxStorageBytes: 10000,
    };
    await validateAgreementFont(config);
  });
  afterAll(async () => {
    await db.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("binds Unicode signer, exact reviewed text hash, report ID and immutable PDF receipt", async () => {
    const report = await createReport(db, config, owner, {
      clientRequestId: randomUUID(),
      title: "Agreement acceptance",
      description: "",
      diagnostics: { errorCode: "test", appVersion: "test", buildSha: "test" },
      visibility: "private",
    });
    const input = {
      agreementSha256: digest,
      signerName: "Jörg Müller",
      signerEmail: "test@example.com",
      organization: "Test AG",
      authorityConfirmed: true as const,
      accepted: true as const,
    };
    await expect(
      acceptAgreement(db, config, report.id, owner, {
        ...input,
        agreementSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/changed/i);
    expect(
      (
        await db.query("SELECT agreement FROM model_reports WHERE id=$1", [
          report.id,
        ])
      ).rows[0]?.agreement,
    ).toBeNull();
    const receipt = await acceptAgreement(db, config, report.id, owner, input);
    const stored = (
      await db.query<{
        agreement: Record<string, unknown>;
        agreement_pdf: Buffer;
      }>("SELECT agreement,agreement_pdf FROM model_reports WHERE id=$1", [
        report.id,
      ])
    ).rows[0]!;
    expect(stored.agreement).toMatchObject({
      reportId: report.id,
      agreementSha256: digest,
      version: "test-approved-v1",
      signerName: "Jörg Müller",
      acceptedAt: receipt.acceptedAt,
    });
    expect(stored.agreement.pdfSha256).toBe(
      createHash("sha256").update(stored.agreement_pdf).digest("hex"),
    );
    const pdf = await PDFDocument.load(stored.agreement_pdf);
    expect(pdf.getPageCount()).toBeGreaterThan(0);
    expect(pdf.getSubject()).toBe(`Report ${report.id}`);
    expect(pdf.getAuthor()).toBe("LTplus AG");
    expect(
      (await acceptAgreement(db, config, report.id, owner, input)).acceptedAt,
    ).toBe(receipt.acceptedAt);
    for (const change of [
      { signerName: "Different Signer" },
      { signerEmail: "different@example.com" },
      { organization: "Different Organisation" },
    ]) {
      await expect(
        acceptAgreement(db, config, report.id, owner, { ...input, ...change }),
      ).rejects.toThrow(/different acceptance details/);
    }
    const replacement = {
      ...config,
      agreement: {
        ...config.agreement,
        version: "test-v2",
        text: text + " Revised.",
        sha256: createHash("sha256").update(text + " Revised.").digest("hex"),
      },
    };
    await expect(
      acceptAgreement(db, replacement, report.id, owner, {
        ...input,
        agreementSha256: replacement.agreement.sha256,
      }),
    ).rejects.toThrow(/different acceptance details/);
    const unchanged = (
      await db.query<{ agreement_pdf: Buffer }>(
        "SELECT agreement_pdf FROM model_reports WHERE id=$1", [report.id],
      )
    ).rows[0]!;
    expect(createHash("sha256").update(unchanged.agreement_pdf).digest("hex"))
      .toBe(stored.agreement.pdfSha256);
  });
  it("fails configuration for a changed or still-draft supposedly approved document", async () => {
    const path = join(directory, "agreement.txt");
    await writeFile(path, "DRAFT agreement");
    const env = {
      REPORT_VIEWER_ORIGIN: "https://viewer.example.com",
      REPORT_AGREEMENT_FILE: path,
      REPORT_APPROVED_AGREEMENT_SHA256: createHash("sha256")
        .update("DRAFT agreement")
        .digest("hex"),
    };
    expect(() => loadConfig(env)).toThrow(/draft template/i);
    await writeFile(path, text);
    expect(() =>
      loadConfig({ ...env, REPORT_APPROVED_AGREEMENT_SHA256: "0".repeat(64) }),
    ).toThrow(/match/i);
  });
  it("#7497 requires an explicit approved version before enabling signing", async () => {
    const path = join(directory, "approved-agreement.txt");
    const keyPath = join(directory, "fixture-key.txt");
    await writeFile(path, text);
    await writeFile(keyPath, "test-only key; signing is not invoked");
    const env: NodeJS.ProcessEnv = {
      REPORT_VIEWER_ORIGIN: "https://viewer.example.com",
      REPORT_AGREEMENT_FILE: path,
      REPORT_APPROVED_AGREEMENT_SHA256: digest,
      REPORT_AGREEMENT_FONT_FILE: process.env.REPORT_TEST_FONT_FILE,
      REPORT_ADMISSION_SECRET: "a".repeat(32),
      REPORT_ADMIN_TOKEN: "b".repeat(32),
      REPORT_GITHUB_REPOSITORY: "owner/repo",
      REPORT_STORAGE_PROVIDER: "test",
      REPORT_STORAGE_LOCATION: "test",
      REPORT_BACKUP_DISCLOSURE: "none",
      REPORT_DATABASE_URL: "postgres://localhost/test",
      REPORT_S3_BUCKET: "test",
      REPORT_S3_REGION: "test",
      REPORT_S3_ACCESS_KEY_ID: "test",
      REPORT_S3_SECRET_ACCESS_KEY: "test",
      REPORT_GITHUB_APP_ID: "1",
      REPORT_GITHUB_INSTALLATION_ID: "1",
      REPORT_GITHUB_PRIVATE_KEY_FILE: keyPath,
    };
    for (const version of [
      undefined, "", "  ", "unapproved", "UNAPPROVED", "draft-v1", "{{version}}",
    ]) {
      expect(() => loadConfig({ ...env, REPORT_AGREEMENT_VERSION: version }))
        .toThrow(/approved agreement version/);
    }
    const approved = loadConfig({
      ...env, REPORT_AGREEMENT_VERSION: "2026-10-12.v1",
    });
    expect(approved.agreement.signingEnabled).toBe(true);
    expect(approved.agreement.version).toBe("2026-10-12.v1");
    await validateAgreementFont(approved);
    const disabled = loadConfig({
      ...env, REPORT_APPROVED_AGREEMENT_SHA256: undefined,
    });
    expect(disabled.agreement.signingEnabled).toBe(false);
    // #7497: hosts providing secret environment values need no file wrapper.
    const inlineKey = "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----\n";
    const inline = {
      ...env,
      REPORT_APPROVED_AGREEMENT_SHA256: undefined,
      REPORT_GITHUB_PRIVATE_KEY_FILE: undefined,
      REPORT_GITHUB_PRIVATE_KEY: inlineKey,
    };
    expect(loadConfig(inline).githubPrivateKey).toBe(inlineKey);
    expect(disabled.githubPrivateKey).toBe("test-only key; signing is not invoked");
    expect(() => loadConfig({ ...inline, REPORT_GITHUB_PRIVATE_KEY_FILE: keyPath }))
      .toThrow(/exactly one/);
    expect(() => loadConfig({ ...inline, REPORT_GITHUB_PRIVATE_KEY: undefined }))
      .toThrow(/exactly one/);
    expect(() => loadConfig({ ...inline, REPORT_GITHUB_PRIVATE_KEY: "  " }))
      .toThrow(/exactly one/);
  });
});
