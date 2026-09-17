---
"@ifc-lite/bcf": patch
---

BCF exports now use the XML root shape Solibri reads. Every file names its buildingSMART schema (`xsi:noNamespaceSchemaLocation` = `version.xsd`, `project.xsd`, `markup.xsd` or `visinfo.xsd`), the unused `xmlns:xsd` declaration is gone, and `<Header><File>` omits `isExternal` when it is true (the schema default) and still writes it when false. Solibri 26.6.1 imported no topics from the previous shape. Output stays valid against the BCF 2.1 and 3.0 schemas, and older archives that carry `xmlns:xsd` or `isExternal="true"` still import.
