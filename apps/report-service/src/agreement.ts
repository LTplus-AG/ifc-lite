/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from "node:crypto";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type {
  AgreementAcceptanceInput,
  AgreementReceipt,
} from "@ifc-lite/report-contract";
import type { Config } from "./config.js";
import { transaction, audit, type Db } from "./database.js";
import { requireCondition } from "./errors.js";
import type { ReportRow } from "./reports.js";
import type { Session } from "./sessions.js";
/** PDF is an acceptance receipt, not a claim of a qualified digital signature. */
export async function agreementPdf(
  text: string,
  receipt: Record<string, unknown>,
  fontBytes?: Uint8Array,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle("IFC Lite confidentiality acceptance receipt");
  document.setAuthor("LTplus AG");
  document.setSubject(`Report ${String(receipt.reportId ?? "receipt")}`);
  if (typeof receipt.acceptedAt === "string")
    document.setCreationDate(new Date(receipt.acceptedAt));
  if (fontBytes) document.registerFontkit(fontkit);
  const font = await document.embedFont(fontBytes ?? StandardFonts.Helvetica, {
    subset: true,
  });
  const content = `${text}\n\nElectronic acceptance receipt\n${JSON.stringify(receipt, null, 2)}`;
  const glyphs = new Set(font.getCharacterSet());
  requireCondition(
    [...content].every(
      (character) =>
        character === "\n" || glyphs.has(character.codePointAt(0)!),
    ),
    400,
    "agreement_characters",
    "The configured agreement font cannot represent one or more characters. Contact the maintainer for a supported agreement.",
  );
  font.encodeText(content.replace(/\n/g, " "));
  let page = document.addPage([595, 842]);
  let y = 800;
  for (const paragraph of content.split("\n")) {
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      if (font.widthOfTextAtSize(`${line} ${word}`, 10) > 510 && line) {
        page.drawText(line, { x: 42, y, size: 10, font });
        y -= 14;
        line = "";
        if (y < 42) {
          page = document.addPage([595, 842]);
          y = 800;
        }
      }
      line += `${line ? " " : ""}${word}`;
    }
    page.drawText(line, { x: 42, y, size: 10, font });
    y -= 14;
    if (y < 42) {
      page = document.addPage([595, 842]);
      y = 800;
    }
  }
  return document.save();
}
export async function acceptAgreement(
  db: Db,
  config: Config,
  id: string,
  owner: Session,
  input: AgreementAcceptanceInput,
): Promise<AgreementReceipt> {
  requireCondition(
    config.agreement.signingEnabled,
    409,
    "agreement_unavailable",
    "The standard agreement is awaiting approval. You can submit without a model or without requesting an NDA.",
  );
  requireCondition(
    input.agreementSha256 === config.agreement.sha256,
    409,
    "agreement_changed",
    "The agreement changed. Review the current text.",
  );
  const acceptedAt = new Date().toISOString();
  const record = {
    ...input,
    reportId: id,
    acceptedAt,
    version: config.agreement.version,
    issuer: "LTplus AG",
    jurisdiction: "Switzerland",
  };
  const pdf = await agreementPdf(
    config.agreement.text,
    record,
    config.agreementFont,
  );
  const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
  return transaction(db, async (tx) => {
    const rows = await tx.query<ReportRow>(
      "SELECT * FROM model_reports WHERE id=$1 AND session_id=$2 AND expires_at>now() FOR UPDATE",
      [id, owner.id],
    );
    const report = rows.rows[0];
    requireCondition(
      report && report.status === "draft",
      409,
      "report_state",
      "An editable report is required.",
    );
    if (report.agreement?.agreementSha256 === input.agreementSha256)
      return {
        acceptedAt: String(report.agreement.acceptedAt),
        agreementSha256: input.agreementSha256,
        pdfUrl: `/api/reports/${id}/agreement.pdf`,
      };
    await tx.query(
      "UPDATE model_reports SET agreement=$2,agreement_pdf=$3 WHERE id=$1",
      [id, JSON.stringify({ ...record, pdfSha256 }), Buffer.from(pdf)],
    );
    await audit(tx, id, "standard_agreement_accepted", owner.id, {
      agreementSha256: input.agreementSha256,
      pdfSha256,
    });
    return {
      acceptedAt,
      agreementSha256: input.agreementSha256,
      pdfUrl: `/api/reports/${id}/agreement.pdf`,
    };
  });
}

export async function validateAgreementFont(config: Config): Promise<void> {
  if (!config.agreement.signingEnabled) return;
  if (!config.agreementFont)
    throw new Error("Approved agreement requires a licensed Unicode font");
  await agreementPdf(
    config.agreement.text,
    {
      issuer: "LTplus AG",
      reportId: "00000000-0000-4000-8000-000000000000",
      acceptedAt: "2026-01-01T00:00:00Z",
    },
    config.agreementFont,
  );
}
