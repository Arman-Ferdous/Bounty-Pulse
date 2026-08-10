# BountyPulse Checkpoint 2 file bundle

Copy the folders into the root of the existing Foundry repository:

```bash
rm -f src/Counter.sol script/Counter.s.sol test/Counter.t.sol
cp -r src script test /path/to/Bounty-Pulse/
cp foundry.toml /path/to/Bounty-Pulse/foundry.toml
```

Then run:

```bash
forge fmt
forge build
forge test -vv
forge test --gas-report
```

With Anvil running and `.env` loaded:

```bash
set -a
source .env
set +a

forge script script/DeployBountyPulse.s.sol:DeployBountyPulse \
  --rpc-url "$ANVIL_RPC_URL" \
  --broadcast \
  -vvvv
```

Alternative direct deployment, matching the reference Voting manual:

```bash
forge create src/BountyPulse.sol:BountyPulse \
  --rpc-url "$ANVIL_RPC_URL" \
  --private-key "$ANVIL_DEPLOYER_PRIVATE_KEY" \
  --broadcast
```


The Arbiter is the contract deployer. The deployer can also call `registerUser`
with `Role.Arbiter` to store the required name and avatar CID in the Registry.

Do not run both deployment commands unless you intentionally want two separate
contract deployments. Every redeployment produces a new contract address.
