//! Observable liability conservation, bounded migration, and replay retention regressions.
extern crate std;
use super::{
    doubles::{message_id, Delivery},
    setup::{World, HUNDRED},
};
use crate::{storage, AdminAction, DataKey, CURRENT_SCHEMA_VERSION, MIN_TIMELOCK_DELAY};
use hyperion_core::{AddressKind, HyperionError, RouteKind};
use soroban_sdk::{testutils::storage::Persistent as _, testutils::Ledger as _, vec, Address};
fn park(w: &World, token: &Address, amount: i128, nonce: u64) -> u64 {
    w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: token.clone(),
        amount,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: nonce,
    })
}
#[test]
fn reconciliation_and_failed_settlement_preserve_exact_liability_independently_of_surplus() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).set_blocked(&w.recipient, &true);
    w.failable(&token).mint(&w.rail_id, &(HUNDRED * 3));
    let a = park(&w, &token, HUNDRED, 901);
    let b = park(&w, &token, HUNDRED * 2, 902);
    w.failable(&token).mint(&w.router_id, &17);
    let before = w.router().claim_liability(&token);
    assert!(before.known);
    assert!(before.solvent);
    assert_eq!(before.outstanding, HUNDRED * 3);
    assert_eq!(before.custody, HUNDRED * 3 + 17);
    assert_eq!(
        w.router().try_settle_claim(&w.user, &a),
        Err(Ok(HyperionError::RecipientNotReady))
    );
    assert_eq!(w.router().claim_liability(&token), before);
    w.failable(&token).set_blocked(&w.recipient, &false);
    w.router().settle_claim(&w.user, &a);
    w.router().settle_claim(&w.user, &b);
    let done = w.router().claim_liability(&token);
    assert_eq!(done.outstanding, 0);
    assert_eq!(done.custody, 17);
    assert!(done.solvent);
}
#[test]
fn a_corrupt_counter_cannot_go_negative_or_publish_a_payment() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).set_blocked(&w.recipient, &true);
    w.failable(&token).mint(&w.rail_id, &HUNDRED);
    let id = park(&w, &token, HUNDRED, 903);
    w.env.as_contract(&w.router_id, || {
        w.env
            .storage()
            .instance()
            .set(&DataKey::ClaimLiability(token.clone()), &0i128)
    });
    w.failable(&token).set_blocked(&w.recipient, &false);
    assert_eq!(
        w.router().try_settle_claim(&w.user, &id),
        Err(Ok(HyperionError::InvalidAmount))
    );
    assert_eq!(w.failable(&token).balance(&w.recipient), 0);
    assert_eq!(w.failable(&token).balance(&w.router_id), HUNDRED);
    assert!(!w.router().get_claim(&id).settled);
}
#[test]
fn reviewed_legacy_backfill_is_bounded_counts_only_open_claims_and_freezes_unsafe_mutation() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).set_blocked(&w.recipient, &true);
    w.failable(&token).mint(&w.rail_id, &(HUNDRED * 3));
    let a = park(&w, &token, HUNDRED, 904);
    let b = park(&w, &token, HUNDRED * 2, 905);
    w.failable(&token).set_blocked(&w.recipient, &false);
    w.router().settle_claim(&w.user, &a);
    w.failable(&token).mint(&w.router_id, &23);
    w.env.as_contract(&w.router_id, || {
        w.env
            .storage()
            .instance()
            .remove(&DataKey::LiabilityTracking);
        w.env
            .storage()
            .instance()
            .remove(&DataKey::ClaimLiability(token.clone()));
        w.env
            .storage()
            .instance()
            .set(&DataKey::SchemaVersion, &2u32);
    });
    assert!(!w.router().claim_liability(&token).known);
    let queued = w.router().queue_action(
        &w.admin,
        &AdminAction::BeginStorageMigration(CURRENT_SCHEMA_VERSION),
    );
    w.advance_time(MIN_TIMELOCK_DELAY + 1);
    w.router().execute_action(&w.admin, &queued);
    assert_eq!(
        w.router().try_settle_claim(&w.user, &b),
        Err(Ok(HyperionError::TimelockNotReady))
    );
    let first = w
        .router()
        .migrate_storage(&w.admin, &CURRENT_SCHEMA_VERSION, &1);
    assert!(first.migration_pending);
    assert_eq!(first.migrated_claims, 1);
    assert!(!w.router().claim_liability(&token).known);
    let done = w
        .router()
        .migrate_storage(&w.admin, &CURRENT_SCHEMA_VERSION, &1);
    assert!(!done.migration_pending);
    let report = w.router().claim_liability(&token);
    assert!(report.known);
    assert_eq!(report.outstanding, HUNDRED * 2);
    assert_eq!(report.custody, HUNDRED * 2 + 23);
    assert_eq!(
        w.router()
            .migrate_storage(&w.admin, &CURRENT_SCHEMA_VERSION, &1),
        done
    );
    assert_eq!(w.router().claim_liability(&token).outstanding, HUNDRED * 2);
    w.router().settle_claim(&w.user, &b);
    assert_eq!(w.router().claim_liability(&token).outstanding, 0);
}
#[test]
fn missing_legacy_claim_rolls_back_partial_totals_and_progress_before_retry() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).set_blocked(&w.recipient, &true);
    w.failable(&token).mint(&w.rail_id, &(HUNDRED * 2));
    let a = park(&w, &token, HUNDRED, 906);
    let b = park(&w, &token, HUNDRED, 907);
    let record = w.router().get_claim(&b);
    w.env.as_contract(&w.router_id, || {
        w.env
            .storage()
            .instance()
            .remove(&DataKey::LiabilityTracking);
        w.env
            .storage()
            .instance()
            .remove(&DataKey::ClaimLiability(token.clone()));
        w.env
            .storage()
            .instance()
            .set(&DataKey::SchemaVersion, &2u32);
    });
    let q = w.router().queue_action(
        &w.admin,
        &AdminAction::BeginStorageMigration(CURRENT_SCHEMA_VERSION),
    );
    w.advance_time(MIN_TIMELOCK_DELAY + 1);
    w.router().execute_action(&w.admin, &q);
    w.env.as_contract(&w.router_id, || {
        w.env.storage().persistent().remove(&DataKey::Claim(b))
    });
    assert_eq!(
        w.router()
            .try_migrate_storage(&w.admin, &CURRENT_SCHEMA_VERSION, &2),
        Err(Ok(HyperionError::ClaimNotFound))
    );
    assert_eq!(w.router().get_migration_status().migrated_claims, 0);
    assert_eq!(w.router().claim_liability(&token).outstanding, 0);
    assert!(!w.router().get_claim(&a).settled);
    w.env
        .as_contract(&w.router_id, || storage::set_claim(&w.env, &record));
    w.router()
        .migrate_storage(&w.admin, &CURRENT_SCHEMA_VERSION, &2);
    assert_eq!(w.router().claim_liability(&token).outstanding, HUNDRED * 2);
}

#[test]
fn interrupted_preupgrade_v2_snapshot_finishes_before_fresh_v3_liability_backfill() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).set_blocked(&w.recipient, &true);
    w.failable(&token).mint(&w.rail_id, &(HUNDRED * 2));
    park(&w, &token, HUNDRED, 910);
    park(&w, &token, HUNDRED, 911);
    w.env.as_contract(&w.router_id, || {
        w.env
            .storage()
            .instance()
            .remove(&DataKey::LiabilityTracking);
        w.env
            .storage()
            .instance()
            .remove(&DataKey::ClaimLiability(token.clone()));
        w.env
            .storage()
            .instance()
            .set(&DataKey::SchemaVersion, &1u32);
        storage::set_migration_state(
            &w.env,
            &crate::MigrationStatus {
                current_version: 1,
                target_version: 2,
                migration_pending: true,
                migrated_claims: 1,
                total_claims: 2,
                migrated_transfers: 0,
                total_transfers: 0,
            },
        );
    });
    assert!(w.router().try_migrate_storage(&w.admin, &3, &1).is_err());
    let v2 = w.router().migrate_storage(&w.admin, &2, &1);
    assert_eq!(v2.current_version, 2);
    assert!(!w.router().claim_liability(&token).known);
    assert_eq!(w.router().claim_liability(&token).outstanding, 0);
    let queued = w
        .router()
        .queue_action(&w.admin, &AdminAction::BeginStorageMigration(3));
    w.advance_time(MIN_TIMELOCK_DELAY + 1);
    w.router().execute_action(&w.admin, &queued);
    w.router().migrate_storage(&w.admin, &3, &2);
    assert!(w.router().claim_liability(&token).known);
    assert_eq!(w.router().claim_liability(&token).outstanding, HUNDRED * 2);
}
#[test]
fn replay_policy_uses_long_network_clamped_retention_and_bounded_route_scoped_upkeep() {
    let w = World::new();
    w.fund_rail(HUNDRED);
    let msg = message_id(&w.env, 908);
    w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 908,
    });
    let ttl = w.env.as_contract(&w.router_id, || {
        w.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Processed(RouteKind::Cctp, msg.clone()))
    });
    assert_eq!(ttl, storage::REPLAY_BUMP_TO);
    assert!(w.router().was_processed(&RouteKind::Cctp, &msg));
    assert!(!w.router().was_processed(&RouteKind::AxelarIts, &msg));
    let mut replays = vec![&w.env];
    for _ in 0..33 {
        replays.push_back((RouteKind::Cctp, msg.clone()));
    }
    assert!(w.router().try_keep_alive_replays(&replays).is_err());
    w.env.ledger().with_mut(|li| li.max_entry_ttl = 100_000);
    w.router()
        .keep_alive_replays(&vec![&w.env, (RouteKind::Cctp, msg)]);
}

#[test]
fn expired_replay_snapshot_never_reports_fresh_and_restoration_preserves_every_id_byte() {
    use crate::{HyperionRouter, HyperionRouterClient};
    use soroban_sdk::{
        xdr::{LedgerKey, ScVal},
        BytesN, Env, IntoVal, String, Val,
    };
    let w = World::new();
    let msg = BytesN::from_array(&w.env, &[0xa5; 32]);
    w.env.as_contract(&w.router_id, || {
        storage::mark_processed(&w.env, RouteKind::Cctp, &msg)
    });
    let key: ScVal = w.env.as_contract(&w.router_id, || {
        let val: Val = DataKey::Processed(RouteKind::Cctp, msg.clone()).into_val(&w.env);
        val.into_val(&w.env)
    });
    let mut archived = w.env.to_snapshot();
    let seq = archived.ledger.sequence_number;
    let entry = archived
        .ledger
        .ledger_entries
        .iter_mut()
        .find(|(k, _)| matches!(k.as_ref(),LedgerKey::ContractData(data) if data.key==key))
        .unwrap();
    entry.1 .1 = Some(seq - 1);
    fn rebound(env: &Env, address: &Address) -> Address {
        let mut raw = [0u8; 56];
        address.to_string().copy_into_slice(&mut raw);
        Address::from_string(&String::from_str(env, core::str::from_utf8(&raw).unwrap()))
    }
    let expired = Env::from_snapshot(archived.clone());
    let id = rebound(&expired, &w.router_id);
    expired.register_at(&id, HyperionRouter, ());
    let client = HyperionRouterClient::new(&expired, &id);
    let rebound_msg = BytesN::from_array(&expired, &[0xa5; 32]);
    assert_ne!(
        client.try_was_processed(&RouteKind::Cctp, &rebound_msg),
        Ok(Ok(false))
    );
    let entry = archived
        .ledger
        .ledger_entries
        .iter_mut()
        .find(|(k, _)| matches!(k.as_ref(),LedgerKey::ContractData(data) if data.key==key))
        .unwrap();
    entry.1 .1 = Some(seq + storage::REPLAY_BUMP_TO);
    let restored = Env::from_snapshot(archived);
    let id = rebound(&restored, &w.router_id);
    restored.register_at(&id, HyperionRouter, ());
    let client = HyperionRouterClient::new(&restored, &id);
    let msg = BytesN::from_array(&restored, &[0xa5; 32]);
    assert!(client.was_processed(&RouteKind::Cctp, &msg));
    assert!(!client.was_processed(&RouteKind::AxelarIts, &msg));
}

#[test]
fn measure_bounded_replay_upkeep_resources_and_exact_ttl() {
    use soroban_sdk::{xdr::WriteXdr, BytesN};
    for count in [1u32, 32] {
        let wasm = std::env::var("HYPERION_MEASURE_ROUTER_WASM").ok();
        let w = if let Some(path) = &wasm {
            // Registering WASM resets instance storage. Produce the configuration through
            // that executable before measuring, so code and configured-instance bytes count.
            let w = World::uninitialised();
            let bytes = std::fs::read(path).expect("measurement WASM must exist");
            w.env.register_at(&w.router_id, bytes.as_slice(), ());
            w.router().initialize(
                &w.admin,
                &w.guardian,
                &w.treasury,
                &super::setup::FEE_BPS,
                &hyperion_core::DEFAULT_FLOW_WINDOW_LEDGERS,
                &crate::MIN_TIMELOCK_DELAY,
            );
            w.enable_every_route();
            w.register_token(
                w.token_id.clone(),
                hyperion_core::STELLAR_DECIMALS,
                super::setup::FLOW_LIMIT,
            );
            w.fund_user(super::setup::HUNDRED * 10);
            w
        } else {
            World::new()
        };
        let mut keys = vec![&w.env];
        for i in 0..count {
            let mut bytes = [0xa5u8; 32];
            bytes[0] = i as u8;
            let message = BytesN::from_array(&w.env, &bytes);
            w.env.as_contract(&w.router_id, || {
                w.env
                    .storage()
                    .persistent()
                    .set(&DataKey::Processed(RouteKind::Cctp, message.clone()), &true);
            });
            keys.push_back((RouteKind::Cctp, message));
        }
        w.router().keep_alive_replays(&keys);
        let cpu = w.env.cost_estimate().budget().cpu_instruction_cost();
        let memory = w.env.cost_estimate().budget().memory_bytes_cost();
        let resources = w.env.cost_estimate().resources();
        std::println!(
            "REPLAY_COST mode={} count={} cpu={} memory={} resources={:?}",
            if wasm.is_some() { "wasm" } else { "native" },
            count,
            cpu,
            memory,
            resources
        );
        for (route, message) in keys.iter() {
            assert_eq!(
                w.env.as_contract(&w.router_id, || w
                    .env
                    .storage()
                    .persistent()
                    .get_ttl(&DataKey::Processed(route, message))),
                storage::REPLAY_BUMP_TO
            );
        }
        let snapshot = w.env.to_snapshot();
        let key_sizes: std::vec::Vec<usize> = snapshot
            .ledger
            .ledger_entries
            .iter()
            .filter_map(|(_, (entry, _))| match &entry.data {
                soroban_sdk::xdr::LedgerEntryData::ContractData(data)
                    if matches!(&data.key, soroban_sdk::xdr::ScVal::Vec(Some(v)) if matches!(v.first(),Some(soroban_sdk::xdr::ScVal::Symbol(s)) if s.as_slice()==b"Processed")) =>
                {
                    Some(entry.to_xdr(soroban_sdk::xdr::Limits::none()).unwrap().len())
                }
                _ => None,
            })
            .collect();
        assert_eq!(key_sizes.len(), count as usize);
        std::println!("REPLAY_ENTRY_XDR_BYTES {:?}", key_sizes);
        assert!(cpu > 0 && memory > 0);
    }
}
