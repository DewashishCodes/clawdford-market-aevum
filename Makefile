# Clawdford Market developer commands. Run from the repo root.
# Aevum is a Shanghai EVM with legacy transactions; every target below respects that.

AEVUM_RPC ?= https://rpc-test.qday.info
FORK_CHAIN_ID ?= 440050

.PHONY: install build test test-contracts test-ts check-shanghai coverage anvil fork deploy-fork deploy-aevum check-setup fmt facilitator e2e-anvil e2e-fork

install:
	pnpm install
	cd contracts && forge install

build:
	cd contracts && forge build

test: test-contracts check-shanghai test-ts

test-contracts:
	cd contracts && forge test

test-ts:
	node --test tools/check-shanghai.test.mjs
	pnpm -r --if-present typecheck
	pnpm -r --if-present test

check-shanghai: build
	node tools/check-shanghai.mjs contracts/out

coverage:
	cd contracts && forge coverage --no-match-coverage "(test|script)/" --report summary

# Deploy targets read keys and settings from the root .env.

# Plain local chain with MockTUSD8.
anvil:
	anvil --hardfork shanghai

# Local fork of Aevum with the real tUSD8. Use `deal` in tests for balances.
fork:
	anvil --fork-url $(AEVUM_RPC) --hardfork shanghai --chain-id $(FORK_CHAIN_ID)

deploy-fork:
	set -a && . ./.env && set +a && cd contracts && forge script script/Deploy.s.sol --rpc-url fork --broadcast --legacy

deploy-aevum: check-shanghai
	set -a && . ./.env && set +a && cd contracts && forge script script/Deploy.s.sol --rpc-url aevum --broadcast --legacy --slow

check-setup:
	pnpm check-setup

fmt:
	cd contracts && forge fmt

# Facilitator (reads the root .env: FACILITATOR_PRIVATE_KEY, CHAIN_ID).
facilitator:
	pnpm --filter @clawdford/facilitator start

# End-to-end facilitator tests: spawn anvil on :8546, run Deploy.s.sol, pay through HTTP.
e2e-anvil:
	cd services/facilitator && FACILITATOR_E2E=anvil pnpm exec vitest run test/e2e.test.ts
	cd packages/sdk && SDK_E2E=anvil pnpm exec vitest run test/e2e.test.ts
	cd services/sellers && SELLERS_E2E=anvil pnpm exec vitest run test/e2e.test.ts

e2e-fork:
	cd services/facilitator && FACILITATOR_E2E=fork pnpm exec vitest run test/e2e.test.ts
	cd packages/sdk && SDK_E2E=fork pnpm exec vitest run test/e2e.test.ts
	cd services/sellers && SELLERS_E2E=fork pnpm exec vitest run test/e2e.test.ts
