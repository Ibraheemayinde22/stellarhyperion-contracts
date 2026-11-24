//! Stand-ins for assets that are the wrong shape rather than merely misconfigured.

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, String};

use crate::rail::TokenManagerType;

#[contracttype]
#[derive(Clone)]
enum LegacyKey {
    Asset(BytesN<32>),
    Manager(BytesN<32>),
    Kind(BytesN<32>),
}

/// An ITS build that predates paid dispatch: the token-manager views are there, but
/// `native_token_address` (and `interchain_transfer` with a gas token) are not exported at all.
/// The probe must see the missing method as missing, not as a configuration it can work around.
#[contract]
pub struct LegacyIts;

#[contractimpl]
impl LegacyIts {
    pub fn register(
        env: Env,
        token_id: BytesN<32>,
        token: Address,
        manager: Address,
        kind: TokenManagerType,
    ) {
        let store = env.storage().instance();
        store.set(&LegacyKey::Asset(token_id.clone()), &token);
        store.set(&LegacyKey::Manager(token_id.clone()), &manager);
        store.set(&LegacyKey::Kind(token_id), &kind);
    }

    pub fn is_trusted_chain(_env: Env, _chain: String) -> bool {
        true
    }

    pub fn registered_token_address(env: Env, token_id: BytesN<32>) -> Address {
        env.storage()
            .instance()
            .get(&LegacyKey::Asset(token_id))
            .unwrap()
    }

    pub fn deployed_token_manager(env: Env, token_id: BytesN<32>) -> Address {
        env.storage()
            .instance()
            .get(&LegacyKey::Manager(token_id))
            .unwrap()
    }

    pub fn token_manager_type(env: Env, token_id: BytesN<32>) -> TokenManagerType {
        env.storage()
            .instance()
            .get(&LegacyKey::Kind(token_id))
            .unwrap()
    }
}

/// A token that copies another asset's metadata: same symbol, name and decimals, different
/// contract. A probe that qualified mappings by symbol would accept it.
#[contract]
pub struct LookalikeToken;

#[contracttype]
#[derive(Clone)]
enum LookalikeKey {
    Symbol,
    Name,
    Decimals,
}

#[contractimpl]
impl LookalikeToken {
    pub fn copy_metadata(env: Env, symbol: String, name: String, decimals: u32) {
        let store = env.storage().instance();
        store.set(&LookalikeKey::Symbol, &symbol);
        store.set(&LookalikeKey::Name, &name);
        store.set(&LookalikeKey::Decimals, &decimals);
    }
    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&LookalikeKey::Symbol).unwrap()
    }
    pub fn name(env: Env) -> String {
        env.storage().instance().get(&LookalikeKey::Name).unwrap()
    }
    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&LookalikeKey::Decimals)
            .unwrap()
    }
}

/// An asset that answers nothing this build understands.
///
/// Not a broken token: a contract that was never a SEP-41 asset at all, which is what an operator
/// pastes in when they copy an address from the wrong column. It has to be told apart from a token
/// with the wrong decimals, because the fix is different.
#[contract]
pub struct MuteToken;

#[contractimpl]
impl MuteToken {
    pub fn something_else(_env: Env) -> u32 {
        0
    }
}
