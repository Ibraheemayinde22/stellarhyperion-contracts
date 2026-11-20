//! The inbound leg: money arriving on Stellar, including the day it cannot be handed over.

use hyperion_core::{AddressKind, HyperionError, RouteKind};
use soroban_sdk::{testutils::Address as _, Address, String};

use super::doubles::{message_id, Delivery};
use super::setup::{World, FLOW_LIMIT, HUNDRED};

#[test]
fn an_attested_delivery_reaches_the_recipient() {
    let w = World::new();
    w.fund_rail(HUNDRED);

    let claim_id = w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 42,
    });

    // Zero means it went straight through with nothing to park.
    assert_eq!(claim_id, 0);
    assert_eq!(w.token().balance(&w.recipient), HUNDRED);
    assert_eq!(w.token().balance(&w.router_id), 0);
    assert_eq!(w.token().balance(&w.rail_id), 0);
    assert!(w
        .router()
        .was_processed(&RouteKind::Cctp, &message_id(&w.env, 42)));
}

#[test]
fn the_rail_receiver_authorises_the_pull_itself_with_no_mocked_signatures() {
    let w = World::new();
    w.fund_rail(HUNDRED);
    // Strip the blanket auth mock. From here the only thing standing behind the router's pull is
    // the receiver's own `authorize_as_current_contract` call, which is exactly what production
    // relies on.
    w.env.set_auths(&[]);

    let claim_id = w.rail().deliver(&Delivery {
        route: RouteKind::AxelarIts,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 7,
    });
    assert_eq!(claim_id, 0);
    assert_eq!(w.token().balance(&w.recipient), HUNDRED);
}

#[test]
fn the_same_message_cannot_be_delivered_twice() {
    let w = World::new();
    w.fund_rail(HUNDRED * 2);

    w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 99,
    });
    // A replay window on a bridge is a mint twice bug, so this is the single most important
    // refusal in the contract.
    assert_eq!(
        w.rail().try_deliver(&Delivery {
            route: RouteKind::Cctp,
            token: w.token_id.clone(),
            amount: HUNDRED,
            recipient: w.recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: w.ethereum(),
            source_nonce: 99
        }),
        Err(Ok(HyperionError::ReplayedMessage))
    );
    assert_eq!(w.token().balance(&w.recipient), HUNDRED);
}

#[test]
fn the_same_nonce_on_a_different_rail_is_a_different_message() {
    let w = World::new();
    w.fund_rail(HUNDRED * 2);

    w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 1,
    });
    // Rails number their own messages, so nonce one from Circle and nonce one from Axelar have
    // nothing to do with each other.
    w.rail().deliver(&Delivery {
        route: RouteKind::AxelarGmp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 1,
    });
    assert_eq!(w.token().balance(&w.recipient), HUNDRED * 2);
}

#[test]
fn only_the_configured_rail_receiver_can_deliver() {
    let w = World::new();
    let impostor = w.env.register(super::doubles::MockRail, ());
    super::doubles::MockRailClient::new(&w.env, &impostor).init(&w.router_id);
    w.sac().mint(&impostor, &HUNDRED);

    // The impostor is a perfectly working rail contract. It just is not the one the admin wrote
    // down, and that is the entire security boundary on the inbound side.
    assert_eq!(
        super::doubles::MockRailClient::new(&w.env, &impostor).try_deliver(&Delivery {
            route: RouteKind::Cctp,
            token: w.token_id.clone(),
            amount: HUNDRED,
            recipient: w.recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: w.ethereum(),
            source_nonce: 5
        }),
        Err(Ok(HyperionError::NotRailReceiver))
    );
    assert_eq!(w.token().balance(&w.recipient), 0);
}

#[test]
fn a_delivery_the_rail_cannot_actually_fund_is_refused_outright() {
    let w = World::new();
    // Nobody minted anything to the rail, so there is no money behind this message.
    assert!(w
        .rail()
        .try_deliver(&Delivery {
            route: RouteKind::Cctp,
            token: w.token_id.clone(),
            amount: HUNDRED,
            recipient: w.recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: w.ethereum(),
            source_nonce: 1
        })
        .is_err());
    assert_eq!(w.router().claim_count(), 0);
}

#[test]
fn zero_and_negative_arrivals_are_refused() {
    let w = World::new();
    w.fund_rail(HUNDRED);
    for amount in [0i128, -HUNDRED] {
        assert_eq!(
            w.rail().try_deliver(&Delivery {
                route: RouteKind::Cctp,
                token: w.token_id.clone(),
                amount,
                recipient: w.recipient.clone(),
                recipient_kind: AddressKind::Account,
                source_chain: w.ethereum(),
                source_nonce: 1
            }),
            Err(Ok(HyperionError::InvalidAmount))
        );
    }
}

#[test]
fn a_muxed_recipient_is_refused_on_a_rail_with_nowhere_to_put_the_muxed_id() {
    let w = World::new();
    w.fund_rail(HUNDRED);
    // Circle's mint recipient field is thirty two bytes with no room for the extra eight a muxed
    // account needs. Accepting it here would mean delivering to the base account and silently
    // losing the subaccount the sender cared about.
    assert_eq!(
        w.rail().try_deliver(&Delivery {
            route: RouteKind::Cctp,
            token: w.token_id.clone(),
            amount: HUNDRED,
            recipient: w.recipient.clone(),
            recipient_kind: AddressKind::MuxedAccount,
            source_chain: w.ethereum(),
            source_nonce: 1
        }),
        Err(Ok(HyperionError::MuxedNotSupported))
    );
}

#[test]
fn a_muxed_recipient_is_fine_on_a_rail_that_carries_a_real_payload() {
    let w = World::new();
    w.fund_rail(HUNDRED);
    let claim_id = w.rail().deliver(&Delivery {
        route: RouteKind::AxelarGmp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::MuxedAccount,
        source_chain: w.ethereum(),
        source_nonce: 1,
    });
    assert_eq!(claim_id, 0);
    assert_eq!(w.token().balance(&w.recipient), HUNDRED);
}

#[test]
fn pausing_does_not_strand_funds_that_are_already_on_their_way() {
    let w = World::new();
    w.fund_rail(HUNDRED);
    w.router().pause(&w.guardian);

    // The burn on the far side already happened. Refusing the arrival does not undo it, it only
    // leaves the money nowhere, so pause deliberately has no say here.
    let claim_id = w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 3,
    });
    assert_eq!(claim_id, 0);
    assert_eq!(w.token().balance(&w.recipient), HUNDRED);
}

// ------------------------------------------------------------------------------------------
// Parked claims
// ------------------------------------------------------------------------------------------

#[test]
fn a_recipient_who_cannot_receive_gets_a_claim_rather_than_a_reverted_transfer() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &HUNDRED);
    // Stands in for a classic account with no trustline for the asset.
    w.failable(&token).set_blocked(&w.recipient, &true);

    let claim_id = w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: token.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 11,
    });

    assert_eq!(claim_id, 1);
    let claim = w.router().get_claim(&1);
    assert_eq!(claim.recipient, w.recipient);
    assert_eq!(claim.amount, HUNDRED);
    assert_eq!(claim.source_nonce, 11);
    assert!(!claim.settled);
    // The router is holding it, not the rail and not the recipient.
    assert_eq!(w.failable(&token).balance(&w.router_id), HUNDRED);
    assert_eq!(w.failable(&token).balance(&w.recipient), 0);
}

#[test]
fn anybody_can_settle_a_claim_once_the_recipient_is_ready_for_it() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &HUNDRED);
    w.failable(&token).set_blocked(&w.recipient, &true);
    w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: token.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 11,
    });

    // Still blocked, so settling now just tells you to come back later.
    let good_samaritan = Address::generate(&w.env);
    assert_eq!(
        w.router().try_settle_claim(&good_samaritan, &1),
        Err(Ok(HyperionError::RecipientNotReady))
    );

    // The recipient opens their trustline.
    w.failable(&token).set_blocked(&w.recipient, &false);

    // And a total stranger pays the fee to push it through, which costs them a few stroops and
    // gains them nothing, because the funds can only ever go where the claim says.
    w.router().settle_claim(&good_samaritan, &1);
    assert_eq!(w.failable(&token).balance(&w.recipient), HUNDRED);
    assert!(w.router().get_claim(&1).settled);
}

#[test]
fn a_claim_cannot_be_settled_twice() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &(HUNDRED * 2));
    w.failable(&token).set_blocked(&w.recipient, &true);
    w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: token.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 11,
    });
    w.failable(&token).set_blocked(&w.recipient, &false);
    w.router().settle_claim(&w.user, &1);

    assert_eq!(
        w.router().try_settle_claim(&w.user, &1),
        Err(Ok(HyperionError::ClaimAlreadySettled))
    );
    assert_eq!(w.failable(&token).balance(&w.recipient), HUNDRED);
}

#[test]
fn settling_a_claim_that_does_not_exist_says_so() {
    let w = World::new();
    assert_eq!(
        w.router().try_settle_claim(&w.user, &404),
        Err(Ok(HyperionError::ClaimNotFound))
    );
}

#[test]
fn bounded_batch_settlement_reports_each_result_and_keeps_restricted_claims_funded() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &(HUNDRED * 2));
    let other = Address::generate(&w.env);
    w.failable(&token).set_blocked(&w.recipient, &true);
    w.failable(&token).set_blocked(&other, &true);
    for (nonce, recipient) in [(201, w.recipient.clone()), (202, other.clone())] {
        assert_eq!(
            w.rail().deliver(&Delivery {
                route: RouteKind::Cctp,
                token: token.clone(),
                amount: HUNDRED,
                recipient,
                recipient_kind: AddressKind::Account,
                source_chain: w.ethereum(),
                source_nonce: nonce,
            }),
            if nonce == 201 { 1 } else { 2 }
        );
    }
    w.failable(&token).set_blocked(&other, &false);
    let outcomes = w
        .router()
        .settle_claims(&w.user, &soroban_sdk::vec![&w.env, 1, 2, 404, 2]);
    assert_eq!(outcomes.len(), 4);
    assert_eq!(outcomes.get(0).unwrap().status, 3);
    assert_eq!(outcomes.get(1).unwrap().status, 0);
    assert_eq!(outcomes.get(2).unwrap().status, 1);
    assert_eq!(outcomes.get(3).unwrap().status, 2);
    assert!(!w.router().get_claim(&1).settled);
    assert!(w.router().get_claim(&2).settled);
    assert_eq!(w.failable(&token).balance(&w.router_id), HUNDRED);
    assert_eq!(w.failable(&token).balance(&other), HUNDRED);
    assert_eq!(w.router().claim_failure_reason(&1), 1);
    assert_eq!(w.router().claim_failure_reason(&2), 0);
}

#[test]
fn claims_are_numbered_and_countable() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &(HUNDRED * 3));
    w.failable(&token).set_blocked(&w.recipient, &true);

    for nonce in 1..=3u64 {
        let id = w.rail().deliver(&Delivery {
            route: RouteKind::Cctp,
            token: token.clone(),
            amount: HUNDRED,
            recipient: w.recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: w.ethereum(),
            source_nonce: nonce,
        });
        assert_eq!(id, nonce);
    }
    assert_eq!(w.router().claim_count(), 3);
    assert_eq!(w.failable(&token).balance(&w.router_id), HUNDRED * 3);
}

#[test]
fn settling_still_works_while_the_bridge_is_paused() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &HUNDRED);
    w.failable(&token).set_blocked(&w.recipient, &true);
    w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: token.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 1,
    });
    w.failable(&token).set_blocked(&w.recipient, &false);
    w.router().pause(&w.guardian);

    // Handing somebody their own money back is not a risk that needs pausing.
    w.router().settle_claim(&w.user, &1);
    assert_eq!(w.failable(&token).balance(&w.recipient), HUNDRED);
}

#[test]
fn paused_departure_rehearsal_still_authenticates_and_settles_inbound_claims() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &(HUNDRED * 2));
    w.failable(&token).set_blocked(&w.recipient, &true);
    w.router().pause(&w.guardian);

    let delivery = Delivery {
        route: RouteKind::Cctp,
        token: token.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 707,
    };
    let claim = w.rail().deliver(&delivery);
    assert_eq!(claim, 1);
    assert_eq!(w.failable(&token).balance(&w.router_id), HUNDRED);
    assert_eq!(
        w.rail().try_deliver(&delivery),
        Err(Ok(HyperionError::ReplayedMessage))
    );

    w.failable(&token).set_blocked(&w.recipient, &false);
    w.router().settle_claim(&w.user, &claim);
    assert_eq!(w.failable(&token).balance(&w.recipient), HUNDRED);
    assert!(w.router().get_claim(&claim).settled);
}

#[test]
fn an_inbound_delivery_does_not_touch_the_outbound_flow_limit() {
    let w = World::bare();
    w.enable_every_route();
    w.register_token(w.token_id.clone(), 7, 1_000_000);
    w.fund_rail(HUNDRED);

    w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 1,
    });
    // The limit exists to cap how fast value can leave, and this was value arriving.
    assert_eq!(
        w.router().flow_available(&w.token_id, &RouteKind::Cctp),
        1_000_000
    );
}

#[test]
fn a_contract_recipient_needs_no_trustline_and_is_delivered_straight_away() {
    let w = World::new();
    w.fund_rail(HUNDRED);
    // A Soroban contract holds balances without opting in, so the whole trustline problem
    // simply does not arise for a C address.
    let contract_recipient = w.env.register(super::doubles::MockRail, ());
    super::doubles::MockRailClient::new(&w.env, &contract_recipient).init(&w.router_id);

    let claim_id = w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: w.token_id.clone(),
        amount: HUNDRED,
        recipient: contract_recipient.clone(),
        recipient_kind: AddressKind::Contract,
        source_chain: w.ethereum(),
        source_nonce: 1,
    });
    assert_eq!(claim_id, 0);
    assert_eq!(w.token().balance(&contract_recipient), HUNDRED);
}

#[test]
fn the_source_chain_name_is_kept_on_the_claim_for_the_indexer() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &HUNDRED);
    w.failable(&token).set_blocked(&w.recipient, &true);
    let chain = String::from_str(&w.env, "base-sepolia");
    w.rail().deliver(&Delivery {
        route: RouteKind::Allbridge,
        token: token.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: chain.clone(),
        source_nonce: 77,
    });
    let claim = w.router().get_claim(&1);
    assert_eq!(claim.source_chain, chain);
    assert_eq!(claim.route, RouteKind::Allbridge);
}

#[test]
fn claim_sidecar_keeps_the_full_inbound_provenance() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &HUNDRED);
    w.failable(&token).set_blocked(&w.recipient, &true);
    let id = w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token,
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 42,
    });
    let provenance = w.router().get_claim_provenance(&id).unwrap();
    assert_eq!(provenance.route, RouteKind::Cctp);
    assert_eq!(provenance.source_chain, w.ethereum());
    assert_eq!(provenance.message_id, message_id(&w.env, 42));
}

#[test]
fn liability_view_counts_only_unsettled_claims_and_flags_insolvency() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &(HUNDRED * 2));
    w.failable(&token).set_blocked(&w.recipient, &true);
    for nonce in 1..=2 {
        w.rail().deliver(&Delivery {
            route: RouteKind::Cctp,
            token: token.clone(),
            amount: HUNDRED,
            recipient: w.recipient.clone(),
            recipient_kind: AddressKind::Account,
            source_chain: w.ethereum(),
            source_nonce: nonce,
        });
    }
    let view = w.router().claim_liability(&token);
    assert!(view.known);
    assert!(view.solvent);
    assert_eq!(view.outstanding, HUNDRED * 2);
    assert_eq!(view.custody, HUNDRED * 2);

    w.failable(&token).set_blocked(&w.recipient, &false);
    w.router().settle_claim(&w.user, &1);
    let view = w.router().claim_liability(&token);
    assert!(view.known);
    assert_eq!(view.outstanding, HUNDRED);
    assert_eq!(view.custody, HUNDRED);

    w.failable(&token).transfer(&w.router_id, &w.user, &HUNDRED);
    let view = w.router().claim_liability(&token);
    assert!(view.known);
    assert!(!view.solvent);
}

#[test]
fn preview_returns_unknown_when_token_cannot_confirm_recipient_eligibility() {
    let w = World::new();
    let token = w.with_failable_token();
    w.failable(&token).mint(&w.rail_id, &HUNDRED);
    w.failable(&token).set_blocked(&w.recipient, &true);
    let id = w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token,
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 103,
    });
    // This token has no standard eligibility query, so a refusal remains explicitly uncertain.
    assert_eq!(id, 1);
    assert_eq!(
        w.router().preview_claim_recipient(&id),
        crate::RecipientEligibility::Unknown
    );
    assert_eq!(w.router().get_claim(&id).recipient, w.recipient);
}

#[test]
fn a_fee_on_transfer_token_is_refused_on_inbound_and_creates_no_false_claims() {
    let w = World::new();
    let fot_id = w.env.register(super::doubles::FeeOnTransferToken, ());
    let fot = super::doubles::FeeOnTransferTokenClient::new(&w.env, &fot_id);
    fot.init(&7, &500);
    w.register_token(fot_id.clone(), 7, FLOW_LIMIT);
    fot.mint(&w.rail_id, &HUNDRED);

    let res = w.rail().try_deliver(&super::doubles::Delivery {
        route: RouteKind::Cctp,
        token: fot_id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: hyperion_core::AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 99,
    });
    assert_eq!(res, Err(Ok(HyperionError::InvalidAmount)));
    assert_eq!(w.router().claim_count(), 0);
}

#[test]
fn hostile_recipient_credit_rolls_back_delivery_replay_and_balances() {
    let w = World::new();
    let id = w.env.register(super::doubles::FeeOnTransferToken, ());
    let fot = super::doubles::FeeOnTransferTokenClient::new(&w.env, &id);
    fot.init(&7, &0);
    fot.configure(&w.recipient, &500, &false);
    w.register_token(id.clone(), 7, FLOW_LIMIT);
    fot.mint(&w.rail_id, &HUNDRED);
    let delivery = Delivery {
        route: RouteKind::Cctp,
        token: id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: hyperion_core::AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 100,
    };
    assert_eq!(
        w.rail().try_deliver(&delivery),
        Err(Ok(HyperionError::InvalidAmount))
    );
    assert_eq!(fot.balance(&w.rail_id), HUNDRED);
    assert_eq!(fot.balance(&w.router_id), 0);
    assert_eq!(fot.balance(&w.recipient), 0);
    assert_eq!(w.router().claim_count(), 0);
    fot.configure(&w.recipient, &0, &false);
    w.rail().deliver(&delivery);
    assert_eq!(fot.balance(&w.recipient), HUNDRED);
}

#[test]
fn hostile_claim_credit_stays_funded_and_unsettled_until_exact_delivery() {
    let w = World::new();
    let id = w.env.register(super::doubles::FeeOnTransferToken, ());
    let fot = super::doubles::FeeOnTransferTokenClient::new(&w.env, &id);
    fot.init(&7, &0);
    fot.configure(&w.recipient, &0, &false);
    fot.set_blocked(&w.recipient, &true);
    w.register_token(id.clone(), 7, FLOW_LIMIT);
    fot.mint(&w.rail_id, &HUNDRED);
    let claim = w.rail().deliver(&Delivery {
        route: RouteKind::Cctp,
        token: id.clone(),
        amount: HUNDRED,
        recipient: w.recipient.clone(),
        recipient_kind: hyperion_core::AddressKind::Account,
        source_chain: w.ethereum(),
        source_nonce: 101,
    });
    fot.set_blocked(&w.recipient, &false);
    fot.configure(&w.recipient, &500, &false);
    assert_eq!(
        w.router().try_settle_claim(&w.user, &claim),
        Err(Ok(HyperionError::InvalidAmount))
    );
    assert!(!w.router().get_claim(&claim).settled);
    assert_eq!(fot.balance(&w.router_id), HUNDRED);
    assert_eq!(fot.balance(&w.recipient), 0);
    fot.configure(&w.recipient, &0, &false);
    w.router().settle_claim(&w.user, &claim);
    assert_eq!(fot.balance(&w.recipient), HUNDRED);
}

#[test]
fn batch_nonconforming_token_rolls_back_all_mutations_claims_and_liabilities() {
    let w = World::new();
    let token = w.env.register(super::doubles::FeeOnTransferToken, ());
    let asset = super::doubles::FeeOnTransferTokenClient::new(&w.env, &token);
    asset.init(&7, &0);
    w.register_token(token.clone(), 7, FLOW_LIMIT);
    let recipients = [
        Address::generate(&w.env),
        w.recipient.clone(),
        Address::generate(&w.env),
    ];
    asset.mint(&w.rail_id, &(HUNDRED * 3));
    for (index, recipient) in recipients.iter().enumerate() {
        asset.set_blocked(recipient, &true);
        w.rail().deliver(&Delivery {
            route: RouteKind::Cctp,
            token: token.clone(),
            amount: HUNDRED,
            recipient: recipient.clone(),
            recipient_kind: hyperion_core::AddressKind::Account,
            source_chain: w.ethereum(),
            source_nonce: 801 + index as u64,
        });
        asset.set_blocked(recipient, &false);
    }
    asset.configure(&w.recipient, &500, &false);
    let ids = soroban_sdk::vec![&w.env, 1, 2, 3, 1];
    assert_eq!(
        w.router().try_settle_claims(&w.user, &ids),
        Err(Ok(HyperionError::InvalidAmount))
    );
    for recipient in recipients.iter() {
        assert_eq!(asset.balance(recipient), 0);
    }
    assert_eq!(asset.balance(&w.router_id), HUNDRED * 3);
    for id in 1..=3 {
        assert!(!w.router().get_claim(&id).settled);
    }
    let claim = w.router().get_claim(&2);
    assert_eq!(claim.amount, HUNDRED);
    assert_eq!(claim.recipient, w.recipient);
    // A reverting batch cannot retain a new diagnostic, just like the legacy single API.
    assert_eq!(w.router().claim_failure_reason(&2), 1);
    assert_eq!(w.router().claim_liability(&token).outstanding, HUNDRED * 3);
    asset.configure(&w.recipient, &0, &false);
    let result = w.router().settle_claims(&w.user, &ids);
    for (index, status) in [0, 0, 0, 2].iter().enumerate() {
        assert_eq!(result.get(index as u32).unwrap().status, *status);
    }
    for recipient in recipients.iter() {
        assert_eq!(asset.balance(recipient), HUNDRED);
    }
    assert_eq!(w.router().claim_liability(&token).outstanding, 0);
    assert_eq!(w.router().claim_failure_reason(&2), 0);
}

#[test]
fn unreadable_token_balance_is_unavailable_and_unrelated_claim_still_settles() {
    let w = World::new();
    let token = w.with_failable_token();
    let other = Address::generate(&w.env);
    w.failable(&token).mint(&w.rail_id, &(HUNDRED * 2));
    for (nonce, recipient) in [(901, w.recipient.clone()), (902, other.clone())] {
        w.failable(&token).set_blocked(&recipient, &true);
        w.rail().deliver(&Delivery {
            route: RouteKind::Cctp,
            token: token.clone(),
            amount: HUNDRED,
            recipient: recipient.clone(),
            recipient_kind: hyperion_core::AddressKind::Account,
            source_chain: w.ethereum(),
            source_nonce: nonce,
        });
        w.failable(&token).set_blocked(&recipient, &false);
    }
    w.failable(&token).set_balance_error(&w.recipient, &true);
    let result = w
        .router()
        .settle_claims(&w.user, &soroban_sdk::vec![&w.env, 1, 2]);
    assert_eq!(result.get(0).unwrap().status, 5);
    assert_eq!(result.get(1).unwrap().status, 0);
    assert_eq!(w.failable(&token).balance(&w.router_id), HUNDRED);
    assert_eq!(w.failable(&token).balance(&other), HUNDRED);
    assert!(!w.router().get_claim(&1).settled);
    assert_eq!(w.router().claim_failure_reason(&1), 3);
    assert_eq!(w.router().claim_liability(&token).outstanding, HUNDRED);
    w.failable(&token).set_balance_error(&w.recipient, &false);
    w.failable(&token).transfer(&w.router_id, &w.user, &HUNDRED);
    let short = w
        .router()
        .settle_claims(&w.user, &soroban_sdk::vec![&w.env, 1]);
    assert_eq!(short.get(0).unwrap().status, 4);
    assert_eq!(w.router().claim_failure_reason(&1), 2);
    assert!(!w.router().get_claim(&1).settled);
    assert_eq!(w.router().claim_liability(&token).outstanding, HUNDRED);
    w.failable(&token).mint(&w.router_id, &HUNDRED);
    w.router()
        .settle_claims(&w.user, &soroban_sdk::vec![&w.env, 1]);
    assert_eq!(w.failable(&token).balance(&w.recipient), HUNDRED);
    assert_eq!(w.router().claim_failure_reason(&1), 0);
}

#[test]
fn batch_bounds_and_settler_authorization_are_enforced() {
    let w = World::new();
    assert_eq!(
        w.router()
            .try_settle_claims(&w.user, &soroban_sdk::Vec::new(&w.env)),
        Err(Ok(HyperionError::InvalidAmount))
    );
    let mut ids = soroban_sdk::Vec::new(&w.env);
    for id in 0..51 {
        ids.push_back(id);
    }
    assert_eq!(
        w.router().try_settle_claims(&w.user, &ids),
        Err(Ok(HyperionError::InvalidAmount))
    );
    ids.pop_back();
    assert_eq!(w.router().settle_claims(&w.user, &ids).len(), 50);
    w.env.mock_auths(&[]);
    assert!(w.router().try_settle_claims(&w.user, &ids).is_err());
}
