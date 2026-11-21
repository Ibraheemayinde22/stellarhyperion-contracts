// The one shared copy of the capability snapshot grammar, compiled into each crate's tests.
#[path = "../../../../test-support/capability.rs"]
mod capability;

mod doubles;
mod setup;

mod admin;
mod capabilities;
mod discovery;
mod inbound;
mod maintenance;
mod outbound;
mod quotes;
mod stateful_model;
mod storage_maintenance;
mod trust_surface;
