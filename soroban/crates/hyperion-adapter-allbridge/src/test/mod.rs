mod admin;
// The one shared copy of the capability snapshot grammar, compiled into each crate's tests.
#[path = "../../../../test-support/capability.rs"]
mod capability;

mod allbridge;
mod inbound;
mod outbound;
mod setup;

mod capabilities;
mod maintenance;
