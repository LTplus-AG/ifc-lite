/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { secretEquals } from "../src/sessions.js";
import { PDFDocument } from "pdf-lib";
import { agreementPdf } from "../src/agreement.js";
describe("#7495 model reporting invariants", () => {
  it("creates an actual PDF acceptance receipt", async () => {
    const pdf = await agreementPdf("LTplus AG\nLimited use agreement", {
      reportId: "125be751-2d65-4323-8f52-030926151929",
      acceptedAt: "2026-10-12T12:00:00Z",
      sha256: "a".repeat(64),
    });
    const parsed = await PDFDocument.load(pdf);
    expect(parsed.getPageCount()).toBeGreaterThan(0);
    expect(parsed.getAuthor()).toBe("LTplus AG");
    expect(parsed.getSubject()).toBe(
      "Report 125be751-2d65-4323-8f52-030926151929",
    );
    expect(parsed.getCreationDate().toISOString()).toBe(
      "2026-10-12T12:00:00.000Z",
    );
  });
  it("rejects a wrong admin secret even with a different length", () => {
    expect(secretEquals("correct", "correct")).toBe(true);
    expect(secretEquals("correct", "incorrect-long")).toBe(false);
  });
});
