//! Versioned fee accounting events (`cctp_fee_out`, `cctp_fee_in`).
//!
//! Each success case checks the new record alongside the unchanged `cctp_out` / `cctp_in` event,
//! so indexers that only know the old shapes keep decoding exactly what they did before. Each
//! failure case uses a local fixture (reverting messenger, messenger that burns nothing,
//! transmitter that under-mints) and checks that no accounting record is committed.

use hyperion_core::{
    cctp::{FEE_ACCOUNTING_VERSION, FINALITY_THRESHOLD_FAST, FINALITY_THRESHOLD_FINALIZED},
    HyperionError, RouteKind, STELLAR_DECIMALS,
};
use hyperion_router::{Destination, OutboundRequest};
use soroban_sdk::{events::Event as _, testutils::Events, BytesN};

use super::setup::{net_of, World, ETHEREUM_DOMAIN, EVM_DECIMALS, HUNDRED};
use crate::{events, FinalityPolicy};

const ARRIVING: i128 = 500_000_000;

fn request(w: &World) -> OutboundRequest {
    let mut recipient = [0u8; 32];
    recipient[12..].fill(0x11);
    OutboundRequest {
        token: w.token_id.clone(),
        amount: HUNDRED,
        route: RouteKind::Cctp,
        destination: Destination {
            chain: w.ethereum(),
            address: BytesN::from_array(&w.env, &recipient),
            mapping_revision: 1,
        },
        destination_decimals: EVM_DECIMALS,
        min_destination_amount: 0,
    }
}

fn published<E: soroban_sdk::events::Event>(w: &World, event: &E) -> bool {
    w.env
        .events()
        .all()
        .events()
        .contains(&event.to_xdr(&w.env, &w.adapter_id))
}

/// Count of `cctp_fee_out` records for this token and lane, whatever their body.
fn fee_out_count(w: &World) -> usize {
    let probe = events::BurnAccounted {
        token: w.token_id.clone(),
        destination_domain: ETHEREUM_DOMAIN,
        version: 0,
        router_nonce: 0,
        source_decimals: 0,
        source_debit: 0,
        fee_budget: 0,
        burned: 0,
        retained: 0,
        forwarding: false,
        min_finality_threshold: 0,
    }
    .to_xdr(&w.env, &w.adapter_id);
    let topics = match &probe.body {
        soroban_sdk::xdr::ContractEventBody::V0(v0) => v0.topics.clone(),
    };
    w.env
        .events()
        .all()
        .events()
        .iter()
        .filter(|e| match &e.body {
            soroban_sdk::xdr::ContractEventBody::V0(v0) => v0.topics == topics,
        })
        .count()
}

fn burn_accounted(
    w: &World,
    router_nonce: u64,
    source_debit: i128,
    fee_budget: i128,
    burned: i128,
    forwarding: bool,
    threshold: u32,
) -> events::BurnAccounted {
    events::BurnAccounted {
        token: w.token_id.clone(),
        destination_domain: ETHEREUM_DOMAIN,
        version: FEE_ACCOUNTING_VERSION,
        router_nonce,
        source_decimals: STELLAR_DECIMALS,
        source_debit,
        fee_budget,
        burned,
        retained: source_debit - burned,
        forwarding,
        min_finality_threshold: threshold,
    }
}

// ------------------------------------------------------------------------------------------
// Outbound
// ------------------------------------------------------------------------------------------

#[test]
fn a_finalized_burn_records_a_zero_budget_and_the_exact_burn_beside_the_legacy_event() {
    let w = World::new();
    let nonce = w.router().bridge_out(&w.user, &request(&w));
    let net = net_of(HUNDRED);

    assert!(published(
        &w,
        &burn_accounted(&w, nonce, net, 0, net, false, FINALITY_THRESHOLD_FINALIZED)
    ));
    // The existing `cctp_out` event keeps its exact shape and values.
    assert!(published(
        &w,
        &events::Dispatched {
            token: w.token_id.clone(),
            destination_domain: ETHEREUM_DOMAIN,
            amount: net,
            mint_recipient: request(&w).destination.address,
            max_fee: 0,
            min_finality_threshold: FINALITY_THRESHOLD_FINALIZED,
            mapping_revision: 1,
            router_nonce: nonce,
        }
    ));
    assert_eq!(fee_out_count(&w), 1);
}

#[test]
fn dust_is_reported_as_retained_and_conserves_the_debit_despite_prior_adapter_balance() {
    let w = World::new();
    // Prior dust already sitting in the adapter must not be counted as part of this burn.
    w.fund_adapter(5);
    w.messenger().init(&7i128, &0i128);
    let nonce = w.router().bridge_out(&w.user, &request(&w));
    let net = net_of(HUNDRED);

    let expected = burn_accounted(&w, nonce, net, 0, net - 7, false, 2000);
    assert_eq!(expected.retained, 7);
    assert_eq!(expected.burned + expected.retained, expected.source_debit);
    assert!(published(&w, &expected));
    assert_eq!(w.messenger().last_burn().burned, expected.burned);
    assert_eq!(w.token().balance(&w.adapter_id), 5 + 7);
}

#[test]
fn a_fast_lane_records_the_bps_budget_in_source_units() {
    let w = World::new();
    w.adapter()
        .set_fee_policy(&5, &FINALITY_THRESHOLD_FINALIZED);
    w.adapter()
        .set_lane_finality_policy(&ETHEREUM_DOMAIN, &FinalityPolicy::Fast);
    let nonce = w.router().bridge_out(&w.user, &request(&w));
    let net = net_of(HUNDRED);
    let budget = net * 5 / 10_000;

    // Read events before any further contract call replaces the recorded invocation.
    assert!(published(
        &w,
        &burn_accounted(&w, nonce, net, budget, net, false, FINALITY_THRESHOLD_FAST)
    ));
    assert_eq!(w.messenger().last_burn().max_fee, budget);
}

#[test]
fn paid_forwarding_records_the_caller_budget_and_is_flagged_as_forwarding() {
    let w = World::new();
    let nonce = w
        .router()
        .bridge_out_with_gas(&w.user, &request(&w), &1_000_000);
    let net = net_of(HUNDRED);

    assert!(published(
        &w,
        &burn_accounted(&w, nonce, net, 1_000_000, net, true, 2000)
    ));
    assert!(!published(
        &w,
        &burn_accounted(&w, nonce, net, 1_000_000, net, false, 2000)
    ));
    assert_eq!(fee_out_count(&w), 1);
}

#[test]
fn a_reverting_messenger_commits_no_accounting_on_either_burn_path() {
    for paid in [false, true] {
        let w = World::new();
        w.messenger().set_should_revert(&true);
        let user_before = w.token().balance(&w.user);
        let failed = if paid {
            w.router()
                .try_bridge_out_with_gas(&w.user, &request(&w), &1_000_000)
                .is_err()
        } else {
            w.router().try_bridge_out(&w.user, &request(&w)).is_err()
        };
        assert!(failed);
        assert_eq!(fee_out_count(&w), 0);
        assert_eq!(w.token().balance(&w.user), user_before);
        assert_eq!(w.router().last_out_nonce(), 0);

        // Once the fault is removed, the same request commits exactly one record.
        w.messenger().set_should_revert(&false);
        if paid {
            w.router()
                .bridge_out_with_gas(&w.user, &request(&w), &1_000_000);
        } else {
            w.router().bridge_out(&w.user, &request(&w));
        }
        assert_eq!(fee_out_count(&w), 1);
    }
}

#[test]
fn a_messenger_that_returns_without_burning_is_refused_and_unwound() {
    for paid in [false, true] {
        let w = World::new();
        // Dust equal to the whole debit: the stand-in "succeeds" while pulling nothing.
        w.messenger().init(&net_of(HUNDRED), &0i128);
        let user_before = w.token().balance(&w.user);
        let result = if paid {
            w.router()
                .try_bridge_out_with_gas(&w.user, &request(&w), &1_000_000)
        } else {
            w.router().try_bridge_out(&w.user, &request(&w))
        };
        assert_eq!(result, Err(Ok(HyperionError::InvalidAmount)));
        assert_eq!(fee_out_count(&w), 0);
        assert_eq!(w.token().balance(&w.user), user_before);
        assert_eq!(w.token().balance(&w.adapter_id), 0);
        assert_eq!(w.token().allowance(&w.adapter_id, &w.messenger_id), 0);
        assert_eq!(w.router().last_out_nonce(), 0);

        w.messenger().init(&0i128, &0i128);
        if paid {
            w.router()
                .bridge_out_with_gas(&w.user, &request(&w), &1_000_000);
        } else {
            w.router().bridge_out(&w.user, &request(&w));
        }
        assert_eq!(fee_out_count(&w), 1);
    }
}

// ------------------------------------------------------------------------------------------
// Inbound
// ------------------------------------------------------------------------------------------

fn mint_accounted(
    w: &World,
    tail: u64,
    fee_budget: i128,
    fee_executed: i128,
) -> events::MintAccounted {
    let mut nonce = [0u8; 32];
    nonce[24..].copy_from_slice(&tail.to_be_bytes());
    events::MintAccounted {
        token: w.token_id.clone(),
        source_domain: ETHEREUM_DOMAIN,
        version: FEE_ACCOUNTING_VERSION,
        nonce: BytesN::from_array(&w.env, &nonce),
        local_decimals: STELLAR_DECIMALS,
        remote_decimals: EVM_DECIMALS,
        burn_amount: ARRIVING,
        fee_budget,
        fee_executed,
        minted: ARRIVING - fee_executed,
    }
}

#[test]
fn an_inbound_mint_records_the_attested_deduction_and_the_measured_mint() {
    let w = World::new();
    w.transmitter().set_fee(&250_000);
    let mut spec = w.spec(ARRIVING, 31, w.hook_to_recipient());
    spec.max_fee = 300_000;
    spec.fee_executed = 250_000;
    w.adapter()
        .receive(&w.relayer, &spec.encode(&w.env), &w.attestation());

    let expected = mint_accounted(&w, 31, 300_000, 250_000);
    assert_eq!(
        expected.minted + expected.fee_executed,
        expected.burn_amount
    );
    assert!(published(&w, &expected));
    assert_eq!(w.token().balance(&w.recipient), expected.minted);
}

#[test]
fn an_inbound_under_mint_commits_no_accounting() {
    let w = World::new();
    // The transmitter takes a fee the attested message never declared.
    w.transmitter().set_fee(&1);
    let spec = w.spec(ARRIVING, 32, w.hook_to_recipient());
    assert_eq!(
        w.adapter()
            .try_receive(&w.relayer, &spec.encode(&w.env), &w.attestation()),
        Err(Ok(HyperionError::InvalidAmount))
    );
    assert!(!published(&w, &mint_accounted(&w, 32, 0, 0)));
    assert!(!published(&w, &mint_accounted(&w, 32, 0, 1)));

    // The unconsumed nonce settles, and is recorded, once the provider mints exactly.
    w.transmitter().set_fee(&0);
    w.adapter()
        .receive(&w.relayer, &spec.encode(&w.env), &w.attestation());
    assert!(published(&w, &mint_accounted(&w, 32, 0, 0)));
}
