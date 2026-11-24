// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {StallRegistry} from "../src/StallRegistry.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";
import {ITUSD8} from "../src/interfaces/ITUSD8.sol";

/// @notice Deploys the full protocol and writes deployments/<chainId>.json.
///         Aevum: `make deploy-aevum` (legacy txs). Fork: `make deploy-fork`. Plain anvil (31337) gets a MockTUSD8.
/// Env: DEPLOYER_PRIVATE_KEY, optional TREASURY_ADDRESS and ARBITER_ADDRESS (default: deployer), FEE_BPS (300),
///      MIN_STAKE (250000), UNSTAKE_COOLDOWN (3600), CHALLENGE_WINDOW (600), REVIEW_WINDOW (3600), TOKEN_ADDRESS.
contract Deploy is Script {
    address internal constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    // Public anvil key #0. Funds sent to it on a public chain are swept by bots.
    address internal constant ANVIL_DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    struct Config {
        uint256 pk;
        address deployer;
        address treasury;
        address arbiter;
        uint16 feeBps;
        uint128 minStake;
        uint64 cooldown;
        uint64 challenge;
        uint64 review;
    }

    struct Deployed {
        uint256 deployBlock;
        address token;
        IdentityRegistry identities;
        StallRegistry stalls;
        AgentVault vault;
        ReputationRegistry reputation;
    }

    function run() external returns (Deployed memory d) {
        Config memory c = _config();
        d = _deploy(c);
        _write(c, d);
    }

    function _config() internal view returns (Config memory c) {
        c.pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.deployer = vm.addr(c.pk);
        if (block.chainid == 44005) require(c.deployer != ANVIL_DEPLOYER, "refusing anvil key on Aevum");
        c.treasury = vm.envOr("TREASURY_ADDRESS", c.deployer);
        c.arbiter = vm.envOr("ARBITER_ADDRESS", c.deployer);
        c.feeBps = uint16(vm.envOr("FEE_BPS", uint256(300)));
        c.minStake = uint128(vm.envOr("MIN_STAKE", uint256(250_000)));
        c.cooldown = uint64(vm.envOr("UNSTAKE_COOLDOWN", uint256(1 hours)));
        c.challenge = uint64(vm.envOr("CHALLENGE_WINDOW", uint256(10 minutes)));
        c.review = uint64(vm.envOr("REVIEW_WINDOW", uint256(1 hours)));
    }

    function _deploy(Config memory c) internal returns (Deployed memory d) {
        d.deployBlock = block.number;
        vm.startBroadcast(c.pk);
        d.token = block.chainid == 31337 ? address(new MockTUSD8()) : vm.envOr("TOKEN_ADDRESS", AEVUM_TUSD8);
        d.identities = new IdentityRegistry();
        d.stalls = new StallRegistry(
            ITUSD8(d.token), d.identities, c.deployer, c.arbiter, c.treasury, c.minStake, c.cooldown
        );
        d.vault = new AgentVault(ITUSD8(d.token), d.stalls, c.deployer, c.treasury, c.arbiter, c.feeBps);
        d.reputation = new ReputationRegistry(d.vault);
        if (c.challenge != d.vault.challengeWindow()) d.vault.setChallengeWindow(c.challenge);
        if (c.review != d.vault.reviewWindow()) d.vault.setReviewWindow(c.review);
        vm.stopBroadcast();
    }

    function _write(Config memory c, Deployed memory d) internal {
        string memory j = "deployment";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "deployBlock", d.deployBlock);
        vm.serializeAddress(j, "deployer", c.deployer);
        vm.serializeAddress(j, "treasury", c.treasury);
        vm.serializeAddress(j, "arbiter", c.arbiter);
        vm.serializeUint(j, "feeBps", c.feeBps);
        vm.serializeAddress(j, "tUSD8", d.token);
        vm.serializeAddress(j, "IdentityRegistry", address(d.identities));
        vm.serializeAddress(j, "StallRegistry", address(d.stalls));
        vm.serializeAddress(j, "AgentVault", address(d.vault));
        string memory out = vm.serializeAddress(j, "ReputationRegistry", address(d.reputation));
        string memory path =
            string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console.log("wrote", path);
    }
}
