mod admin;
// The one shared copy of the capability snapshot grammar, compiled into each crate's tests.
#[path = "../../../../test-support/capability.rs"]
mod capability;

mod doubles;
mod inbound;
mod its;
mod outbound;
mod paid;
mod setup;

mod capabilities;
mod diagnostics;
mod maintenance;
