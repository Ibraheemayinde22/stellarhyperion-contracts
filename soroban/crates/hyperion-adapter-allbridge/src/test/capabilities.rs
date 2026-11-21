//! Capability regression snapshot for the Allbridge adapter surface.
//!
//! The surface is gated in the snapshot: recorded so drift is visible, but not advertised as part
//! of the active deployment. The test asserts the recorded route, not activation.

use super::{capability, setup::World};
use hyperion_core::RouteKind;

const SNAPSHOT: &str =
    include_str!("../../../../../testdata/capabilities/soroban-allbridge-adapter.cap");
const HISTORY: &str = include_str!("../../../../../testdata/capabilities/paid-method-history.txt");

#[test]
fn exported_methods_match_the_capability_snapshot() {
    capability::assert_well_formed(
        SNAPSHOT,
        "soroban/allbridge-adapter",
        "AllbridgeAdapter",
        HISTORY,
    );
    let actual = capability::contract_methods(include_str!("../lib.rs"), "AllbridgeAdapter");
    capability::assert_methods(SNAPSHOT, &actual);
}

#[test]
fn advertises_only_the_route_it_serves() {
    capability::assert_routes(SNAPSHOT, &["allbridge"]);

    let world = World::new();
    assert_eq!(
        world.adapter().route(),
        RouteKind::Allbridge,
        "the adapter's advertised route disagrees with the snapshot"
    );
    assert_eq!(world.adapter().key_coverage().route, RouteKind::Allbridge);
}

#[test]
fn the_snapshot_records_no_paid_entry_point() {
    // Allbridge is funded before dispatch; it never attaches a provider payment, so it must not
    // advertise a paid method it does not have.
    assert!(capability::values(SNAPSHOT, "paid-method").is_empty());
}
