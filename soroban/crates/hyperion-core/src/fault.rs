//! Deterministic provider faults for local rehearsals.
//!
//! This controller is deliberately not part of the router's runtime state.  It gives the
//! Soroban and EVM fixtures the same small vocabulary for injecting a provider failure while
//! keeping the seed, selected stages, and attempt number visible in a saved rehearsal record.

/// A provider boundary at which a fixture may inject a failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum FaultStage {
    Dispatch = 0,
    Inbound = 1,
}

/// A serialisable description of a deterministic fault plan.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderFaultSchedule {
    pub seed: u64,
    pub dispatch_mask: u64,
    pub inbound_mask: u64,
}

impl ProviderFaultSchedule {
    /// Derive independent stage masks from one saved seed.
    pub const fn from_seed(seed: u64) -> Self {
        Self {
            seed,
            dispatch_mask: mix(seed ^ 0x4453_5041_5443_4848),
            inbound_mask: mix(seed ^ 0x494e_424f_554e_4448),
        }
    }

    pub const fn with_masks(seed: u64, dispatch_mask: u64, inbound_mask: u64) -> Self {
        Self {
            seed,
            dispatch_mask,
            inbound_mask,
        }
    }

    pub const fn mask(self, stage: FaultStage) -> u64 {
        match stage {
            FaultStage::Dispatch => self.dispatch_mask,
            FaultStage::Inbound => self.inbound_mask,
        }
    }

    /// Return whether the zero-based attempt should fail.  Attempts after 64 repeat the
    /// recorded mask, which keeps a compact fixture record useful for long rehearsals.
    pub const fn fails(self, stage: FaultStage, attempt: u64) -> bool {
        (self.mask(stage) & (1u64 << (attempt % 64))) != 0
    }
}

/// Stateful adapter used by fixtures; production contracts should not instantiate it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderFaultController {
    schedule: ProviderFaultSchedule,
    dispatch_attempts: u64,
    inbound_attempts: u64,
}

impl ProviderFaultController {
    pub const fn from_seed(seed: u64) -> Self {
        Self::new(ProviderFaultSchedule::from_seed(seed))
    }

    pub const fn new(schedule: ProviderFaultSchedule) -> Self {
        Self {
            schedule,
            dispatch_attempts: 0,
            inbound_attempts: 0,
        }
    }

    pub const fn schedule(self) -> ProviderFaultSchedule {
        self.schedule
    }

    pub const fn attempts(self, stage: FaultStage) -> u64 {
        match stage {
            FaultStage::Dispatch => self.dispatch_attempts,
            FaultStage::Inbound => self.inbound_attempts,
        }
    }

    pub fn next(&mut self, stage: FaultStage) -> bool {
        let attempt = self.attempts(stage);
        match stage {
            FaultStage::Dispatch => self.dispatch_attempts += 1,
            FaultStage::Inbound => self.inbound_attempts += 1,
        }
        self.schedule.fails(stage, attempt)
    }

    pub const fn reset(&mut self) {
        self.dispatch_attempts = 0;
        self.inbound_attempts = 0;
    }
}

const fn mix(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use super::{FaultStage, ProviderFaultController, ProviderFaultSchedule};

    #[test]
    fn shared_vectors_pin_the_same_schedule_used_by_all_local_consumers() {
        for line in include_str!("../../../../testdata/provider-fault-vectors.tsv").lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let fields: std::vec::Vec<_> = line.split('|').collect();
            assert_eq!(fields.len(), 3);
            let seed = fields[0].parse().unwrap();
            let schedule = ProviderFaultSchedule::from_seed(seed);
            assert_eq!(
                schedule.dispatch_mask,
                u64::from_str_radix(&fields[1][2..], 16).unwrap()
            );
            assert_eq!(
                schedule.inbound_mask,
                u64::from_str_radix(&fields[2][2..], 16).unwrap()
            );
        }
    }

    #[test]
    fn same_seed_replays_each_stage() {
        let mut left = ProviderFaultController::from_seed(156);
        let mut right = ProviderFaultController::from_seed(156);
        for _ in 0..80 {
            assert_eq!(
                left.next(FaultStage::Dispatch),
                right.next(FaultStage::Dispatch)
            );
            assert_eq!(
                left.next(FaultStage::Inbound),
                right.next(FaultStage::Inbound)
            );
        }
    }

    #[test]
    fn masks_select_only_the_requested_stage() {
        let mut controller =
            ProviderFaultController::new(ProviderFaultSchedule::with_masks(7, 1, 0));
        assert!(controller.next(FaultStage::Dispatch));
        assert!(!controller.next(FaultStage::Inbound));
    }
}
