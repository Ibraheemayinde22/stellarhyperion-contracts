extern crate std;

use hyperion_core::{
    AddressKind, BurnMessage, CctpMessage, HyperionError, HyperionHook, InboundNote, RouteKind,
    StellarDestination, StrkeyDestination, MAX_CCTP_BURN_BODY_LEN, MAX_CCTP_HOOK_LEN,
    MAX_CCTP_MESSAGE_LEN, MAX_INBOUND_NOTE_LEN, STRKEY_LEN_MUXED,
};
use soroban_sdk::{Bytes, BytesN, Env, String};

use super::setup::World;
use crate::types::{AdminAction, CancelReason, MAX_QUEUED_ACTION_CHAIN_LEN, MAX_REASON_LEN};

const M_ADDR: &str = "MA5ZYIIVYDX5GRF2BKEQD2Y47ZCPG3HX3PUUNPVQ5ZECB57MJG7RKABAAAAAAAAAAFLXQ";

fn muxed_strkey(env: &Env) -> StrkeyDestination {
    StrkeyDestination::new(AddressKind::MuxedAccount, String::from_str(env, M_ADDR))
}

#[test]
fn protocol_payload_limits_accept_the_maximum_and_reject_one_byte_more() {
    let env = Env::default();
    let destination = StellarDestination::muxed(BytesN::from_array(&env, &[1; 32]), 7);
    let hook = HyperionHook::new(destination).encode(&env).unwrap();
    assert_eq!(hook.len(), MAX_CCTP_HOOK_LEN);
    assert!(HyperionHook::decode(&env, &hook).is_ok());
    let mut oversized_hook = hook.clone();
    oversized_hook.push_back(0);
    assert_eq!(
        HyperionHook::decode(&env, &oversized_hook),
        Err(HyperionError::InvalidDestination)
    );

    let note = InboundNote::new(muxed_strkey(&env), 7).encode(&env).unwrap();
    assert_eq!(note.len(), MAX_INBOUND_NOTE_LEN);
    assert_eq!(InboundNote::decode(&env, &note).unwrap().nonce, 7);
    let mut oversized_note = note;
    oversized_note.push_back(0);
    assert_eq!(
        InboundNote::decode(&env, &oversized_note),
        Err(HyperionError::MalformedMessage)
    );

    let strkey = muxed_strkey(&env);
    assert_eq!(strkey.value.len(), STRKEY_LEN_MUXED);
    assert!(strkey.validate().is_ok());
    let too_long = StrkeyDestination::new(
        AddressKind::MuxedAccount,
        String::from_str(&env, &(M_ADDR.to_owned() + "A")),
    );
    assert_eq!(too_long.validate(), Err(HyperionError::InvalidDestination));
}

#[test]
fn cctp_messages_and_burn_bodies_stop_at_the_supported_hook_budget() {
    let env = Env::default();
    let max_message = Bytes::from_slice(&env, &std::vec![0; MAX_CCTP_MESSAGE_LEN as usize]);
    assert!(CctpMessage::parse(&env, &max_message).is_ok());
    assert_eq!(
        CctpMessage::body(&max_message).unwrap().len(),
        MAX_CCTP_BURN_BODY_LEN
    );
    let too_large_message =
        Bytes::from_slice(&env, &std::vec![0; MAX_CCTP_MESSAGE_LEN as usize + 1]);
    assert_eq!(
        CctpMessage::parse(&env, &too_large_message),
        Err(HyperionError::MalformedMessage)
    );

    let max_body = Bytes::from_slice(&env, &std::vec![0; MAX_CCTP_BURN_BODY_LEN as usize]);
    assert!(BurnMessage::parse(&env, &max_body).is_ok());
    assert_eq!(
        BurnMessage::hook_data(&max_body).unwrap().len(),
        MAX_CCTP_HOOK_LEN
    );
    let too_large_body =
        Bytes::from_slice(&env, &std::vec![0; MAX_CCTP_BURN_BODY_LEN as usize + 1]);
    assert_eq!(
        BurnMessage::parse(&env, &too_large_body),
        Err(HyperionError::MalformedMessage)
    );
}

#[test]
fn oversized_cctp_input_has_a_fixed_parser_cost() {
    let env = Env::default();
    let raw = Bytes::from_slice(&env, &std::vec![0; 4_096]);
    let before = env.cost_estimate().budget().cpu_instruction_cost();
    let memory_before = env.cost_estimate().budget().memory_bytes_cost();
    assert_eq!(
        CctpMessage::parse(&env, &raw),
        Err(HyperionError::MalformedMessage)
    );
    let cpu = env
        .cost_estimate()
        .budget()
        .cpu_instruction_cost()
        .saturating_sub(before);
    let memory = env
        .cost_estimate()
        .budget()
        .memory_bytes_cost()
        .saturating_sub(memory_before);
    std::println!(
        "HYPERION_LIMIT parser=cctp-message input_bytes={} accepted_max={} cpu={} memory={}",
        raw.len(),
        MAX_CCTP_MESSAGE_LEN,
        cpu,
        memory
    );
}

#[test]
fn cancellation_reason_boundary_is_shared_and_rejection_keeps_the_action_queued() {
    let w = World::new();
    let id = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(25));
    let max_reason = String::from_str(&w.env, &"a".repeat(MAX_REASON_LEN as usize));
    w.router().cancel_action_with_reason(
        &w.guardian,
        &id,
        &CancelReason::SecurityConcern,
        &max_reason,
    );

    let next = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(26));
    let too_long = String::from_str(&w.env, &"a".repeat(MAX_REASON_LEN as usize + 1));
    assert_eq!(
        w.router().try_cancel_action_with_reason(
            &w.guardian,
            &next,
            &CancelReason::SecurityConcern,
            &too_long
        ),
        Err(Ok(HyperionError::InvalidLimit))
    );
    assert_eq!(w.router().get_action_payload(&next).id, next);
}

#[test]
fn queued_destination_limit_chain_is_bounded_at_the_shared_maximum() {
    let w = World::new();
    let at_limit = String::from_str(
        &w.env,
        &"a".repeat(MAX_QUEUED_ACTION_CHAIN_LEN as usize),
    );
    let action = AdminAction::SetDestinationFlowLimit(
        w.token_id.clone(),
        RouteKind::Cctp,
        at_limit,
        1,
    );
    let id = w.router().queue_action(&w.admin, &action);
    let multibyte_chain =
        String::from_str(&w.env, &"é".repeat(MAX_QUEUED_ACTION_CHAIN_LEN as usize / 2));
    let multibyte_id = w.router().queue_action(
        &w.admin,
        &AdminAction::SetDestinationFlowLimit(
            w.token_id.clone(),
            RouteKind::Cctp,
            multibyte_chain,
            1,
        ),
    );

    let too_long = String::from_str(
        &w.env,
        &"a".repeat(MAX_QUEUED_ACTION_CHAIN_LEN as usize + 1),
    );
    assert_eq!(
        w.router().try_queue_action(
            &w.admin,
            &AdminAction::SetDestinationFlowLimit(w.token_id.clone(), RouteKind::Cctp, too_long, 1)
        ),
        Err(Ok(HyperionError::InvalidLimit))
    );
    let too_many_multibyte =
        String::from_str(&w.env, &"é".repeat(MAX_QUEUED_ACTION_CHAIN_LEN as usize / 2 + 1));
    assert_eq!(
        w.router().try_queue_action(
            &w.admin,
            &AdminAction::SetDestinationFlowLimit(
                w.token_id.clone(),
                RouteKind::Cctp,
                too_many_multibyte,
                1
            )
        ),
        Err(Ok(HyperionError::InvalidLimit))
    );
    assert_eq!(w.router().get_action_payload(&id).action, action);
    let following = w
        .router()
        .queue_action(&w.admin, &AdminAction::SetFeeBps(27));
    assert_eq!(following, multibyte_id + 1);
}
