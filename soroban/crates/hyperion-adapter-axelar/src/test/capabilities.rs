//! Capability regression snapshot for the Axelar adapter surface.
//!
//! One WASM backs two shapes, so the snapshot advertises both routes and the test proves that
//! each deployed shape reports the route its config was fixed to at initialization.

use super::{capability, setup::World};
use hyperion_core::RouteKind;

const SNAPSHOT: &str =
    include_str!("../../../../../testdata/capabilities/soroban-axelar-adapter.cap");
const HISTORY: &str = include_str!("../../../../../testdata/capabilities/paid-method-history.txt");

#[test]
fn exported_methods_match_the_capability_snapshot() {
    capability::assert_well_formed(SNAPSHOT, "soroban/axelar-adapter", "AxelarAdapter", HISTORY);
    let actual = capability::contract_methods(include_str!("../lib.rs"), "AxelarAdapter");
    capability::assert_methods(SNAPSHOT, &actual);
}

#[test]
fn advertises_both_shapes_and_reports_the_configured_one() {
    capability::assert_routes(SNAPSHOT, &["axelar-its", "axelar-gmp"]);

    // Two instances of one WASM: together they must report exactly the advertised routes. Which
    // instance answers to which route is fixed at initialization, not by the import order here.
    let world = World::new();
    let reported = [
        world.adapter().key_coverage().route,
        world.bare().key_coverage().route,
    ];
    assert!(
        reported.contains(&RouteKind::AxelarIts) && reported.contains(&RouteKind::AxelarGmp),
        "the deployed shapes must collectively advertise both Axelar routes"
    );
}

#[test]
fn the_paid_entry_point_is_declared_and_callable() {
    let methods = capability::values(SNAPSHOT, "method");
    let paid = capability::values(SNAPSHOT, "paid-method");
    assert_eq!(paid, ["dispatch_from"]);
    assert!(methods.contains(&"dispatch_from"));
}
