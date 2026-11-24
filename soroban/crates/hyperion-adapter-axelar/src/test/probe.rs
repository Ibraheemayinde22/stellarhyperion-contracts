//! The read-only token-manager compatibility probe.
//!
//! Every failure case here is a local fixture: an ITS that reports an unreviewed manager type, one
//! that answers with the wrong type, an ITS build that does not export the paid-send gas read at
//! all, and a lookalike token that copies the real asset's symbol, name and decimals.

use hyperion_core::{
    axelar::{
        DestinationCapability, ProbeBlocker, ReadStatus, TokenManagerProbe,
        TOKEN_MANAGER_PROBE_VERSION,
    },
    RouteKind,
};
use soroban_sdk::{testutils::Events, vec, Address, BytesN, String, Symbol, Vec};

use super::doubles::{LegacyIts, LegacyItsClient, LookalikeToken, LookalikeTokenClient};
use super::setup::{World, MB_TOKEN_ID};
use crate::rail::TokenManagerType;
use crate::{AxelarAdapter, AxelarAdapterClient};

/// The ITS shape with a gas token configured, which is what paid dispatch needs.
fn paid_world() -> World {
    let w = World::new();
    w.its().set_native(&w.lock_asset);
    w
}

fn probe(w: &World, token: &Address) -> TokenManagerProbe {
    w.bare().probe_token_manager(token, &w.ethereum())
}

fn status_of(env: &soroban_sdk::Env, probe: &TokenManagerProbe, method: &str) -> ReadStatus {
    let name = Symbol::new(env, method);
    probe
        .reads
        .iter()
        .find(|read| read.method == name)
        .map(|read| read.status)
        .expect("every probed method is recorded")
}

fn method(w: &World, name: &str) -> ProbeBlocker {
    ProbeBlocker::MethodUnavailable(Symbol::new(&w.env, name))
}

// ------------------------------------------------------------------------------------------
// Ready lanes
// ------------------------------------------------------------------------------------------

#[test]
fn a_burning_token_on_a_trusted_admitted_lane_is_ready_from_real_reads() {
    let w = paid_world();
    let report = probe(&w, &w.token_id);

    assert!(report.ready, "{:?}", report.blockers);
    assert_eq!(report.version, TOKEN_MANAGER_PROBE_VERSION);
    assert_eq!(report.route, RouteKind::AxelarIts);
    assert_eq!(report.token_id, Some(w.burn_id()));
    assert_eq!(report.reverse_token, Some(w.token_id.clone()));
    assert_eq!(report.rail_token, Some(w.token_id.clone()));
    assert_eq!(report.manager_type, Some(TokenManagerType::MintBurn as u32));
    assert_eq!(report.admitted_manager_type, report.manager_type);
    assert!(report.capability_bound);
    assert_eq!(report.axelar_chain, Some(w.axelar_ethereum()));
    assert!(report.chain_enabled);
    assert_eq!(report.rail_trusts_chain, Some(true));
    assert_eq!(report.gas_token, Some(w.lock_asset.clone()));
    for read in report.reads.iter() {
        assert_eq!(read.status, ReadStatus::Available, "{:?}", read.method);
    }
    // A burning manager does not need a deployed manager, so that read is optional here.
    let manager = report
        .reads
        .iter()
        .find(|r| r.method == Symbol::new(&w.env, "deployed_token_manager"))
        .unwrap();
    assert!(!manager.required);
}

#[test]
fn a_lock_unlock_token_requires_and_reports_its_deployed_manager() {
    let w = paid_world();
    let report = probe(&w, &w.lock_asset);
    assert!(report.ready, "{:?}", report.blockers);
    assert_eq!(
        report.manager_type,
        Some(TokenManagerType::LockUnlock as u32)
    );
    assert_eq!(report.manager, Some(w.manager_id.clone()));
    let manager = report
        .reads
        .iter()
        .find(|r| r.method == Symbol::new(&w.env, "deployed_token_manager"))
        .unwrap();
    assert!(manager.required);
}

#[test]
fn the_probe_writes_nothing_publishes_nothing_and_repeats_exactly() {
    let w = paid_world();
    let first = probe(&w, &w.token_id);
    assert!(w.env.events().all().events().is_empty());
    let second = probe(&w, &w.token_id);
    assert_eq!(first, second);
}

// ------------------------------------------------------------------------------------------
// Manager types
// ------------------------------------------------------------------------------------------

#[test]
fn an_unreviewed_manager_type_blocks_activation() {
    let w = paid_world();
    w.its()
        .set_raw_manager_type(&BytesN::from_array(&w.env, &MB_TOKEN_ID), &3);
    let report = probe(&w, &w.token_id);
    assert!(!report.ready);
    assert_eq!(report.manager_type, Some(3));
    assert_eq!(
        report.blockers,
        vec![&w.env, ProbeBlocker::UnknownManagerType(3)]
    );
    // The typed read the dispatch path relies on refuses the same token rather than guessing.
    assert!(w.bare().try_manager_type_for(&w.token_id).is_err());
}

#[test]
fn a_wrongly_typed_manager_answer_is_malformed_and_blocks() {
    let w = paid_world();
    w.its()
        .set_malformed_manager_type(&BytesN::from_array(&w.env, &MB_TOKEN_ID));
    let report = probe(&w, &w.token_id);
    assert_eq!(report.manager_type, None);
    assert_eq!(
        status_of(&w.env, &report, "token_manager_type"),
        ReadStatus::Malformed
    );
    assert_eq!(
        report.blockers,
        vec![
            &w.env,
            ProbeBlocker::ManagerTypeUnreadable,
            method(&w, "token_manager_type")
        ]
    );
}

#[test]
fn a_manager_type_changed_since_admission_is_stale() {
    let w = paid_world();
    w.its().register(
        &w.burn_id(),
        &w.token_id,
        &w.manager_id,
        &TokenManagerType::LockUnlock,
    );
    let report = probe(&w, &w.token_id);
    assert_eq!(
        report.blockers,
        vec![
            &w.env,
            ProbeBlocker::CapabilityStale(TokenManagerType::MintBurn as u32)
        ]
    );
}

// ------------------------------------------------------------------------------------------
// Missing methods
// ------------------------------------------------------------------------------------------

#[test]
fn an_its_build_without_the_paid_gas_read_blocks_activation() {
    let w = World::unlinked();
    let legacy_id = w.env.register(LegacyIts, ());
    LegacyItsClient::new(&w.env, &legacy_id).register(
        &w.burn_id(),
        &w.token_id,
        &w.manager_id,
        &TokenManagerType::MintBurn,
    );
    let adapter_id = w.env.register(AxelarAdapter, ());
    let adapter = AxelarAdapterClient::new(&w.env, &adapter_id);
    adapter.initialize(&w.admin, &w.router_id, &legacy_id, &RouteKind::AxelarIts);
    adapter.link_chain(
        &w.ethereum(),
        &w.axelar_ethereum(),
        &BytesN::from_array(&w.env, &[0u8; 20]),
    );
    adapter.map_token(&w.token_id, &w.burn_id());
    adapter.set_destination_capability(
        &w.ethereum(),
        &w.token_id,
        &DestinationCapability::DirectItsTransfer,
    );

    let report = adapter.probe_token_manager(&w.token_id, &w.ethereum());
    assert!(!report.ready);
    assert_eq!(report.gas_token, None);
    assert_eq!(
        status_of(&w.env, &report, "native_token_address"),
        ReadStatus::Unavailable
    );
    assert_eq!(
        report.blockers,
        vec![&w.env, method(&w, "native_token_address")]
    );
}

#[test]
fn an_unconfigured_gas_token_is_not_reported_as_paid_support() {
    // Same ITS, but nobody told it which asset pays for gas: the read traps.
    let w = World::new();
    let report = probe(&w, &w.token_id);
    assert_eq!(report.gas_token, None);
    assert_eq!(
        report.blockers,
        vec![&w.env, method(&w, "native_token_address")]
    );
}

// ------------------------------------------------------------------------------------------
// Mapping identity
// ------------------------------------------------------------------------------------------

#[test]
fn a_lookalike_with_the_same_symbol_never_qualifies() {
    let w = paid_world();
    let lookalike = w.env.register(LookalikeToken, ());
    let real = w.token();
    LookalikeTokenClient::new(&w.env, &lookalike).copy_metadata(
        &real.symbol(),
        &real.name(),
        &real.decimals(),
    );

    // Not mapped here: no rail read is even attempted for it.
    let report = probe(&w, &lookalike);
    assert_eq!(report.token_id, None);
    assert_eq!(report.blockers.first(), Some(ProbeBlocker::TokenNotMapped));
    for name in ["registered_token_address", "token_manager_type"] {
        assert_eq!(status_of(&w.env, &report, name), ReadStatus::NotRead);
    }

    // And when ITS itself points the id at the lookalike, the real token stops qualifying
    // even though every piece of metadata still matches.
    w.its().register(
        &w.burn_id(),
        &lookalike,
        &w.manager_id,
        &TokenManagerType::MintBurn,
    );
    let report = probe(&w, &w.token_id);
    assert_eq!(
        report.blockers,
        vec![&w.env, ProbeBlocker::RailTokenMismatch(lookalike)]
    );
}

#[test]
fn an_id_axelar_never_registered_is_unregistered() {
    let w = paid_world();
    // A local mapping that names a token id ITS has no registration for.
    let forgotten = BytesN::from_array(&w.env, &[0x55; 32]);
    w.env.as_contract(&w.bare_id, || {
        crate::storage::set_token(&w.env, &w.token_id, &forgotten);
    });
    let report = probe(&w, &w.token_id);
    assert_eq!(report.rail_token, None);
    assert_eq!(
        status_of(&w.env, &report, "registered_token_address"),
        ReadStatus::Rejected
    );
    assert!(report.blockers.contains(&ProbeBlocker::UnregisteredTokenId));
    assert!(report
        .blockers
        .contains(&ProbeBlocker::ManagerTypeUnreadable));
    assert!(!report
        .blockers
        .contains(method(&w, "registered_token_address")));
}

// ------------------------------------------------------------------------------------------
// Remote trust, admission and route
// ------------------------------------------------------------------------------------------

#[test]
fn remote_trust_is_read_from_its_and_from_the_local_switch() {
    let w = paid_world();
    w.its().set_trusted(&w.axelar_ethereum(), &false);
    assert_eq!(
        probe(&w, &w.token_id).blockers,
        vec![&w.env, ProbeBlocker::ChainNotTrusted]
    );

    w.its().set_trusted(&w.axelar_ethereum(), &true);
    w.bare().set_chain_enabled(&w.ethereum(), &false);
    assert_eq!(
        probe(&w, &w.token_id).blockers,
        vec![&w.env, ProbeBlocker::ChainDisabled]
    );

    let report = w
        .bare()
        .probe_token_manager(&w.token_id, &String::from_str(&w.env, "nowhere"));
    assert_eq!(report.blockers, vec![&w.env, ProbeBlocker::ChainNotLinked]);
    assert_eq!(
        status_of(&w.env, &report, "is_trusted_chain"),
        ReadStatus::NotRead
    );
}

#[test]
fn a_mapping_without_admission_is_not_ready() {
    let w = World::unlinked();
    w.its().set_native(&w.lock_asset);
    w.link_ethereum();
    w.bare().map_token(&w.token_id, &w.burn_id());
    let blockers: Vec<ProbeBlocker> = probe(&w, &w.token_id).blockers;
    assert_eq!(blockers, vec![&w.env, ProbeBlocker::CapabilityNotAdmitted]);
}

#[test]
fn the_gmp_instance_never_reports_paid_send_support() {
    let w = paid_world();
    let report = w.adapter().probe_token_manager(&w.token_id, &w.ethereum());
    assert_eq!(report.route, RouteKind::AxelarGmp);
    assert!(report.capability_bound);
    assert_eq!(
        report.blockers,
        vec![&w.env, ProbeBlocker::PaidSendUnsupportedRoute]
    );
}
