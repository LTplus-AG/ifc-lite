---
"@ifc-lite/wasm": patch
---

Count type records whose geometry is omitted because the full decoder rejects them, as the additive `omittedTypeRecords` field of the version 1 pipeline diagnostics JSON (distinct records per load, never counted as input refusals). The native pipeline now drops the same records before scheduling instead of running jobs that can only fail, leaving mesh output unchanged, and reports them through the new defaulted `ProcessingSink::on_omitted_type_records` event.
