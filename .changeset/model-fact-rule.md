---
"@ifc-lite/rules": minor
"@ifc-lite/viewer": minor
---

A new `modelFact` rule and subject checks facts about an element's model rather than the element itself. Facts cover georeferencing (`georef.crs`, `georef.eastings`, …), project units (`units.length`, …) and STEP header fields (`header.author`, `header.originatingSystem`, `header.schema`, …). Every value operator works on them in search, applicability and validation. "The project is georeferenced and in millimetres" becomes an `IfcProject` rule with two model-fact conditions. The requirement-text spelling is `model.<fact>`. `MODEL_FACTS` lists the facts. The IDS export refuses model facts, because IDS has no model-level facet. The viewer's rule builders offer it as "Model fact".
