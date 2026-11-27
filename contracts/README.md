# Contracts

`JellySwarmEscrow` holds Elysium USDC job payments. The client approves and funds a unique job, then the treasury signs an EIP-712 settlement decision. Supported client shares are 100%, 70%, 50%, and 0%; the remainder goes to the treasury. A decision is chain-, contract-, job-, nonce-, and deadline-bound. Anyone can submit the signed decision and pays their own gas.

`JellySwarmCore` remains as the original scaffold and is not used for payments. The deployment script checks that `ESCROW_PRIVATE_KEY` matches `ESCROW_PUBLIC_KEY`, then deploys the escrow using `ELYSIUM_USDC_ADDRESS` and `TREASURY_PUBLIC_KEY`. Deploy only after reviewing the contract and its tests on Elysium testnet.

Install the local test dependency with `forge install --no-git foundry-rs/forge-std`, then run `forge build` and `forge test`.
