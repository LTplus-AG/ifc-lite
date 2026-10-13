/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { ReportSession, ReportReceipt } from "@ifc-lite/report-contract";
import { PDFDocument } from "pdf-lib";
import { openDatabase, migrate } from "../src/database.js";
import { loadConfig, type Config } from "../src/config.js";
import { createReport } from "../src/reports.js";
import { acceptAgreement, validateAgreementFont } from "../src/agreement.js";
import { createHandler } from "../src/handler.js";
import { ModelStorage } from "../src/storage.js";
const enabled = Boolean(
  process.env.REPORT_TEST_DATABASE_URL && process.env.REPORT_TEST_FONT_FILE,
);
if (process.env.REPORT_REQUIRE_INTEGRATION === "true" && !enabled)
  throw new Error(
    "Mandatory agreement integration needs REPORT_TEST_DATABASE_URL and REPORT_TEST_FONT_FILE",
  );
describe.skipIf(!enabled)("#7495 approved agreement durable binding", () => {
  const db = openDatabase(process.env.REPORT_TEST_DATABASE_URL ?? "");
  const version = "2026-10-13.v2";
  // Exact approved agreement bytes are contractual data, not source-text wiring.
  const approvedPath = fileURLToPath(new URL(
    "../../../legal/model-report-confidentiality-agreement-2026-10-13.v2.txt",
    import.meta.url,
  ));
  const digest = "8977cc03be648645f5b4f568cc9506beddd07f42547e25ace1da530cba37bbbb";
  let text: string;
  const owner = {
    id: randomUUID(),
    csrf: randomUUID(),
    admission: randomUUID(),
  };
  let config: Config;
  let directory: string;
  const admissionSecret = randomUUID();
  const adminToken = randomUUID();
  function agreementEnvironment(path: string, keyPath: string): NodeJS.ProcessEnv {
    return {
      REPORT_VIEWER_ORIGIN: "https://viewer.example.com",
      REPORT_AGREEMENT_FILE: path,
      REPORT_APPROVED_AGREEMENT_SHA256: digest,
      REPORT_AGREEMENT_FONT_FILE: process.env.REPORT_TEST_FONT_FILE,
      REPORT_ADMISSION_SECRET: admissionSecret,
      REPORT_ADMIN_TOKEN: adminToken,
      REPORT_GITHUB_REPOSITORY: "owner/repo",
      REPORT_STORAGE_PROVIDER: "Unused test storage",
      REPORT_STORAGE_LOCATION: "Local test host",
      REPORT_BACKUP_DISCLOSURE: "No backups",
      REPORT_DATABASE_URL: "postgres://localhost/test",
      REPORT_S3_BUCKET: "unused",
      REPORT_S3_REGION: "us-east-1",
      REPORT_S3_ENDPOINT: "http://127.0.0.1:1",
      REPORT_S3_ACCESS_KEY_ID: "unused",
      REPORT_S3_SECRET_ACCESS_KEY: "unused",
      REPORT_GITHUB_APP_ID: "1",
      REPORT_GITHUB_INSTALLATION_ID: "1",
      REPORT_GITHUB_PRIVATE_KEY_FILE: keyPath,
    };
  }
  beforeAll(async () => {
    await migrate(db);
    directory = await mkdtemp(join(tmpdir(), "ifclite-agreement-test-"));
    text = await readFile(approvedPath, "utf8");
    const keyPath = join(directory, "fixture-key.txt");
    await writeFile(keyPath, "test-only key; signing is not invoked");
    config = loadConfig({
      ...agreementEnvironment(approvedPath, keyPath),
      REPORT_AGREEMENT_VERSION: version,
      REPORT_DATABASE_URL: process.env.REPORT_TEST_DATABASE_URL,
      REPORT_SUBMISSIONS_ENABLED: "true",
    });
    await validateAgreementFont(config);
  });
  afterAll(async () => {
    await db.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("#7495 binds actual approved v2, Unicode signer, exact text hash and immutable PDF receipt", async () => {
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
      version,
      signerName: "Jörg Müller",
      acceptedAt: receipt.acceptedAt,
    });
    expect(stored.agreement.pdfSha256).toBe(
      createHash("sha256").update(stored.agreement_pdf).digest("hex"),
    );
    const pdf = await PDFDocument.load(stored.agreement_pdf);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
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
        version: "2026-10-13.v3",
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
  it("#7495 serves the approved v2 session and immutable owner PDF through real HTTP", async () => {
    const storage = new ModelStorage(config);
    const handler = createHandler(db, storage, config);
    const server = createServer((req, res) => { void handler(req, res); });
    let sessionId: string | undefined;
    let reportId: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No bound agreement test port");
      const base = `http://127.0.0.1:${address.port}/api/reports`;
      const sessionResponse = await fetch(`${base}/session`);
      expect(sessionResponse.status).toBe(200);
      const cookieHeader = sessionResponse.headers.get("set-cookie");
      if (!cookieHeader) throw new Error("Agreement HTTP session did not set a cookie");
      const cookie = cookieHeader.split(";")[0]!;
      sessionId = createHash("sha256").update(cookie.split("=")[1]!).digest("hex");
      const session = await sessionResponse.json() as ReportSession;
      expect(session.agreement).toMatchObject({ version, sha256: digest, text, signingEnabled: true });
      const request = (path: string, method = "GET", input?: unknown) => fetch(base + path, {
        method,
        headers: { Cookie: cookie, Origin: config.origin, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      const draft = await request("/drafts", "POST", {
        clientRequestId: randomUUID(), title: "Exact v2 HTTP acceptance", description: "",
        diagnostics: { errorCode: "fixture", appVersion: "test", buildSha: "test" }, visibility: "private",
      });
      expect(draft.status).toBe(201);
      reportId = (await draft.json() as ReportReceipt).id;
      const input = {
        agreementSha256: digest, signerName: "Jörg Müller", signerEmail: "test@example.com",
        organization: "Test AG", authorityConfirmed: true, accepted: true,
      };
      const refused = await request(`/${reportId}/consent`, "POST", { ...input, agreementSha256: "0".repeat(64) });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: "agreement_changed" });
      const accepted = await request(`/${reportId}/consent`, "POST", input);
      expect(accepted.status).toBe(200);
      const receipt = await accepted.json();
      expect(receipt).toMatchObject({ agreementSha256: digest, pdfUrl: `/api/reports/${reportId}/agreement.pdf` });
      const pdfResponse = await request(`/${reportId}/agreement.pdf`);
      expect(pdfResponse.status).toBe(200);
      expect(pdfResponse.headers.get("content-type")).toContain("application/pdf");
      const bytes = Buffer.from(await pdfResponse.arrayBuffer());
      const stored = await db.query<{ agreement: Record<string, unknown>; agreement_pdf: Buffer }>(
        "SELECT agreement,agreement_pdf FROM model_reports WHERE id=$1", [reportId],
      );
      expect(stored.rows[0]?.agreement).toMatchObject({ version, agreementSha256: digest, signerName: input.signerName });
      expect(bytes.equals(stored.rows[0]!.agreement_pdf)).toBe(true);
      expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
      const repeated = await request(`/${reportId}/consent`, "POST", input);
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual(receipt);
    } finally {
      try {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally {
        storage.close();
        try {
          if (reportId) {
            await db.query("DELETE FROM report_audit WHERE report_id=$1", [reportId]);
            await db.query("DELETE FROM model_reports WHERE id=$1", [reportId]);
          }
        } finally {
          if (sessionId) {
            await db.query("DELETE FROM report_admission WHERE key IN (SELECT admission FROM report_sessions WHERE id=$1)", [sessionId]);
            await db.query("DELETE FROM report_sessions WHERE id=$1", [sessionId]);
          }
        }
      }
    }
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
    const env = agreementEnvironment(path, keyPath);
    for (const version of [
      undefined, "", "  ", "unapproved", "UNAPPROVED", "draft-v1", "{{version}}",
    ]) {
      expect(() => loadConfig({ ...env, REPORT_AGREEMENT_VERSION: version }))
        .toThrow(/approved agreement version/);
    }
    const approved = loadConfig({
      ...env, REPORT_AGREEMENT_VERSION: version,
    });
    expect(approved.agreement.signingEnabled).toBe(true);
    expect(approved.agreement.version).toBe(version);
    await validateAgreementFont(approved);
    // #7495: a valid-format wrong version must not label approved v2 as v1.
    expect(() => loadConfig({ ...env, REPORT_AGREEMENT_VERSION: "2026-10-13.v1" }))
      .toThrow(/version declaration/);
    const approvedEnv = { ...env, REPORT_AGREEMENT_VERSION: version };
    for (const invalid of [
      text.replace(`Agreement version: ${version}\n`, ""),
      text + `\nAgreement version: ${version}\n`,
    ]) {
      await writeFile(path, invalid);
      expect(() => loadConfig({
        ...approvedEnv,
        REPORT_APPROVED_AGREEMENT_SHA256: createHash("sha256").update(invalid).digest("hex"),
      })).toThrow(/version declaration/);
    }
    await writeFile(path, text + "\n");
    expect(() => loadConfig(approvedEnv)).toThrow(/match/);
    await writeFile(path, text);
    expect(() => loadConfig({ ...approvedEnv, REPORT_AGREEMENT_FONT_FILE: undefined }))
      .toThrow(/REPORT_AGREEMENT_FONT_FILE/);
    const disabled = loadConfig({
      ...env, REPORT_APPROVED_AGREEMENT_SHA256: undefined,
    });
    expect(disabled.agreement.signingEnabled).toBe(false);
    expect(disabled.submissionsEnabled).toBe(false);
    expect(
      loadConfig({
        ...env,
        REPORT_APPROVED_AGREEMENT_SHA256: undefined,
        REPORT_SUBMISSIONS_ENABLED: "TRUE",
      }).submissionsEnabled,
    ).toBe(false);
    expect(
      loadConfig({
        ...env,
        REPORT_APPROVED_AGREEMENT_SHA256: undefined,
        REPORT_SUBMISSIONS_ENABLED: "true",
      }).submissionsEnabled,
    ).toBe(true);
    for (const token of [
      "short",
      env.REPORT_ADMIN_TOKEN,
      env.REPORT_ADMISSION_SECRET,
    ]) {
      expect(() =>
        loadConfig({
          ...env,
          REPORT_APPROVED_AGREEMENT_SHA256: undefined,
          REPORT_QUALIFICATION_TOKEN: token,
        }),
      ).toThrow(/separate secret/);
    }
    await writeFile(path, "Unapproved fixture without a version declaration");
    expect(loadConfig({ ...approvedEnv, REPORT_APPROVED_AGREEMENT_SHA256: undefined }).agreement.signingEnabled)
      .toBe(false);
    await writeFile(path, text);
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
