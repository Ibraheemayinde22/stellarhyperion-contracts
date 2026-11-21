//! Shared parsing and assertion helpers for the interface capability snapshots.
//!
//! Every contract crate's test module includes this file with `#[path]`, so one copy of the
//! grammar is checked by the Rust suites instead of four drifting copies. It is test support
//! only: it never compiles into a contract, and it depends on nothing outside `core`/`std`.
//!
//! The snapshot grammar is deliberately line oriented rather than JSON so that the Rust, Solidity
//! and TypeScript suites can all read the same committed file without a parser dependency, and so
//! that a reviewer sees the interface change as a one-line diff.
//!
//! ```text
//! surface  <chain>/<contract>        exactly one
//! contract <Type>                    exactly one
//! status   active|gated              exactly one
//! method   <name>                    zero or more, sorted, unique
//! route    <slug>                    zero or more, unique, in RouteKind order
//! paid-route <slug>                  subset of route
//! paid-method <name>                 subset of method
//! removed-paid-method <name> acknowledged=<ref> reason="<why>"   explicit compatibility record
//! ```
#![allow(dead_code)]

// The contract crates are `no_std` even in test builds; this support module is test-only and
// relies on the host standard library for `Vec` and formatting.
extern crate std;

use std::vec::Vec;

/// Protocol route slugs, in `RouteKind` order. Any `route` line must use one of these.
pub const ROUTE_SLUGS: [&str; 4] = ["cctp", "axelar-its", "axelar-gmp", "allbridge"];

/// One non-comment line: its directive, its first argument, and the rest of the line.
#[derive(Clone, Copy, Debug)]
pub struct Entry<'a> {
    pub directive: &'a str,
    pub value: &'a str,
    pub detail: &'a str,
}

/// Every non-blank, non-comment line, in file order.
pub fn entries(snapshot: &str) -> impl Iterator<Item = Entry<'_>> {
    snapshot.lines().filter_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let directive_end = line.find(char::is_whitespace).unwrap_or(line.len());
        let directive = &line[..directive_end];
        let rest = line[directive_end..].trim_start();
        let (value, detail) = match rest.find(char::is_whitespace) {
            Some(index) => (&rest[..index], rest[index..].trim_start()),
            None => (rest, ""),
        };
        Some(Entry {
            directive,
            value,
            detail,
        })
    })
}

/// Every value of one directive, in file order.
pub fn values<'a>(snapshot: &'a str, directive: &str) -> Vec<&'a str> {
    entries(snapshot)
        .filter(|entry| entry.directive == directive)
        .map(|entry| entry.value)
        .collect()
}

/// The single value of a directive that must appear exactly once.
pub fn single<'a>(snapshot: &'a str, directive: &str) -> &'a str {
    let found = values(snapshot, directive);
    assert_eq!(
        found.len(),
        1,
        "expected exactly one `{directive}` line, found {found:?}"
    );
    found[0]
}

fn assert_unique(snapshot: &str, directive: &str) {
    let found = values(snapshot, directive);
    let mut seen = Vec::new();
    for value in &found {
        assert!(
            !seen.contains(value),
            "duplicate `{directive} {value}` in the capability snapshot"
        );
        seen.push(*value);
    }
}

fn assert_sorted(values: &[&str], directive: &str) {
    for pair in values.windows(2) {
        assert!(
            pair[0] < pair[1],
            "`{directive}` lines must be sorted: {} appears before {}",
            pair[0],
            pair[1]
        );
    }
}

fn assert_routes_in_route_order(routes: &[&str]) {
    let mut last = None;
    for route in routes {
        let position = ROUTE_SLUGS
            .iter()
            .position(|known| known == route)
            .unwrap_or_else(|| panic!("`route {route}` is not a protocol route slug"));
        if let Some(previous) = last {
            assert!(
                previous < position,
                "`route` lines must follow RouteKind order, not file order: {route} is out of place"
            );
        }
        last = Some(position);
    }
}

/// Validate the grammar and the internal consistency of one snapshot file, against the
/// append-only paid-method history shared by every surface.
pub fn assert_well_formed(
    snapshot: &str,
    expected_surface: &str,
    expected_contract: &str,
    history: &str,
) {
    assert_eq!(single(snapshot, "surface"), expected_surface);
    assert_eq!(single(snapshot, "contract"), expected_contract);
    let status = single(snapshot, "status");
    assert!(
        status == "active" || status == "gated",
        "`status {status}` must be active or gated"
    );

    for directive in ["surface", "contract", "status"] {
        assert_eq!(
            values(snapshot, directive).len(),
            1,
            "`{directive}` must appear exactly once"
        );
    }
    for entry in entries(snapshot) {
        assert!(
            matches!(
                entry.directive,
                "surface"
                    | "contract"
                    | "status"
                    | "method"
                    | "route"
                    | "paid-route"
                    | "paid-method"
                    | "removed-paid-method"
            ),
            "unknown capability directive `{}`",
            entry.directive
        );
        if entry.directive != "removed-paid-method" {
            assert!(
                !entry.value.is_empty(),
                "`{}` line has no value",
                entry.directive
            );
        }
    }

    let methods = values(snapshot, "method");
    assert!(!methods.is_empty(), "a surface must declare its methods");
    assert_unique(snapshot, "method");
    assert_sorted(&methods, "method");

    let routes = values(snapshot, "route");
    assert_unique(snapshot, "route");
    assert_routes_in_route_order(&routes);

    let paid_routes = values(snapshot, "paid-route");
    assert_unique(snapshot, "paid-route");
    assert_routes_in_route_order(&paid_routes);
    for route in &paid_routes {
        assert!(
            routes.contains(route),
            "`paid-route {route}` is not one of the surface's routes: {routes:?}"
        );
    }

    let paid_methods = values(snapshot, "paid-method");
    assert_unique(snapshot, "paid-method");
    assert_sorted(&paid_methods, "paid-method");
    for method in &paid_methods {
        assert!(
            methods.contains(method),
            "`paid-method {method}` is not one of the surface's methods"
        );
    }

    // A removal is only valid when it names an acknowledged compatibility decision, and only for
    // a method that is genuinely gone. A stale acknowledgement is itself a drift.
    let removed = values(snapshot, "removed-paid-method");
    assert_unique(snapshot, "removed-paid-method");
    assert_sorted(&removed, "removed-paid-method");
    for entry in entries(snapshot).filter(|entry| entry.directive == "removed-paid-method") {
        assert!(
            !entry.value.is_empty(),
            "`removed-paid-method` needs the method name"
        );
        assert!(
            !methods.contains(&entry.value),
            "`removed-paid-method {}` is still callable; remove the acknowledgement",
            entry.value
        );
        assert!(
            entry.detail.starts_with("acknowledged="),
            "`removed-paid-method {}` needs `acknowledged=<reference>`",
            entry.value
        );
        assert!(
            entry.detail.contains("reason="),
            "`removed-paid-method {}` needs a `reason=`",
            entry.value
        );
    }

    // The history is the reason a removed paid method cannot disappear silently: every paid
    // entry point that has ever shipped must still be callable or explicitly acknowledged.
    let history: Vec<&str> = entries(history)
        .filter(|entry| entry.directive == "paid-method" && entry.value == expected_surface)
        .map(|entry| entry.detail)
        .collect();
    for name in &history {
        assert!(
            methods.contains(name) || removed.contains(name),
            "paid method {name} is no longer callable on {expected_surface} and has no \
             removed-paid-method acknowledgement"
        );
    }
    for name in &paid_methods {
        assert!(
            history.contains(name),
            "paid method {name} is missing from paid-method-history.txt"
        );
    }
    for name in &removed {
        assert!(
            history.contains(name),
            "removed-paid-method {name} was never a paid method on {expected_surface}"
        );
    }
}

/// The `pub fn` names inside the `#[contractimpl] impl <contract>` block of a Rust source file.
///
/// Reading the declared surface rather than the compiled spec keeps the check independent of the
/// build profile and of any test-only re-export, and makes the failure message name the method.
pub fn contract_methods<'a>(source: &'a str, contract: &str) -> Vec<&'a str> {
    let attribute = source
        .find("#[contractimpl]")
        .unwrap_or_else(|| panic!("{contract} source has no #[contractimpl] block"));
    let header = std::format!("impl {contract} {{");
    let header_at = source[attribute..]
        .find(&header)
        .unwrap_or_else(|| panic!("no `{header}` after #[contractimpl]"))
        + attribute;
    let open = header_at
        + source[header_at..]
            .find('{')
            .expect("contract impl header has no brace");

    let mut depth = 0usize;
    let mut end = None;
    let mut line_comment = false;
    let mut block_comment = false;
    let mut in_string = false;
    let mut previous = '\0';
    for (offset, character) in source[open..].char_indices() {
        if line_comment {
            if character == '\n' {
                line_comment = false;
            }
        } else if block_comment {
            if previous == '*' && character == '/' {
                block_comment = false;
            }
        } else if in_string {
            if character == '"' && previous != '\\' {
                in_string = false;
            }
        } else if previous == '/' && character == '/' {
            line_comment = true;
        } else if previous == '/' && character == '*' {
            block_comment = true;
        } else if character == '"' {
            in_string = true;
        } else if character == '{' {
            depth += 1;
        } else if character == '}' {
            depth -= 1;
            if depth == 0 {
                end = Some(open + offset);
                break;
            }
        }
        previous = character;
    }
    let end = end.unwrap_or_else(|| panic!("unbalanced braces in the {contract} impl block"));

    let mut methods = Vec::new();
    for line in source[open..=end].lines() {
        let line = line.trim_start();
        let Some(rest) = line.strip_prefix("pub fn ") else {
            continue;
        };
        let length: usize = rest
            .chars()
            .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
            .map(char::len_utf8)
            .sum();
        let name = &rest[..length];
        if !name.is_empty() && !methods.contains(&name) {
            methods.push(name);
        }
    }
    methods.sort_unstable();
    methods
}

/// The surface must declare exactly the methods the contract exports.
pub fn assert_methods(snapshot: &str, actual: &[&str]) {
    let declared = values(snapshot, "method");
    let missing: Vec<_> = declared
        .iter()
        .filter(|method| !actual.contains(method))
        .collect();
    let unrecorded: Vec<_> = actual
        .iter()
        .filter(|method| !declared.contains(method))
        .collect();
    assert!(
        missing.is_empty(),
        "the snapshot advertises methods that are not callable locally: {missing:?}"
    );
    assert!(
        unrecorded.is_empty(),
        "the contract exports methods missing from the snapshot: {unrecorded:?}"
    );
}

/// The surface must advertise exactly the routes it actually serves.
pub fn assert_routes(snapshot: &str, actual: &[&str]) {
    let declared = values(snapshot, "route");
    let mut expected: Vec<&str> = actual.to_vec();
    expected.sort_unstable();
    let mut declared_sorted = declared.clone();
    declared_sorted.sort_unstable();
    assert_eq!(
        declared_sorted, expected,
        "advertised routes do not match the local dispatch surface"
    );
}
