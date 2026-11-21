# EVM permit dispatch and native refund recovery

These entrypoints belong to EVM development infrastructure. The active deployment remains
Stellar Testnet outbound ITS/CCTP. Live EVM activation still requires independent review and
signed acceptance evidence.

## Permit-assisted dispatch

`bridgeOutWithPermit(request, deadline, v, r, s)` uses an EIP-2612 signature whose owner is the
caller and whose spender is this router. Its allowance is exactly the quoted gross debit:
the fee on `request.amount` plus the net amount after destination precision flooring. Dust
that cannot cross the bridge remains with the sender. Sign against the token's current permit
nonce and EIP-712 domain, using the router's current quote and a suitable deadline.

The router validates the request before calling the token's permit, then revalidates and
charges the flow window before moving funds. Expired, replayed, wrong-spender, or wrong-value
signatures revert. Dispatch failure rolls back the allowance, token permit nonce, fee, flow
charge, and router nonce together. Permit callbacks cannot reenter dispatch.

Tokens without EIP-2612 retain `approve(router, amount)` followed by `bridgeOut(request)`.
If someone has already submitted a valid permit directly to the token, its nonce is consumed;
the atomic permit entrypoint rejects that replay. The owner can use the resulting exact
allowance through the explicit `bridgeOut` path after checking the request again. The router
does not silently ignore permit failures.

## Native refunds

`bridgeOut` and `bridgeOutBounded` keep their existing behavior: a failed native refund reverts
the transfer. `bridgeOutWithRefundCredit` is an explicit alternative. It first attempts to
return the native remainder to the caller, with 30,000 callback gas. Only a failed attempt
records `refundCredits[caller]` and emits `RefundCreditRecorded`. A receiver that consumes
all its callback gas cannot prevent the router from retaining the credit. Token debit,
destination, rail dispatch, and outbound nonce have the same meaning in both modes.

Only the original beneficiary can withdraw their bucket. `withdrawRefundCredit()` pays the
caller; `withdrawRefundCredit(recipient)` pays a nonzero recipient they choose. The recipient
overload allows recovery when the beneficiary contract permanently refuses native currency.
Both paths clear the credit before the external call, prevent reentrancy, and restore the
credit if payment fails. Successful withdrawal emits `RefundCreditWithdrawn`. Withdrawal
remains available while outbound transfers are paused. Existing credits are retained in the
router's native balance and excluded from later senders' refunds.

## Compatibility and migration

Existing dispatch selectors, explicit approvals, token amounts, rail authentication, inbound
replay guards, and recipient-bound token claims remain unchanged. The new entrypoints and
events require refreshed router ABIs; refund credit adds router storage without changing
token intent or Soroban storage. Existing EVM contracts cannot acquire these entrypoints by
changing a client ABI. A separately reviewed deployment and explicit address/configuration
migration are required before using them; this change does not activate a live EVM route.

## Local regression coverage

`forge test` includes `RouterPermitTest` and `RouterRefundCreditTest`. They use real
OpenZeppelin EIP-2612 signatures, invalid/replayed permits, legacy explicit approvals,
provider failure rollback, rejecting and gas-consuming refund recipients, authorized
recipient recovery, credit isolation, and callback attempts to duplicate dispatch or
withdrawal. `forge fmt --check`, the EVM lint suites, and generated ABI parity remain
required checks.
