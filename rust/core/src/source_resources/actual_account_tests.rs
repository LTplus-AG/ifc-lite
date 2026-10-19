// SPDX-License-Identifier: MPL-2.0
//! Execute the real geometry account, owned observer and pool, never Budget.
//! The witness lives beside its implementation so the dev-dependency's normal
//! core types are not substituted with this unit-test crate's distinct types.
#[test]
fn actual_account_metadata_weak_retains_original_pool_until_final_free() {
    ifc_lite_geometry::test_support::actual_metadata_weak_and_pool_witness();
}
#[test]
fn actual_owned_observer_forwards_early_faults_and_source_precedence_without_tls() {
    ifc_lite_geometry::test_support::actual_owned_fault_witness();
}
#[test]
fn actual_published_inner_survives_joined_worker_account_recovery() {
    ifc_lite_geometry::test_support::actual_joined_payload_witness();
}
#[test]
fn actual_zero_account_refuses_metadata_before_allocation_without_ambient_fallback() {
    ifc_lite_geometry::test_support::actual_zero_metadata_witness();
}

#[cfg(feature = "source-resource-gate-test-support")]
#[test]
fn normal_identity_actual_gate_container_metadata_and_weak_pool_lifetime() {
    ifc_lite_geometry::test_support::actual_gate_lifetime_witness();
}
#[cfg(feature = "source-resource-gate-test-support")]
#[test]
fn normal_identity_actual_gate_refused_growth_keeps_original_backing() {
    ifc_lite_geometry::test_support::actual_gate_refused_growth_witness();
}
#[cfg(feature = "source-resource-gate-test-support")]
#[test]
fn normal_identity_actual_gate_fresh_and_independently_stopped_faults() {
    ifc_lite_geometry::test_support::actual_gate_first_fault_witness();
}

#[cfg(feature = "source-resource-gate-test-support")]
#[test]
fn normal_identity_actual_gate_expired_work_refuses_spare_capacity_mutation() {
    ifc_lite_geometry::test_support::actual_gate_expired_work_witness();
}

#[cfg(feature = "source-resource-gate-test-support")]
#[test]
fn normal_identity_actual_gate_simulated_delegation_rollback_and_source_precedence() {
    ifc_lite_geometry::test_support::actual_gate_simulated_delegation_witness();
}
