//! Capability regression snapshots for the router surface.
//!
//! `testdata/capabilities/soroban-router.cap` is the reviewed record of what this contract
//! exports and which routes it serves. These tests fail when the code and the record drift, so a
//! method that disappears — paid dispatch most of all — cannot do so without an explicit,
//! reviewed acknowledgement in the same change.
//!
//! The failure cases are exercised against local fixture strings rather than the committed
//! snapshot, so the rules stay tested even when the real surface is stable.

// These failure cases use the host panic handler to observe a rejected snapshot.
extern crate std;

use super::{capability, setup::World};
use hyperion_core::RouteKind;

const SNAPSHOT: &str = include_str!("../../../../../testdata/capabilities/soroban-router.cap");
const HISTORY: &str = include_str!("../../../../../testdata/capabilities/paid-method-history.txt");

const ROUTES: [(RouteKind, &str); 4] = [
    (RouteKind::Cctp, "cctp"),
    (RouteKind::AxelarIts, "axelar-its"),
    (RouteKind::AxelarGmp, "axelar-gmp"),
    (RouteKind::Allbridge, "allbridge"),
];

#[test]
fn exported_methods_match_the_capability_snapshot() {
    capability::assert_well_formed(SNAPSHOT, "soroban/router", "HyperionRouter", HISTORY);
    let actual = capability::contract_methods(include_str!("../lib.rs"), "HyperionRouter");
    capability::assert_methods(SNAPSHOT, &actual);
}

#[test]
fn advertised_routes_match_the_local_dispatch_surface() {
    capability::assert_routes(SNAPSHOT, &ROUTES.map(|(_, slug)| slug));
}

#[test]
fn paid_route_advertisement_matches_the_paid_entry_points() {
    let world = World::bare();
    let advertised = capability::values(SNAPSHOT, "paid-route");
    let methods = capability::values(SNAPSHOT, "method");
    let paid_methods = capability::values(SNAPSHOT, "paid-method");

    // Every advertised paid route is a route the router actually carries, and every paid entry
    // point named in the snapshot is a locally callable method.
    for route in &advertised {
        assert!(capability::values(SNAPSHOT, "route").contains(route));
    }
    assert!(
        !paid_methods.is_empty(),
        "the router must advertise a paid entry point"
    );
    for method in &paid_methods {
        assert!(
            methods.contains(method),
            "paid method {method} is not exported"
        );
    }

    // `supports_paid_route` is what the app reads before offering a paid transfer. It must agree
    // with the snapshot for every route, in both directions.
    for (route, slug) in ROUTES {
        assert_eq!(
            world.router().supports_paid_route(&route),
            advertised.contains(&slug),
            "supports_paid_route disagrees with the snapshot for {slug}"
        );
    }

    // The bounded entry point exists for every advertised paid route; the legacy unbounded entry
    // point does not attach a provider payment, so it is deliberately not a paid method.
    assert!(!paid_methods.contains(&"bridge_out"));
}

#[test]
fn a_removed_paid_method_without_an_acknowledgement_is_refused() {
    let snapshot = "\
surface test/router
contract Test
status gated
method plain
route cctp
paid-route cctp
";
    // The history still remembers a paid entry point that this snapshot stopped declaring.
    let history = "paid-method test/router paid_gone\n";
    let outcome = std::panic::catch_unwind(|| {
        capability::assert_well_formed(snapshot, "test/router", "Test", history)
    });
    assert!(
        outcome.is_err(),
        "a paid method must not disappear without a compatibility acknowledgement"
    );
}

#[test]
fn an_acknowledged_removal_is_accepted() {
    let snapshot = "\
surface test/router
contract Test
status gated
method plain
route cctp
paid-route cctp
removed-paid-method paid_gone acknowledged=issue-157 reason=\"superseded by plain\"
";
    let history = "paid-method test/router paid_gone\n";
    capability::assert_well_formed(snapshot, "test/router", "Test", history);
}

#[test]
fn an_acknowledgement_for_a_still_callable_method_is_refused() {
    let snapshot = "\
surface test/router
contract Test
status gated
method paid_gone
route cctp
paid-route cctp
paid-method paid_gone
removed-paid-method paid_gone acknowledged=issue-157 reason=\"still here\"
";
    let history = "paid-method test/router paid_gone\n";
    let outcome = std::panic::catch_unwind(|| {
        capability::assert_well_formed(snapshot, "test/router", "Test", history)
    });
    assert!(outcome.is_err(), "a stale acknowledgement must fail");
}

#[test]
fn a_paid_method_missing_from_the_history_is_refused() {
    let snapshot = "\
surface test/router
contract Test
status gated
method paid_new
route cctp
paid-route cctp
paid-method paid_new
";
    let outcome = std::panic::catch_unwind(|| {
        capability::assert_well_formed(snapshot, "test/router", "Test", "")
    });
    assert!(
        outcome.is_err(),
        "a new paid method must be added to the append-only history"
    );
}

#[test]
fn an_unknown_route_slug_is_refused() {
    let snapshot = "\
surface test/router
contract Test
status gated
method plain
route teleport
";
    let outcome = std::panic::catch_unwind(|| {
        capability::assert_well_formed(snapshot, "test/router", "Test", "")
    });
    assert!(
        outcome.is_err(),
        "route slugs are protocol values, not free text"
    );
}
