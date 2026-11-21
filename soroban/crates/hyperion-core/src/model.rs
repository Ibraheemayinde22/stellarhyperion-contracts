//! Bounded specification used only by off-chain tests. No production arithmetic or storage helpers.
//! Amounts are token base units. A rail balance includes outbound adapters and the inbound receiver.

pub const MODEL_MAX_CLAIMS: usize = 128;
pub const MODEL_MAX_STEPS: usize = 128;
pub const MODEL_FUNDS: u64 = 10_000_000_000_000;
pub const MODEL_LIMIT: u64 = 1_000_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rail {
    Cctp,
    AxelarIts,
    AxelarGmp,
    Allbridge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChainClock {
    Soroban { ledger: u64, timestamp: u64 },
    Evm { timestamp: u64 },
}

impl ChainClock {
    pub fn timestamp(self) -> u64 {
        match self {
            Self::Soroban { timestamp, .. } | Self::Evm { timestamp } => timestamp,
        }
    }
    pub fn flow_tick(self) -> u64 {
        match self {
            Self::Soroban { ledger, .. } => ledger,
            Self::Evm { timestamp } => timestamp,
        }
    }
    pub fn advance(&mut self, seconds: u64, ledgers: u64) {
        match self {
            Self::Soroban { ledger, timestamp } => {
                *ledger += ledgers;
                *timestamp += seconds;
            }
            Self::Evm { timestamp } => *timestamp += seconds,
        }
    }
}

/// Actors: 0 admin, 1 guardian, 2 unrelated caller. IDs are relative to fixture setup.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation {
    Dispatch {
        rail: Rail,
        amount: u64,
    },
    Inbound {
        amount: u64,
        recipient: usize,
        nonce: usize,
    },
    Block {
        recipient: usize,
        blocked: bool,
    },
    Settle {
        id: usize,
    },
    Pause {
        actor: u8,
    },
    Unpause {
        actor: u8,
    },
    QueueFee {
        actor: u8,
        bps: u64,
    },
    Execute {
        actor: u8,
        id: usize,
    },
    Cancel {
        actor: u8,
        id: usize,
    },
    Advance {
        seconds: u64,
        ledgers: u64,
    },
}

impl Operation {
    /// One portable, shrinkable word vocabulary shared by the native and Foundry drivers.
    pub fn decode(word: u64) -> Self {
        let arg = word >> 16;
        let small = word >> 8;
        let actor = (small % 3) as u8;
        match (word & 255) % 10 {
            0 => Self::Dispatch {
                rail: [
                    Rail::Cctp,
                    Rail::AxelarIts,
                    Rail::AxelarGmp,
                    Rail::Allbridge,
                ][(small % 4) as usize],
                amount: arg % 1_500_000_000,
            },
            1 => Self::Inbound {
                amount: arg % 1_500_000_000,
                recipient: (small % 2) as usize,
                nonce: ((word >> 10) % 16) as usize,
            },
            2 => Self::Block {
                recipient: (small % 2) as usize,
                blocked: arg & 1 != 0,
            },
            3 => Self::Settle {
                id: (small % 20 + 1) as usize,
            },
            4 => Self::Pause { actor },
            5 => Self::Unpause { actor },
            6 => Self::QueueFee {
                actor,
                bps: arg % 121,
            },
            7 => Self::Execute {
                actor,
                id: (arg % 20 + 1) as usize,
            },
            8 => Self::Cancel {
                actor,
                id: (arg % 20 + 1) as usize,
            },
            _ => Self::Advance {
                seconds: arg % 800_000,
                ledgers: small % 1_500,
            },
        }
    }
}

/// One deterministic administrative sequence for timelock boundary exploration.
///
/// This is fixture vocabulary, not contract state. It covers nomination, supersession,
/// cancellation, disable (pause), early/execution-race, maturity and expiration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TimelockBoundaryCase {
    pub name: &'static str,
    pub operation: Operation,
}

pub const fn timelock_boundary_cases() -> [TimelockBoundaryCase; 8] {
    [
        TimelockBoundaryCase {
            name: "nomination",
            operation: Operation::QueueFee { actor: 0, bps: 20 },
        },
        TimelockBoundaryCase {
            name: "superseded nomination",
            operation: Operation::QueueFee { actor: 0, bps: 30 },
        },
        TimelockBoundaryCase {
            name: "cancellation",
            operation: Operation::Cancel { actor: 1, id: 1 },
        },
        TimelockBoundaryCase {
            name: "disable",
            operation: Operation::Pause { actor: 1 },
        },
        TimelockBoundaryCase {
            name: "early execution race",
            operation: Operation::Execute { actor: 0, id: 2 },
        },
        TimelockBoundaryCase {
            name: "maturity boundary",
            operation: Operation::Advance {
                seconds: 3600,
                ledgers: 360,
            },
        },
        TimelockBoundaryCase {
            name: "execution",
            operation: Operation::Execute { actor: 0, id: 2 },
        },
        TimelockBoundaryCase {
            name: "expiration",
            operation: Operation::Advance {
                seconds: 604801,
                ledgers: 60481,
            },
        },
    ]
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModelError {
    Unauthorized,
    Paused,
    InvalidAmount,
    FlowLimit,
    Replay,
    Missing,
    Blocked,
    Early,
    Expired,
    FeeTooHigh,
    Capacity,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ModelClaim {
    pub amount: u64,
    pub recipient: usize,
    pub settled: bool,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Action {
    bps: u64,
    eta: u64,
    pending: bool,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Window {
    epoch: u64,
    current: u64,
    previous: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelRouter {
    pub clock: ChainClock,
    pub balances: [u64; 6], // user, treasury, rail, router, recipient0, recipient1
    pub paused: bool,
    pub fee_bps: u64,
    pub nonce: u64,
    pub claim_count: usize,
    pub action_count: usize,
    pub claims: [ModelClaim; MODEL_MAX_CLAIMS],
    blocked: [bool; 2],
    seen: [bool; 16],
    actions: [Action; MODEL_MAX_STEPS],
    windows: [Window; 4],
    window_span: u64,
    delay: u64,
    quantum: u64,
}

impl ModelRouter {
    pub fn new(clock: ChainClock) -> Self {
        let evm = matches!(clock, ChainClock::Evm { .. });
        Self {
            clock,
            balances: [MODEL_FUNDS, 0, MODEL_FUNDS, 0, 0, 0],
            paused: false,
            fee_bps: 10,
            nonce: 0,
            claim_count: 0,
            action_count: 0,
            claims: [ModelClaim::default(); MODEL_MAX_CLAIMS],
            blocked: [false; 2],
            seen: [false; 16],
            actions: [Action::default(); MODEL_MAX_STEPS],
            windows: [Window::default(); 4],
            window_span: if evm { 3600 } else { 720 },
            delay: if evm { 172800 } else { 3600 },
            quantum: if evm { 1 } else { 10 },
        }
    }

    fn rolled(&self, rail: usize) -> Window {
        let epoch = self.clock.flow_tick() / self.window_span;
        let old = self.windows[rail];
        if epoch == old.epoch {
            old
        } else {
            Window {
                epoch,
                current: 0,
                previous: if epoch == old.epoch + 1 {
                    old.current
                } else {
                    0
                },
            }
        }
    }
    pub fn available(&self, rail: Rail) -> u64 {
        let w = self.rolled(rail as usize);
        let used = w.current
            + w.previous * (self.window_span - self.clock.flow_tick() % self.window_span)
                / self.window_span;
        MODEL_LIMIT.saturating_sub(used)
    }
    pub fn liabilities(&self) -> [u64; 2] {
        let mut sums = [0; 2];
        for claim in &self.claims[..self.claim_count] {
            if !claim.settled {
                sums[claim.recipient] += claim.amount;
            }
        }
        sums
    }
    pub fn conserved(&self) -> bool {
        self.balances.iter().sum::<u64>() == 2 * MODEL_FUNDS
            && self.liabilities().iter().sum::<u64>() == self.balances[3]
    }
    /// Clone-and-commit specifies transaction rollback independently of each host's mechanics.
    pub fn apply(&mut self, op: Operation) -> Result<u64, ModelError> {
        let mut next = self.clone();
        let result = next.step(op)?;
        *self = next;
        Ok(result)
    }
    fn step(&mut self, op: Operation) -> Result<u64, ModelError> {
        use ModelError as E;
        match op {
            Operation::Dispatch { rail, amount } => {
                if self.paused {
                    return Err(E::Paused);
                }
                let fee = amount * self.fee_bps / 10000;
                let net = (amount - fee) / self.quantum * self.quantum;
                if net == 0 || net + fee > self.balances[0] {
                    return Err(E::InvalidAmount);
                }
                if net > self.available(rail) {
                    return Err(E::FlowLimit);
                }
                let mut w = self.rolled(rail as usize);
                w.current += net;
                self.windows[rail as usize] = w;
                self.balances[0] -= net + fee;
                self.balances[1] += fee;
                self.balances[2] += net;
                self.nonce += 1;
                return Ok(self.nonce);
            }
            Operation::Inbound {
                amount,
                recipient,
                nonce,
            } => {
                if recipient >= 2 || nonce >= 16 || amount == 0 || amount > self.balances[2] {
                    return Err(E::InvalidAmount);
                }
                if self.seen[nonce] {
                    return Err(E::Replay);
                }
                self.seen[nonce] = true;
                self.balances[2] -= amount;
                if self.blocked[recipient] {
                    if self.claim_count == MODEL_MAX_CLAIMS {
                        return Err(E::Capacity);
                    }
                    self.claims[self.claim_count] = ModelClaim {
                        amount,
                        recipient,
                        settled: false,
                    };
                    self.claim_count += 1;
                    self.balances[3] += amount;
                    return Ok(self.claim_count as u64);
                }
                self.balances[4 + recipient] += amount;
            }
            Operation::Block { recipient, blocked } => {
                if recipient >= 2 {
                    return Err(E::InvalidAmount);
                }
                self.blocked[recipient] = blocked;
            }
            Operation::Settle { id } => {
                if id == 0 || id > self.claim_count {
                    return Err(E::Missing);
                }
                let c = &mut self.claims[id - 1];
                if c.settled {
                    return Err(E::Missing);
                }
                if self.blocked[c.recipient] {
                    return Err(E::Blocked);
                }
                c.settled = true;
                self.balances[3] -= c.amount;
                self.balances[4 + c.recipient] += c.amount;
            }
            Operation::Pause { actor } | Operation::Unpause { actor } => {
                let pause = matches!(op, Operation::Pause { .. });
                if actor > 1 || (!pause && actor != 0) {
                    return Err(E::Unauthorized);
                }
                if matches!(self.clock, ChainClock::Evm { .. }) && self.paused == pause {
                    return Err(E::Paused);
                }
                self.paused = pause;
            }
            Operation::QueueFee { actor, bps } => {
                if actor != 0 {
                    return Err(E::Unauthorized);
                }
                if bps > 100 {
                    return Err(E::FeeTooHigh);
                }
                if self.action_count == MODEL_MAX_STEPS {
                    return Err(E::Capacity);
                }
                self.actions[self.action_count] = Action {
                    bps,
                    eta: self.clock.timestamp() + self.delay,
                    pending: true,
                };
                self.action_count += 1;
                return Ok(self.action_count as u64);
            }
            Operation::Execute { actor, id } | Operation::Cancel { actor, id } => {
                let execute = matches!(op, Operation::Execute { .. });
                if actor > 1 || (execute && actor != 0) {
                    return Err(E::Unauthorized);
                }
                if id == 0 || id > self.action_count || !self.actions[id - 1].pending {
                    return Err(E::Missing);
                }
                let action = &mut self.actions[id - 1];
                if execute {
                    if self.clock.timestamp() < action.eta {
                        return Err(E::Early);
                    }
                    if self.clock.timestamp() > action.eta + 604800 {
                        return Err(E::Expired);
                    }
                    self.fee_bps = action.bps;
                }
                action.pending = false;
            }
            Operation::Advance { seconds, ledgers } => self.clock.advance(seconds, ledgers),
        }
        Ok(0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TraceStep {
    pub operation: Operation,
    pub outcome: Result<u64, ModelError>,
}
#[derive(Clone, Debug)]
pub struct Trace {
    pub steps: [Option<TraceStep>; MODEL_MAX_STEPS],
    pub len: usize,
}
impl Default for Trace {
    fn default() -> Self {
        Self {
            steps: [None; MODEL_MAX_STEPS],
            len: 0,
        }
    }
}
impl Trace {
    pub fn push(&mut self, step: TraceStep) -> Result<(), ModelError> {
        if self.len == MODEL_MAX_STEPS {
            return Err(ModelError::Capacity);
        }
        self.steps[self.len] = Some(step);
        self.len += 1;
        Ok(())
    }
    /// Deletion shrinker: caller must rebuild both worlds and identify the same discrepancy.
    /// Repeats until no individual deletion preserves the failure (a 1-minimal trace).
    pub fn minimize<F: FnMut(&[Operation]) -> bool>(&self, mut fails: F) -> Self {
        let mut ops = [Operation::Advance {
            seconds: 0,
            ledgers: 0,
        }; MODEL_MAX_STEPS];
        for (i, entry) in self.steps[..self.len].iter().enumerate() {
            ops[i] = entry.unwrap().operation;
        }
        let mut len = self.len;
        if !fails(&ops[..len]) {
            return self.clone();
        }
        let mut i = 0;
        while i < len {
            let mut candidate = ops;
            candidate.copy_within(i + 1..len, i);
            if fails(&candidate[..len - 1]) {
                ops = candidate;
                len -= 1;
                i = 0;
            } else {
                i += 1;
            }
        }
        let mut result = Self::default();
        for op in &ops[..len] {
            result
                .push(TraceStep {
                    operation: *op,
                    outcome: Ok(0),
                })
                .unwrap();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clocks_do_not_exchange_ledgers_for_seconds() {
        let mut clock = ChainClock::Soroban {
            ledger: 1,
            timestamp: 2,
        };
        clock.advance(3600, 0);
        assert_eq!(clock.flow_tick(), 1);
        assert_eq!(clock.timestamp(), 3602);
        let mut evm = ChainClock::Evm { timestamp: 2 };
        evm.advance(0, 720);
        assert_eq!(evm.flow_tick(), 2);
    }
    #[test]
    fn deletion_shrinker_reproduces_a_frozen_recipient_fault() {
        let operations = [
            Operation::Advance {
                seconds: 1,
                ledgers: 1,
            },
            Operation::Block {
                recipient: 0,
                blocked: true,
            },
            Operation::Pause { actor: 0 },
            Operation::Inbound {
                amount: 100,
                recipient: 0,
                nonce: 0,
            },
        ];
        let mut trace = Trace::default();
        for op in operations {
            trace
                .push(TraceStep {
                    operation: op,
                    outcome: Ok(0),
                })
                .unwrap();
        }
        // Simulate a faulty implementation that drops parked liabilities.
        let minimal = trace.minimize(|ops| {
            let mut model = ModelRouter::new(ChainClock::Evm { timestamp: 100 });
            for op in ops {
                let _ = model.apply(*op);
            }
            model.balances[3] > 0
        });
        assert_eq!(minimal.len, 2);
        assert_eq!(minimal.steps[0].unwrap().operation, operations[1]);
        assert_eq!(minimal.steps[1].unwrap().operation, operations[3]);
    }
}
