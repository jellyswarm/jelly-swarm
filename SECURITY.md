# Security policy

## Scope

This policy covers the new JellySwarm frontend, API scaffold, database migration runner, GitHub Actions workflows, and the placeholder Foundry contract. The contents of `legacy/` are archived for reference and are not the active design target.

## Reporting

Email **notadeveloper7@outlook.com** with a concise report and reproduction steps. Do not open a public issue for a suspected vulnerability. We aim to acknowledge reports within 48 hours and provide a remediation plan for confirmed critical issues within seven days where practical.

Please avoid accessing other users' data, disrupting services, or submitting transactions without authorization. Good-faith reports will be credited with the reporter's consent.

## Main attack surfaces

- API authorization and request parsing as product routes are added.
- SQL injection or unsafe migration behavior in the PostgreSQL layer.
- Secret exposure through frontend build variables, logs, or CI configuration.
- Deployment workflow permissions, package publishing, and Render deploy hooks.
- Future contract access control, asset handling, and deployment key management.

There are no JellySwarm contracts deployed by this scaffold. The contract in `contracts/src/JellySwarmCore.sol` is a local toolchain placeholder and is not intended for deployment with real assets.
