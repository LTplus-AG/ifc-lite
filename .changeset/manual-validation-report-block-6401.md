---
"@ifc-lite/viewer": minor
---

Documents have a Manual validation report block ([#6401](https://github.com/LTplus-AG/ifc-lite/issues/6401)). It stores a frozen snapshot of the checklist from Data validation → Manual validation and one model's answers: every group and check with its verdict, comment and guidance, and the counts per group. The preview and the PDF show an overall ring and one ring per group next to the counts in words, and each verdict as a word. **Refresh from current checklist** takes a new snapshot. Document files move to version 7 for the new block; version 1–6 files open and re-save as version 7, and an older viewer reports a version 7 file as newer instead of broken. A saved block whose counts do not match its verdicts is refused on load.
