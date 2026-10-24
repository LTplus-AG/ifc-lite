// SPDX-License-Identifier: MPL-2.0
//! Product-level diagnostic over the current source-only retained path.

#[path = "scan.rs"]
mod scan;

use ifc_lite_processing::retained_requests::{RetainedSourceRefusal, RetainedSources};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::PathBuf;

#[derive(Default, Serialize)]
pub struct Counts {
    pub products: usize,
    pub source_only_candidates: usize,
    pub refused_products: usize,
    pub source_admitted_products: usize,
    pub source_refused_products: usize,
    pub openings: usize,
    pub layered_products: usize,
    pub material_layer_usages: usize,
    pub mapped_items: usize,
    pub mapped_rigid: usize,
    pub mapped_scaled: usize,
    pub mapped_mirrored: usize,
    pub negative_scale: usize,
    pub styled_items: usize,
    pub textured_items: usize,
    pub palette_items: usize,
    pub boolean_items: usize,
    pub clipping_items: usize,
    pub boolean_operands: usize,
}

impl Counts {
    fn add(&mut self, other: &Self) {
        self.products += other.products;
        self.source_only_candidates += other.source_only_candidates;
        self.refused_products += other.refused_products;
        self.source_admitted_products += other.source_admitted_products;
        self.source_refused_products += other.source_refused_products;
        self.openings += other.openings;
        self.layered_products += other.layered_products;
        self.material_layer_usages += other.material_layer_usages;
        self.mapped_items += other.mapped_items;
        self.mapped_rigid += other.mapped_rigid;
        self.mapped_scaled += other.mapped_scaled;
        self.mapped_mirrored += other.mapped_mirrored;
        self.negative_scale += other.negative_scale;
        self.styled_items += other.styled_items;
        self.textured_items += other.textured_items;
        self.palette_items += other.palette_items;
        self.boolean_items += other.boolean_items;
        self.clipping_items += other.clipping_items;
        self.boolean_operands += other.boolean_operands;
    }
}

#[derive(Serialize)]
pub struct Product {
    pub ifc_type: String,
    pub representation_families: BTreeMap<String, usize>,
    pub source_admission: &'static str,
    pub verdict: &'static str,
    pub reasons: BTreeSet<String>,
    pub counts: Counts,
    #[serde(skip)]
    pub item_ids: BTreeSet<u32>,
}

#[derive(Serialize)]
pub struct Fixture {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub products: BTreeMap<u32, Product>,
    pub counts: Counts,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<String>,
}

#[derive(Serialize)]
pub struct Report {
    pub schema: &'static str,
    pub note: &'static str,
    pub fixtures: BTreeMap<String, Fixture>,
    pub aggregate: Counts,
    pub present: Vec<String>,
    pub missing: Vec<String>,
    pub unsupported_format: Vec<String>,
}

pub fn census_paths(paths: Vec<(String, PathBuf)>) -> Result<Report, Box<dyn std::error::Error>> {
    let mut report = Report {
        schema: "retained-coverage-census/v1",
        note: "Source-only potential: admitted sources are not complete product geometry; openings, booleans, layers and appearance are not evaluated. Openings count IfcRelVoidsElement links to each host.",
        fixtures: BTreeMap::new(),
        aggregate: Counts::default(),
        present: Vec::new(),
        missing: Vec::new(),
        unsupported_format: Vec::new(),
    };
    for (name, path) in paths {
        let (fixture, category) = if !path.exists() {
            (empty("missing"), &mut report.missing)
        } else {
            match path
                .extension()
                .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
                .as_deref()
            {
                Some("ifc") => {
                    let bytes = std::fs::read(&path)?;
                    (census_bytes(&bytes), &mut report.present)
                }
                Some("ifczip") => match read_ifczip(&path)? {
                    Some(bytes) => (census_bytes(&bytes), &mut report.present),
                    None => (empty("unsupported_format"), &mut report.unsupported_format),
                },
                _ => (empty("unsupported_format"), &mut report.unsupported_format),
            }
        };
        report.aggregate.add(&fixture.counts);
        category.push(name.clone());
        report.fixtures.insert(name, fixture);
    }
    report.present.sort();
    report.missing.sort();
    report.unsupported_format.sort();
    Ok(report)
}

fn read_ifczip(path: &PathBuf) -> Result<Option<Vec<u8>>, Box<dyn std::error::Error>> {
    let bytes = std::fs::read(path)?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut ifc_entry = None;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        if entry.name()?.to_ascii_lowercase().ends_with(".ifc")
            && ifc_entry.replace(index).is_some()
        {
            return Ok(None);
        }
    }
    let Some(index) = ifc_entry else {
        return Ok(None);
    };
    let mut entry = archive.by_index(index)?;
    if entry.size() > 512 * 1024 * 1024 {
        return Ok(None);
    }
    let mut content = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut content)?;
    Ok(Some(content))
}

fn empty(status: &'static str) -> Fixture {
    Fixture {
        status,
        sha256: None,
        products: BTreeMap::new(),
        counts: Counts::default(),
        diagnostics: Vec::new(),
    }
}

pub fn census_bytes(content: &[u8]) -> Fixture {
    let mut fixture = empty("present");
    let extrusions = RetainedSources::extrusions(content, None);
    let disks = RetainedSources::swept_disks(content, None);
    fixture.sha256 = Some(extrusions.model_sha256.clone());
    let (mut products, mut diagnostics) = scan::products(content);
    diagnostics.extend(extrusions.diagnostics.iter().cloned());
    diagnostics.extend(disks.diagnostics.iter().cloned());
    let mut source_refusals = Vec::new();
    for sources in [&extrusions, &disks] {
        for source in &sources.admitted {
            for occurrence in source.occurrences() {
                if let Some(product) = products.get_mut(&occurrence.product_id) {
                    product.source_admission = "admitted";
                }
            }
        }
        for refused in &sources.refused {
            let reason = format!("retained:{}", refusal_name(&refused.refusal));
            match refused.product_id {
                Some(id) => {
                    if let Some(product) = products.get_mut(&id) {
                        product.reasons.insert(reason);
                    }
                }
                None => source_refusals.push((refused.key.solid_id, reason)),
            }
        }
    }
    for (solid, reason) in source_refusals {
        for product in products.values_mut() {
            if product.item_ids.contains(&solid) {
                product.reasons.insert(reason.clone());
            }
        }
    }
    for product in products.values_mut() {
        if product.source_admission != "admitted" {
            product.reasons.insert("retained:no_admitted_source".into());
        }
        product.counts.products = 1;
        if product.source_admission == "admitted" {
            product.counts.source_admitted_products = 1;
        } else {
            product.counts.source_refused_products = 1;
        }
        let supported = product
            .representation_families
            .get("IfcExtrudedAreaSolid")
            .copied()
            .unwrap_or_default()
            + product
                .representation_families
                .get("IfcSweptDiskSolid")
                .copied()
                .unwrap_or_default();
        if supported > 1 {
            product
                .reasons
                .insert("product:multiple_sources_no_assembly".into());
        }
        if product.source_admission == "admitted" && product.reasons.is_empty() && supported == 1 {
            product.verdict = "source_only_candidate";
            product.counts.source_only_candidates = 1;
        } else {
            product.verdict = "refused";
            product.counts.refused_products = 1;
        }
        fixture.counts.add(&product.counts);
    }
    fixture.products = products;
    diagnostics.sort();
    fixture.diagnostics = diagnostics;
    fixture
}

fn refusal_name(refusal: &RetainedSourceRefusal) -> String {
    match refusal {
        RetainedSourceRefusal::Source(reason) => format!("Source/{reason:?}"),
        RetainedSourceRefusal::EnclosingBooleanUnevaluated => "EnclosingBooleanUnevaluated".into(),
        RetainedSourceRefusal::OccurrenceUnsupported(reason) => {
            format!("OccurrenceUnsupported/{reason}")
        }
        RetainedSourceRefusal::UnqualifiedOccurrenceTransform => {
            "UnqualifiedOccurrenceTransform".into()
        }
        other => format!("Other/{other:?}"),
    }
}

#[cfg(test)]
#[path = "logic_tests.rs"]
mod tests;
