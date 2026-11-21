# EVM transfer intents

`bridgeOutWithIntent` is a development-only relayer entrypoint. A sender signs the complete
`TransferIntent` with EIP-712; the typed value includes the token, exact amount, route, recipient,
slippage floor, provider budget, sender nonce, deadline, chain ID, and router address. The router
also binds those last two values in the EIP-712 domain, so the same signature cannot execute on a
different chain or router.

The sender must approve the router before signing. The relayer supplies `msg.value` and may not
exceed the signed `maxProviderBudget`; any unused provider value is refunded to the sender. This
entrypoint does not define a relayer fee or trust model. A relayer may charge separately under an
application-level agreement, but no fee is deducted from the transfer by the router.

The per-sender intent nonce is consumed once, only after signature, deadline, domain, and budget
checks pass. This feature is development infrastructure and does not activate a live EVM rail;
production deployment still requires an independently reviewed activation and signed acceptance
evidence.
