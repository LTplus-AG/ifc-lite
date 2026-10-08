---
"@ifc-lite/ids-authoring": minor
---

IDS test suites: `StudioMeta.tests` is now typed (`TestSuite`, `TestCase`, `TestFixture`, `FixtureRecipe`) and changes through new ops `meta.test.add`, `meta.test.remove`, `meta.test.setExpectation` (inverse `meta.test.restore`). `runTestSuites(doc, evaluate)` runs the cases headlessly with a host-supplied evaluator and compares each outcome with its expectation (including the exact requirements that must fail); `outcomeFromSpecResult` maps a `validateIDS` result, `junitXml` writes JUnit XML for CI and `testSuitesView` is the view model for a test panel.
