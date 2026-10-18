// SPDX-License-Identifier: MPL-2.0
//! Contextual BRep operand: owned Outer construction followed by owned Voids.
//! Source admission is eager here; production's conditional source reads and
//! contextual walk budgets remain a separate contract.
use super::ConstructionReports;
use crate::processors::{advanced_plan, faceted_plan};
use crate::processors::boolean::{BooleanClippingProcessor,
    brep_voids::plan::{VoidPreparation, VoidShellPlan}};
use crate::{BoolOp, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

#[derive(Debug, Clone)]
enum Outer {
    Faceted(faceted_plan::FacetedBrepPlan),
    Advanced(advanced_plan::AdvancedBrepPlan),
}
impl Outer {
    fn evaluate(self) -> Result<Mesh> {
        match self {
            Self::Faceted(plan) => Ok(plan.evaluate()),
            Self::Advanced(plan) => plan.evaluate(),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct BrepOperandPlan {
    outer: Outer,
    voids: VoidShellPlan,
    operator: BoolOp,
    operand_type: IfcType,
    length_unit_scale: f64,
}
impl BrepOperandPlan {
    pub(super) fn lower(entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: TessellationQuality, operator: BoolOp) -> Result<Self> {
        let (outer, shell_kind) = match entity.ifc_type {
            IfcType::IfcFacetedBrepWithVoids => (
                Outer::Faceted(faceted_plan::lower(entity, decoder, None)?),
                IfcType::IfcFacetedBrep),
            IfcType::IfcAdvancedBrepWithVoids => (
                Outer::Advanced(advanced_plan::lower_brep(entity, decoder, quality, None)?),
                IfcType::IfcAdvancedBrep),
            _ => unreachable!("only contextual WithVoids operands use this constructor"),
        };
        let voids = VoidShellPlan::lower(entity, &shell_kind, decoder, quality);
        Ok(Self { outer, voids, operator, operand_type: entity.ifc_type.clone(),
            length_unit_scale: decoder.length_unit_scale() })
    }

    pub(super) fn source_reports(&self) -> ConstructionReports {
        self.voids.source_reports()
    }

    /// The caller owns the recorder and must drain it even on an error.
    /// Face/curve flags use the surrounding graph diagnostic capture scope.
    pub(super) fn evaluate(self, recorder: &BooleanClippingProcessor) -> Result<(Mesh, bool)> {
        let outer = self.outer.evaluate()?;
        if outer.is_empty() { return Ok((outer, false)); }
        // evaluate_shells replays each source report before that shell's
        // numerical work, and stops after the first refused/empty shell.
        Ok(match self.voids.evaluate_shells(recorder, self.operator) {
            VoidPreparation::Bypass => (outer, false),
            VoidPreparation::Refused => (Mesh::new(), true),
            VoidPreparation::Ready(ready) => ready.subtract(outer, self.length_unit_scale,
                recorder, self.operator, &self.operand_type),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GeometryRouter, kernel::mesh_volume::mesh_volume};

    // Analytic cubes with independently authored six-face shell topology.
    fn shell(first: u32, low: f64, high: f64, advanced: bool) -> String {
        let mut source = String::new();
        for corner in 0..8 {
            let coordinate = |axis| if corner & (1_u32 << axis) == 0_u32 { low } else { high };
            source.push_str(&format!("#{}=IFCCARTESIANPOINT(({},{},{}));",
                first + 1 + corner, coordinate(0), coordinate(1), coordinate(2)));
        }
        let mut faces = Vec::new();
        for (i, corners) in [[0,2,3,1], [4,5,7,6], [0,1,5,4],
            [1,3,7,5], [3,2,6,7], [2,0,4,6]].iter().enumerate() {
            let id = first + 10 + i as u32 * 3;
            let points = corners.iter().map(|c| format!("#{}", first + 1 + c))
                .collect::<Vec<_>>().join(",");
            source.push_str(&format!("#{id}=IFCPOLYLOOP(({points}));#{}=IFCFACEOUTERBOUND(#{id},.T.);", id+1));
            source.push_str(&if advanced {
                format!("#{}=IFCADVANCEDFACE((#{}),#9000,.T.);", id+2,id+1)
            } else { format!("#{}=IFCFACE((#{}));",id+2,id+1) });
            faces.push(format!("#{}",id+2));
        }
        source.push_str(&format!("#{first}=IFCCLOSEDSHELL(({}));",faces.join(",")));
        source
    }
    fn fixture(advanced: bool, voids: &str) -> String {
        let kind = if advanced { "IFCADVANCEDBREPWITHVOIDS" } else { "IFCFACETEDBREPWITHVOIDS" };
        format!("{}{}#91={kind}(#100,{voids});#92=IFCBLOCK($,2.,2.,2.);\
            #93=IFCBOOLEANRESULT(.DIFFERENCE.,#91,#92);\
            #94=IFCBOOLEANRESULT(.DIFFERENCE.,#92,#91);\
            #95=IFCBOOLEANRESULT(.UNION.,#92,#91);\
            #96=IFCBOOLEANRESULT(.INTERSECTION.,#92,#91);\
            #9000=IFCPLANE(#9001);#9001=IFCAXIS2PLACEMENT3D(#9002,$,$);\
            #9002=IFCCARTESIANPOINT((0.,0.,0.));",
            shell(100,0.,2.,advanced),shell(200,0.5,1.5,advanced))
    }
    fn assert_volume(mesh: &Mesh, expected: f64) {
        assert!((mesh_volume(mesh)-expected).abs()<1e-5,
            "volume {}, expected {expected}",mesh_volume(mesh));
    }

    #[test]
    fn graph_owns_voids_after_source_disposal_and_keeps_root_base_and_operation_roles() {
        for advanced in [false,true] {
            let batch = {
                let source = fixture(advanced,"(#200)");
                GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&source),
                    &[91,93,94,95,96,94],6).unwrap()
            };
            assert!(batch.nodes().iter().all(|node|node.requirement().is_none()));
            let result = batch.evaluate().unwrap();
            for (mesh, expected) in result.definitions.iter().zip([8.,0.,1.,8.,7.]) {
                assert_volume(mesh,expected);
            }
            assert_eq!(result.occurrences,[0,1,2,3,4,2]);
            assert!(result.diagnostics.iter().all(Vec::is_empty));
        }
    }

    #[test]
    fn graph_refused_void_records_operation_once_and_never_cuts_with_outer_shell() {
        for advanced in [false,true] {
            let source = fixture(advanced,"($)");
            let batch = GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&source),
                &[91,94,95,96],4).unwrap();
            let result = batch.evaluate().unwrap();
            for (mesh, expected) in result.definitions.iter().zip([8.,8.,8.,0.]) {
                assert_volume(mesh,expected);
            }
            assert!(result.diagnostics[0].is_empty());
            for (failures, operator) in result.diagnostics[1..].iter()
                .zip([BoolOp::Difference,BoolOp::Union,BoolOp::Intersection]) {
                assert_eq!(failures.len(),1,"no duplicate EmptyOperand record");
                assert_eq!(failures[0].op,operator);
                assert!(matches!(&failures[0].reason,crate::BoolFailureReason::KernelError(message)
                    if message.contains("void is not a shell reference")));
            }
            assert_eq!(result.observed_diagnostics.len(),3);
            assert!(result.observed_diagnostics.iter().all(|record|record.source_id==91));
        }
    }
}
