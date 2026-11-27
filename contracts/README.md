# Contracts

The current payment design uses the configured escrow EOA wallet (`ESCROW_PUBLIC_KEY`) to hold USDC. The backend uses its matching `ESCROW_PRIVATE_KEY` to distribute funds after verifying a treasury-signed EIP-712 refund decision. No product escrow contract is required for this custody model.

`JellySwarmCore.sol` is the original scaffold placeholder and is not part of the payment flow. Do not deploy it for production payments.
