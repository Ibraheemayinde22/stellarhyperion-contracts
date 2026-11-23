//! Read-only orphaned-custody audit.
//!
//! Failure cases use local fixtures: a token whose balance read fails for a chosen holder, a
//! router instance with liability tracking removed (an unmigrated upgrade), and direct transfers
//! that donate to or drain the router and the rail.
extern crate std;

use super::{
    doubles::Delivery,
    setup::{World, HUNDRED},
};
use crate::{CustodyAudit, CustodyStatus, DataKey, HolderCustody, CUSTODY_AUDIT_VERSION};
use hyperion_core::{AddressKind, RouteKind};
use soroban_sdk::{testutils::Events, vec, Address};

/// Park one claim of `amount` for `w.recipient`, who the token refuses.
fn park(w: &World, token: &Address, amount: i128, nonce: u64) -> u64 {
    w.failable(token).set_blocked(&w.recipient, &true);
    w.failable(token).mint(&w.rail_id, &amount);
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

fn rail_holder(w: &World, balance: Option<i128>) -> HolderCustody {
    HolderCustody {
        route: RouteKind::Cctp,
        holder: w.rail_id.clone(),
        balance,
    }
}

#[test]
fn custody_matching_unsettled_claims_reconciles() {
    let w = World::new();
    let token = w.with_failable_token();
    park(&w, &token, HUNDRED, 1);
    park(&w, &token, HUNDRED * 2, 2);

    let audit = w.router().custody_audit(&token);
    assert_eq!(audit.version, CUSTODY_AUDIT_VERSION);
    assert_eq!(audit.router_custody, Some(HUNDRED * 3));
    assert_eq!(audit.unsettled_claims, Some(HUNDRED * 3));
    assert_eq!(audit.router_unexplained, Some(0));
    // Every route points at the same rail, which is listed once under the first route.
    assert_eq!(audit.holders, vec![&w.env, rail_holder(&w, Some(0))]);
    assert_eq!(audit.holder_unexplained, Some(0));
    assert_eq!(audit.status, CustodyStatus::Reconciled);
}

#[test]
fn donations_are_separated_from_unsettled_claims_and_never_moved() {
    let w = World::new();
    let token = w.with_failable_token();
    let id = park(&w, &token, HUNDRED, 3);
    w.failable(&token).mint(&w.router_id, &17);
    w.failable(&token).mint(&w.rail_id, &5);

    let audit = w.router().custody_audit(&token);
    assert!(w.env.events().all().events().is_empty());
    assert_eq!(audit.unsettled_claims, Some(HUNDRED));
    assert_eq!(audit.router_custody, Some(HUNDRED + 17));
    assert_eq!(audit.router_unexplained, Some(17));
    assert_eq!(audit.holders, vec![&w.env, rail_holder(&w, Some(5))]);
    assert_eq!(audit.holder_unexplained, Some(5));
    assert_eq!(audit.status, CustodyStatus::Unexplained);

    // Nothing moved, and the audit repeats exactly.
    assert_eq!(w.failable(&token).balance(&w.router_id), HUNDRED + 17);
    assert_eq!(w.failable(&token).balance(&w.rail_id), 5);
    assert_eq!(w.router().custody_audit(&token), audit);

    // The claim still pays its fixed recipient its exact amount; the donation stays put.
    let claim = w.router().get_claim(&id);
    assert_eq!(claim.recipient, w.recipient);
    assert_eq!(claim.amount, HUNDRED);
    w.failable(&token).set_blocked(&w.recipient, &false);
    w.router().settle_claim(&w.user, &id);
    assert_eq!(w.failable(&token).balance(&w.recipient), HUNDRED);
    let after = w.router().custody_audit(&token);
    assert_eq!(after.unsettled_claims, Some(0));
    assert_eq!(after.router_unexplained, Some(17));
    assert_eq!(after.status, CustodyStatus::Unexplained);
}

#[test]
fn custody_below_unsettled_claims_is_a_shortfall() {
    let w = World::new();
    let token = w.with_failable_token();
    park(&w, &token, HUNDRED, 4);
    w.failable(&token).transfer(&w.router_id, &w.user, &1);

    let audit = w.router().custody_audit(&token);
    assert_eq!(audit.router_unexplained, Some(-1));
    assert_eq!(audit.status, CustodyStatus::Shortfall);
    // A known shortfall still reports even when a holder cannot be read.
    w.failable(&token).set_balance_error(&w.rail_id, &true);
    assert_eq!(
        w.router().custody_audit(&token).status,
        CustodyStatus::Shortfall
    );
}

#[test]
fn an_unmigrated_instance_reports_liabilities_unknown_instead_of_zero() {
    let w = World::new();
    let token = w.with_failable_token();
    park(&w, &token, HUNDRED, 5);
    w.failable(&token).mint(&w.router_id, &9);
    w.env.as_contract(&w.router_id, || {
        w.env
            .storage()
            .instance()
            .remove(&DataKey::LiabilityTracking);
    });

    let audit = w.router().custody_audit(&token);
    assert_eq!(audit.router_custody, Some(HUNDRED + 9));
    assert_eq!(audit.unsettled_claims, None);
    assert_eq!(audit.router_unexplained, None);
    assert_eq!(audit.status, CustodyStatus::Unknown);
}

#[test]
fn unreadable_balances_are_unknown_not_zero() {
    let w = World::new();
    let token = w.with_failable_token();
    park(&w, &token, HUNDRED, 6);

    w.failable(&token).set_balance_error(&w.router_id, &true);
    let audit = w.router().custody_audit(&token);
    assert_eq!(audit.router_custody, None);
    assert_eq!(audit.router_unexplained, None);
    assert_eq!(audit.unsettled_claims, Some(HUNDRED));
    assert_eq!(audit.status, CustodyStatus::Unknown);

    w.failable(&token).set_balance_error(&w.router_id, &false);
    w.failable(&token).set_balance_error(&w.rail_id, &true);
    let audit = w.router().custody_audit(&token);
    assert_eq!(audit.router_unexplained, Some(0));
    assert_eq!(audit.holders, vec![&w.env, rail_holder(&w, None)]);
    assert_eq!(audit.holder_unexplained, None);
    assert_eq!(audit.status, CustodyStatus::Unknown);
}

#[test]
fn every_distinct_adapter_and_receiver_is_audited_once() {
    let w = World::new();
    let token = w.with_failable_token();
    let receiver = w.with_hostile_receiver(RouteKind::AxelarGmp);
    w.failable(&token).mint(&receiver.address, &3);

    let audit = w.router().custody_audit(&token);
    assert_eq!(
        audit.holders,
        vec![
            &w.env,
            rail_holder(&w, Some(0)),
            HolderCustody {
                route: RouteKind::AxelarGmp,
                holder: receiver.address.clone(),
                balance: Some(3),
            },
        ]
    );
    assert_eq!(audit.holder_unexplained, Some(3));
    assert_eq!(audit.router_unexplained, Some(0));
    assert_eq!(audit.status, CustodyStatus::Unexplained);
}

#[test]
fn an_unwired_router_has_no_holders_and_reconciles_at_zero() {
    let w = World::bare();
    let token = w.with_failable_token();
    let audit = w.router().custody_audit(&token);
    assert!(audit.holders.is_empty());
    assert_eq!(audit.status, CustodyStatus::Reconciled);
}

#[test]
fn classification_rules_are_pure() {
    let w = World::new();
    let token = w.token_id.clone();
    let none = soroban_sdk::Vec::new(&w.env);
    let audit = |custody, claims| {
        CustodyAudit::classify(1, token.clone(), custody, claims, none.clone()).status
    };
    assert_eq!(audit(Some(5), Some(5)), CustodyStatus::Reconciled);
    assert_eq!(audit(Some(6), Some(5)), CustodyStatus::Unexplained);
    assert_eq!(audit(Some(4), Some(5)), CustodyStatus::Shortfall);
    assert_eq!(audit(None, Some(5)), CustodyStatus::Unknown);
    assert_eq!(audit(Some(5), None), CustodyStatus::Unknown);
    let overflow = vec![
        &w.env,
        HolderCustody {
            route: RouteKind::Cctp,
            holder: w.rail_id.clone(),
            balance: Some(i128::MAX),
        },
        HolderCustody {
            route: RouteKind::AxelarIts,
            holder: w.router_id.clone(),
            balance: Some(1),
        },
    ];
    let wide = CustodyAudit::classify(1, token, Some(0), Some(0), overflow);
    assert_eq!(wide.holder_unexplained, None);
    assert_eq!(wide.status, CustodyStatus::Unknown);
}
