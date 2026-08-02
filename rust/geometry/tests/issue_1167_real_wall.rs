// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #1167 ("weird wall hole cutting"), pinned on a
//! real wall isolated from the reporter's model (`IfcWallStandardCase`
//! `3YZDoaW3XDrOwfaQwnDhmu`, express #12426 of "Straadt Havn A3"): a wall
//! rotated ~13 deg in plan at world coordinates ~150 m, with five openings —
//! four extruded boxes (windows) and one `IfcFacetedBrep` (a door). The full
//! placement chain (project/site/building/storey) is preserved, so the wall
//! arrives at its true world position and orientation.
//!
//! Pre-fix the world-space tilted cut at those large coordinates BOTH over-cut
//! the wall (it removed ~22.5 of 26.0 m3 -- 86%, the windows came out far
//! bigger than the openings) AND fragmented the result into rim slivers /
//! cracks (~236 unpaired edges). The fix cuts a plan-rotated wall in its own
//! axis-aligned, origin-centred frame, where the exact subtract is clean and
//! f32-precise, then rotates the result back. This pins the cut against a
//! regression to that world-space behaviour.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const WALL_ID: u32 = 12426;

const IFC: &str = r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-1167 isolated rotated wall + voids'),'2;1');
FILE_NAME('1167_rotated_wall.ifc','2026-06-19T00:00:00',(''),(''),'ifc-lite extract','ifc-lite','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('1CGyzxdzHaJybf9L4wHy3R',#2,'\X\D8straadt Havn A3','Prosjektbeskrivelse',$,$,'Skissefase',(#3),#4);;
#2=IFCOWNERHISTORY(#6,#7,$,.NOCHANGE.,$,$,$,1781610686);;
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.01,#8,#9);;
#4=IFCUNITASSIGNMENT((#13,#14,#15,#16,#17,#18,#19,#20,#21,#22,#23,#24,#25,#26));;
#6=IFCPERSONANDORGANIZATION(#28,#29,$);;
#7=IFCAPPLICATION(#30,'28.3.2','Archicad 28.3.2 (6200) NOR FULL','Archicad');;
#8=IFCAXIS2PLACEMENT3D(#31,#32,#33);;
#9=IFCDIRECTION((0.,1.));;
#10=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#3,$,.MODEL_VIEW.,$);;
#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,#3,$,.MODEL_VIEW.,$);;
#13=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);;
#14=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);;
#15=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);;
#16=IFCCONVERSIONBASEDUNIT(#2186,.PLANEANGLEUNIT.,'DEGREE',#2187);;
#17=IFCCONVERSIONBASEDUNIT(#2188,.SOLIDANGLEUNIT.,'SQUAREDEGREE',#2189);;
#18=IFCMONETARYUNIT(.NOK.);;
#19=IFCCONVERSIONBASEDUNIT(#2190,.TIMEUNIT.,'Year',#2191);;
#20=IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.);;
#21=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.DEGREE_CELSIUS.);;
#22=IFCSIUNIT(*,.LUMINOUSINTENSITYUNIT.,$,.LUMEN.);;
#23=IFCSIUNIT(*,.ENERGYUNIT.,.MEGA.,.JOULE.);;
#24=IFCDERIVEDUNIT((#2192,#2193,#2194),.THERMALCONDUCTANCEUNIT.,$);;
#25=IFCDERIVEDUNIT((#2195,#2196,#2197),.SPECIFICHEATCAPACITYUNIT.,$);;
#26=IFCDERIVEDUNIT((#2198,#2199),.MASSDENSITYUNIT.,$);;
#28=IFCPERSON($,$,'Arkitekten',$,$,$,(#2204),(#2205,#2206));;
#29=IFCORGANIZATION($,'Arkitektkontoret',$,$,(#2207,#2208));;
#30=IFCORGANIZATION('GS','Graphisoft',$,$,$);;
#31=IFCCARTESIANPOINT((0.,0.,0.));;
#32=IFCDIRECTION((0.,0.,1.));;
#33=IFCDIRECTION((1.,0.,0.));;
#1055=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#4735));;
#1056=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#4737,#4738));;
#1057=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#4740,#4741));;
#1058=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#4743,#4744));;
#1059=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#4746,#4747));;
#1060=IFCSHAPEREPRESENTATION(#10,'Body','Brep',(#4749));;
#1718=IFCSHAPEREPRESENTATION(#11,'Axis','Curve2D',(#6360));;
#2186=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);;
#2187=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.0174532925199433),#6946);;
#2188=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);;
#2189=IFCMEASUREWITHUNIT(IFCPOSITIVELENGTHMEASURE(0.0003046174197867086),#6951);;
#2190=IFCDIMENSIONALEXPONENTS(0,0,1,0,0,0,0);;
#2191=IFCMEASUREWITHUNIT(IFCTIMEMEASURE(31557600.),#6952);;
#2192=IFCDERIVEDUNITELEMENT(#6949,1);;
#2193=IFCDERIVEDUNITELEMENT(#6950,-1);;
#2194=IFCDERIVEDUNITELEMENT(#6954,-1);;
#2195=IFCDERIVEDUNITELEMENT(#6961,1);;
#2196=IFCDERIVEDUNITELEMENT(#6953,-1);;
#2197=IFCDERIVEDUNITELEMENT(#6955,-1);;
#2198=IFCDERIVEDUNITELEMENT(#6956,1);;
#2199=IFCDERIVEDUNITELEMENT(#6957,-1);;
#2200=IFCLOCALPLACEMENT($,#6958);;
#2204=IFCACTORROLE(.USERDEFINED.,'Ark:',$);;
#2205=IFCPOSTALADDRESS(.USERDEFINED.,$,'Architect Postal Address',$,('Arkitektveien 26'),$,'Arkitektbyen',$,'0000',$);;
#2206=IFCTELECOMADDRESS(.USERDEFINED.,$,'Architect Telecom Address',('000 000 00'),$,$,('arkitekt@arkitektfirma.no'),'www.arkitektfirma.no');;
#2207=IFCPOSTALADDRESS(.USERDEFINED.,$,'Architect Postal Address',$,('Arkitektveien 26'),$,'Arkitektbyen',$,'0000',$);;
#2208=IFCTELECOMADDRESS(.USERDEFINED.,$,'Architect Telecom Address',('000 000 00'),$,$,('arkitekt@arkitektfirma.no'),'www.arkitektfirma.no');;
#4735=IFCEXTRUDEDAREASOLID(#12423,#12424,#12425,3000.);;
#4736=IFCPRODUCTDEFINITIONSHAPE($,$,(#1055,#1718));;
#4737=IFCEXTRUDEDAREASOLID(#12427,#12428,#12429,715.0000000000001);;
#4738=IFCEXTRUDEDAREASOLID(#12430,#12431,#12432,671.);;
#4739=IFCPRODUCTDEFINITIONSHAPE($,$,(#1056));;
#4740=IFCEXTRUDEDAREASOLID(#12434,#12435,#12436,706.);;
#4741=IFCEXTRUDEDAREASOLID(#12437,#12438,#12439,680.);;
#4742=IFCPRODUCTDEFINITIONSHAPE($,$,(#1057));;
#4743=IFCEXTRUDEDAREASOLID(#12441,#12442,#12443,844.0000000000001);;
#4744=IFCEXTRUDEDAREASOLID(#12444,#12445,#12446,542.);;
#4745=IFCPRODUCTDEFINITIONSHAPE($,$,(#1058));;
#4746=IFCEXTRUDEDAREASOLID(#12448,#12449,#12450,844.0000000000001);;
#4747=IFCEXTRUDEDAREASOLID(#12451,#12452,#12453,542.);;
#4748=IFCPRODUCTDEFINITIONSHAPE($,$,(#1059));;
#4749=IFCFACETEDBREP(#12456);;
#4750=IFCPRODUCTDEFINITIONSHAPE($,$,(#1060));;
#6360=IFCPOLYLINE((#15464,#15465));;
#6946=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);;
#6949=IFCSIUNIT(*,.POWERUNIT.,$,.WATT.);;
#6950=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);;
#6951=IFCSIUNIT(*,.SOLIDANGLEUNIT.,$,.STERADIAN.);;
#6952=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);;
#6953=IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.);;
#6954=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.);;
#6955=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.);;
#6956=IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.);;
#6957=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);;
#6958=IFCAXIS2PLACEMENT3D(#22717,#22718,#22719);;
#6959=IFCLOCALPLACEMENT(#2200,#22720);;
#6961=IFCSIUNIT(*,.ENERGYUNIT.,$,.JOULE.);;
#12423=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'*YV-02- teglvegg (462 x 18634)',#33902);;
#12424=IFCAXIS2PLACEMENT3D(#33910,#33911,#33912);;
#12425=IFCDIRECTION((0.,0.,1.));;
#12426=IFCWALLSTANDARDCASE('3YZDoaW3XDrOwfaQwnDhmu',#2,'231.01','',$,#33917,#4736,'E28CDCA4-8038-4DD5-8EA9-91AEB136BC38');;
#12427=IFCRECTANGLEPROFILEDEF(.AREA.,'',#33916,1109.999999999985,2160.);;
#12428=IFCAXIS2PLACEMENT3D(#33918,#33919,#33920);;
#12429=IFCDIRECTION((0.,0.,-1.));;
#12430=IFCRECTANGLEPROFILEDEF(.AREA.,'',#33935,1109.999999999985,2160.);;
#12431=IFCAXIS2PLACEMENT3D(#33932,#33933,#33934);;
#12432=IFCDIRECTION((0.,0.,-1.));;
#12433=IFCOPENINGELEMENT('0EQTVSG_xSnDWI_yg0sFUv',#2,'B-D1-V-12',$,$,#33938,#4739,'0E69D7DC-43EE-DCC4-D812-FBCA80D8F7B9');;
#12434=IFCRECTANGLEPROFILEDEF(.AREA.,'',#33937,1809.999999999974,2160.);;
#12435=IFCAXIS2PLACEMENT3D(#33936,#33942,#33943);;
#12436=IFCDIRECTION((0.,0.,-1.));;
#12437=IFCRECTANGLEPROFILEDEF(.AREA.,'',#33941,1810.000000000002,2160.);;
#12438=IFCAXIS2PLACEMENT3D(#33945,#33946,#33959);;
#12439=IFCDIRECTION((0.,0.,-1.));;
#12440=IFCOPENINGELEMENT('3HcuHqUZgBq9qZkQ3ljvat',#2,'B-D1-V-12',$,$,#33944,#4742,'D19B8474-7A3A-8BD0-9D23-B9A0EFB79937');;
#12441=IFCRECTANGLEPROFILEDEF(.AREA.,'',#33960,3510.000000000048,2310.);;
#12442=IFCAXIS2PLACEMENT3D(#33949,#33950,#33951);;
#12443=IFCDIRECTION((0.,0.,1.));;
#12444=IFCRECTANGLEPROFILEDEF(.AREA.,'',#33952,3510.000000000019,2310.);;
#12445=IFCAXIS2PLACEMENT3D(#33953,#33954,#33955);;
#12446=IFCDIRECTION((0.,0.,1.));;
#12447=IFCOPENINGELEMENT('00p_LD$zWVAhQ86fJIhcdM',#2,'B-D1-YD 02s',$,$,#33956,#4745,'00CFE54D-FFD8-1F2A-B688-1A94D2AE69D6');;
#12448=IFCRECTANGLEPROFILEDEF(.AREA.,'',#33964,2409.999999999996,2310.);;
#12449=IFCAXIS2PLACEMENT3D(#33961,#33962,#33963);;
#12450=IFCDIRECTION((0.,0.,-1.));;
#12451=IFCRECTANGLEPROFILEDEF(.AREA.,'',#33968,2409.999999999968,2310.);;
#12452=IFCAXIS2PLACEMENT3D(#33965,#33966,#33967);;
#12453=IFCDIRECTION((0.,0.,-1.));;
#12455=IFCOPENINGELEMENT('1WOlujtwkyc_S4YQMizIB1',#2,'B-D1-YD 02s',$,$,#33981,#4748,'6062FE2D-DFAB-BC9B-E704-89A5ACF522C1');;
#12456=IFCCLOSEDSHELL((#33969,#33971,#33972,#33973,#33974,#33975,#33976,#33977,#33978,#33979,#33980));;
#12457=IFCOPENINGELEMENT('1uqUNFbR7QpFXt_26t4tgR',#2,'B-D1-YD 02s',$,$,#33970,#4750,'78D1E5CF-95B1-DACC-F877-F821B7137A9B');;
#15464=IFCCARTESIANPOINT((0.,0.));;
#15465=IFCCARTESIANPOINT((18633.58945642543,0.));;
#22717=IFCCARTESIANPOINT((0.,0.,0.));;
#22718=IFCDIRECTION((0.,0.,1.));;
#22719=IFCDIRECTION((1.,0.,0.));;
#22720=IFCAXIS2PLACEMENT3D(#56236,#56237,#56238);;
#22723=IFCLOCALPLACEMENT(#6959,#56244);;
#33902=IFCPOLYLINE((#66415,#66416,#66417,#66418,#66415));;
#33910=IFCCARTESIANPOINT((0.,0.,0.));;
#33911=IFCDIRECTION((0.,0.,1.));;
#33912=IFCDIRECTION((1.,0.,0.));;
#33916=IFCAXIS2PLACEMENT2D(#66429,#66430);;
#33917=IFCLOCALPLACEMENT(#22723,#66426);;
#33918=IFCCARTESIANPOINT((0.,-148.0000000000103,1080.));;
#33919=IFCDIRECTION((0.,1.,0.));;
#33920=IFCDIRECTION((-1.,0.,0.));;
#33927=IFCRELVOIDSELEMENT('24rMNNeVjDKdP_ESpqFTG0',#2,$,$,#12426,#12433);;
#33928=IFCRELVOIDSELEMENT('1PTbAewC$8Ck7g9SBQrKhk',#2,$,$,#12426,#12440);;
#33929=IFCRELVOIDSELEMENT('02PtTIY$c9oWe63hheSj4A',#2,$,$,#12426,#12447);;
#33930=IFCRELVOIDSELEMENT('1hxwli_ynahFeTih7bPaJA',#2,$,$,#12426,#12455);;
#33931=IFCRELVOIDSELEMENT('3MFMfFHmf_7d8CW6eIN0mB',#2,$,$,#12426,#12457);;
#33932=IFCCARTESIANPOINT((0.,-148.0000000000032,1080.));;
#33933=IFCDIRECTION((0.,-1.,0.));;
#33934=IFCDIRECTION((-1.,0.,0.));;
#33935=IFCAXIS2PLACEMENT2D(#66436,#66437);;
#33936=IFCCARTESIANPOINT((0.,-182.9999999999998,1080.));;
#33937=IFCAXIS2PLACEMENT2D(#66438,#66439);;
#33938=IFCLOCALPLACEMENT(#33917,#66440);;
#33941=IFCAXIS2PLACEMENT2D(#66442,#66443);;
#33942=IFCDIRECTION((0.,-1.,0.));;
#33943=IFCDIRECTION((-1.,0.,0.));;
#33944=IFCLOCALPLACEMENT(#33917,#66444);;
#33945=IFCCARTESIANPOINT((0.,-183.000000000014,1080.));;
#33946=IFCDIRECTION((0.,1.,0.));;
#33949=IFCCARTESIANPOINT((0.,-321.0000000000122,1154.999999999999));;
#33950=IFCDIRECTION((0.,1.,0.));;
#33951=IFCDIRECTION((1.,0.,0.));;
#33952=IFCAXIS2PLACEMENT2D(#66445,#66446);;
#33953=IFCCARTESIANPOINT((0.,-321.0000000000051,1154.999999999999));;
#33954=IFCDIRECTION((0.,-1.,0.));;
#33955=IFCDIRECTION((1.,0.,0.));;
#33956=IFCLOCALPLACEMENT(#33917,#66447);;
#33959=IFCDIRECTION((-1.,0.,0.));;
#33960=IFCAXIS2PLACEMENT2D(#66449,#66450);;
#33961=IFCCARTESIANPOINT((0.,-320.999999999998,1154.999999999999));;
#33962=IFCDIRECTION((0.,-1.,0.));;
#33963=IFCDIRECTION((-1.,0.,0.));;
#33964=IFCAXIS2PLACEMENT2D(#66451,#66452);;
#33965=IFCCARTESIANPOINT((0.,-321.0000000000051,1154.999999999999));;
#33966=IFCDIRECTION((0.,1.,0.));;
#33967=IFCDIRECTION((-1.,0.,0.));;
#33968=IFCAXIS2PLACEMENT2D(#66453,#66454);;
#33969=IFCFACE((#66455));;
#33970=IFCLOCALPLACEMENT(#33917,#66456);;
#33971=IFCFACE((#66457));;
#33972=IFCFACE((#66458));;
#33973=IFCFACE((#66459));;
#33974=IFCFACE((#66460));;
#33975=IFCFACE((#66461));;
#33976=IFCFACE((#66462));;
#33977=IFCFACE((#66463));;
#33978=IFCFACE((#66464));;
#33979=IFCFACE((#66465));;
#33980=IFCFACE((#66466));;
#33981=IFCLOCALPLACEMENT(#33917,#66467);;
#56236=IFCCARTESIANPOINT((0.,0.,0.));;
#56237=IFCDIRECTION((0.,0.,1.));;
#56238=IFCDIRECTION((1.,0.,0.));;
#56244=IFCAXIS2PLACEMENT3D(#72682,#72683,#72684);;
#66415=IFCCARTESIANPOINT((0.,-401.0000000000069));;
#66416=IFCCARTESIANPOINT((18921.1009122387,-401.0000000000069));;
#66417=IFCCARTESIANPOINT((18589.85329980544,60.99999999998929));;
#66418=IFCCARTESIANPOINT((0.,60.99999999999284));;
#66426=IFCAXIS2PLACEMENT3D(#84059,#84060,#84061);;
#66429=IFCCARTESIANPOINT((0.,0.));;
#66430=IFCDIRECTION((1.,0.));;
#66436=IFCCARTESIANPOINT((0.,0.));;
#66437=IFCDIRECTION((1.,0.));;
#66438=IFCCARTESIANPOINT((0.,0.));;
#66439=IFCDIRECTION((1.,0.));;
#66440=IFCAXIS2PLACEMENT3D(#84086,#84087,#84088);;
#66442=IFCCARTESIANPOINT((0.,0.));;
#66443=IFCDIRECTION((1.,0.));;
#66444=IFCAXIS2PLACEMENT3D(#84094,#84095,#84096);;
#66445=IFCCARTESIANPOINT((0.,0.));;
#66446=IFCDIRECTION((1.,0.));;
#66447=IFCAXIS2PLACEMENT3D(#84097,#84098,#84099);;
#66449=IFCCARTESIANPOINT((0.,0.));;
#66450=IFCDIRECTION((1.,0.));;
#66451=IFCCARTESIANPOINT((0.,0.));;
#66452=IFCDIRECTION((1.,0.));;
#66453=IFCCARTESIANPOINT((0.,0.));;
#66454=IFCDIRECTION((1.,0.));;
#66455=IFCFACEOUTERBOUND(#84111,.T.);;
#66456=IFCAXIS2PLACEMENT3D(#84105,#84106,#84107);;
#66457=IFCFACEOUTERBOUND(#84109,.T.);;
#66458=IFCFACEOUTERBOUND(#84108,.T.);;
#66459=IFCFACEOUTERBOUND(#84110,.T.);;
#66460=IFCFACEOUTERBOUND(#84112,.T.);;
#66461=IFCFACEOUTERBOUND(#84113,.T.);;
#66462=IFCFACEOUTERBOUND(#84114,.T.);;
#66463=IFCFACEOUTERBOUND(#84237,.T.);;
#66464=IFCFACEOUTERBOUND(#84115,.T.);;
#66465=IFCFACEOUTERBOUND(#84128,.T.);;
#66466=IFCFACEOUTERBOUND(#84116,.T.);;
#66467=IFCAXIS2PLACEMENT3D(#84117,#84118,#84119);;
#72682=IFCCARTESIANPOINT((0.,0.,6900.));;
#72683=IFCDIRECTION((0.,0.,1.));;
#72684=IFCDIRECTION((1.,0.,0.));;
#84059=IFCCARTESIANPOINT((139969.2781354836,39204.73907616395,0.));;
#84060=IFCDIRECTION((0.,0.,1.));;
#84061=IFCDIRECTION((0.9735789028731603,0.2283508701106558,0.));;
#84086=IFCCARTESIANPOINT((8704.212801157211,0.,150.0000000000003));;
#84087=IFCDIRECTION((0.,0.,1.));;
#84088=IFCDIRECTION((1.,0.,0.));;
#84094=IFCCARTESIANPOINT((12285.48570129087,0.,150.0000000000003));;
#84095=IFCDIRECTION((0.,0.,1.));;
#84096=IFCDIRECTION((1.,0.,0.));;
#84097=IFCCARTESIANPOINT((2379.904591815631,0.,0.));;
#84098=IFCDIRECTION((0.,0.,1.));;
#84099=IFCDIRECTION((1.,0.,0.));;
#84105=IFCCARTESIANPOINT((16684.85329980541,0.,0.));;
#84106=IFCDIRECTION((0.,0.,1.));;
#84107=IFCDIRECTION((1.,0.,0.));;
#84108=IFCPOLYLOOP((#100755,#100756,#100753,#100757));;
#84109=IFCPOLYLOOP((#100755,#100758,#100761,#100762));;
#84110=IFCPOLYLOOP((#100753,#100754,#100759,#100757));;
#84111=IFCPOLYLOOP((#100758,#100755,#100757,#100759));;
#84112=IFCPOLYLOOP((#100760,#100758,#100759,#100754));;
#84113=IFCPOLYLOOP((#100758,#100760,#100763,#100764,#100761));;
#84114=IFCPOLYLOOP((#100761,#100764,#100765,#100762));;
#84115=IFCPOLYLOOP((#100756,#100760,#100754,#100753));;
#84116=IFCPOLYLOOP((#100764,#100763,#100766,#100765));;
#84117=IFCCARTESIANPOINT((6486.708205190638,0.,0.));;
#84118=IFCDIRECTION((0.,0.,1.));;
#84119=IFCDIRECTION((1.,0.,0.));;
#84128=IFCPOLYLOOP((#100760,#100756,#100766,#100763));;
#84237=IFCPOLYLOOP((#100756,#100755,#100762,#100765,#100766));;
#100753=IFCCARTESIANPOINT((-1805.000000000007,-4544.574693408044,2310.));;
#100754=IFCCARTESIANPOINT((-1805.000000000007,-4544.574693408044,0.));;
#100755=IFCCARTESIANPOINT((1805.000000000035,-320.999999999998,2310.));;
#100756=IFCCARTESIANPOINT((-1804.999999999978,-321.0000000000051,2310.));;
#100757=IFCCARTESIANPOINT((1804.999999999978,-4544.574693408044,2310.));;
#100758=IFCCARTESIANPOINT((1805.000000000035,-320.999999999998,0.));;
#100759=IFCCARTESIANPOINT((1804.999999999978,-4544.574693408044,0.));;
#100760=IFCCARTESIANPOINT((-1804.999999999978,-321.0000000000051,0.));;
#100761=IFCCARTESIANPOINT((1805.000000000007,200.4727033974092,0.));;
#100762=IFCCARTESIANPOINT((1805.000000000007,200.4727033974092,2310.));;
#100763=IFCCARTESIANPOINT((-1804.999999999978,4204.574693408055,0.));;
#100764=IFCCARTESIANPOINT((-1065.88576651535,4204.574693408063,0.));;
#100765=IFCCARTESIANPOINT((-1065.88576651535,4204.574693408063,2310.));;
#100766=IFCCARTESIANPOINT((-1804.999999999978,4204.574693408055,2310.));;
ENDSEC;
END-ISO-10303-21;"##;

/// Signed volume of a closed mesh via the divergence theorem, as a magnitude.
fn mesh_volume(m: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
    };
    (m.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0)
        .abs()
}

/// Unpaired directed edges on a 0.1 mm grid (the cut runs in a rotated frame;
/// the rotate-back jitters shared vertices in the low f32 digits, so an
/// exact-bit pairing over-reports -- 0.1 mm absorbs that, far below any real
/// gap). A low count means the cut stayed essentially watertight.
fn open_edges(m: &Mesh) -> i64 {
    use std::collections::HashMap;
    let q = |i: u32| {
        let b = i as usize * 3;
        (
            (m.positions[b] * 1.0e4).round() as i64,
            (m.positions[b + 1] * 1.0e4).round() as i64,
            (m.positions[b + 2] * 1.0e4).round() as i64,
        )
    };
    let mut edges: HashMap<((i64, i64, i64), (i64, i64, i64)), i64> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        let k = [q(t[0]), q(t[1]), q(t[2])];
        for (u, v) in [(0, 1), (1, 2), (2, 0)] {
            *edges.entry((k[u], k[v])).or_insert(0) += 1;
            *edges.entry((k[v], k[u])).or_insert(0) -= 1;
        }
    }
    edges.values().map(|c| c.abs()).sum()
}

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(h), Some(o)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(h).or_default().push(o);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

#[test]
fn rotated_wall_openings_not_overcut_or_fragmented() {
    let entity_index = build_entity_index(IFC);
    let mut decoder = EntityDecoder::with_index(IFC, entity_index);
    let router = GeometryRouter::with_units(IFC, &mut decoder);
    let void_index = build_void_index(IFC);

    let openings = void_index.get(&WALL_ID).cloned().unwrap_or_default();
    assert_eq!(openings.len(), 5, "expected 5 voids on wall #{WALL_ID}, got {openings:?}");

    let wall = decoder.decode_by_id(WALL_ID).expect("decode wall");
    let uncut = router.process_element(&wall, &mut decoder).expect("process wall");
    let uncut_vol = mesh_volume(&uncut);
    let (umn, umx) = uncut.bounds();
    assert!((uncut_vol - 25.995).abs() < 0.1, "uncut wall volume = {uncut_vol:.3}, expected ~25.995");

    let voided = router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("process wall with voids");
    let removed = uncut_vol - mesh_volume(&voided);

    // Over-cut guard: the world-space cut removed ~22.5 m3 (86% of the wall);
    // the openings actually total ~13 m3. Anything near the old value means the
    // wall is being carved far beyond its openings again.
    assert!(
        (9.0..16.0).contains(&removed),
        "opening cut removed {removed:.3} m3; expected ~13 (>16 is the #1167 over-cut)"
    );

    // Fragmentation guard: the world-space tilted cut left ~236 unpaired edges;
    // the local-frame cut is essentially watertight.
    let open = open_edges(&voided);
    assert!(
        open < 40,
        "voided wall has {open} unpaired edges -- the rotated cut fragmented (issue #1167)"
    );

    // No fly-away geometry: the cut only removes material, so the result stays
    // within the host's bounds.
    let (vmn, vmx) = voided.bounds();
    let tol = 0.05_f32;
    assert!(
        vmn.x >= umn.x - tol && vmn.y >= umn.y - tol && vmn.z >= umn.z - tol
            && vmx.x <= umx.x + tol && vmx.y <= umx.y + tol && vmx.z <= umx.z + tol,
        "voided bounds ({vmn:?}..{vmx:?}) escaped host bounds ({umn:?}..{umx:?})"
    );
}
