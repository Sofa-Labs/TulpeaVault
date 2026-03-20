# TulpeaYieldVault

ERC-4626 tokenized vault with ERC-7540 asynchronous redemptions and a pluggable strategy registry. Solidity 0.8.24, OpenZeppelin Contracts v5.4.0, UUPS proxy pattern. Asset: configurable at initialization (currently USDT0, 6 decimals on MegaETH).

**Previous audits**: None. This is the first audit engagement.

---

## Scope

| Contract | Path | nSLOC | Purpose |
|----------|------|------:|---------|
| TulpeaYieldVault | `TulpeaYieldVault.sol` | 499 | ERC-4626 vault, ERC-7540 async redemptions, strategy registry, deployment timelock, health checks |
| RealEstateStrategy | `strategies/RealEstateStrategy.sol` | 261 | Deposits into PropertyVaults as lender, holds portfolio NFTs, harvests yield. Illiquid. |
| AvonStrategy | `strategies/AvonStrategy.sol` | 168 | Swaps asset to USDm via Kumbaya DEX, deposits into Avon MegaVault (ERC-4626) for lending yield |
| IStrategy | `interfaces/IStrategy.sol` | 6 | Strategy interface |
| IERC7540 | `interfaces/IERC7540.sol` | 21 | ERC-7540 redeem + operator interfaces |
| ITulpeaYieldVault | `interfaces/ITulpeaYieldVault.sol` | 4 | Minimal vault interface for strategies to read `keeper()` |
| IPropertyVaultStrategy | `interfaces/IPropertyVaultStrategy.sol` | 5 | Minimal PropertyVault interface for `depositAsLender()` |
| **Total** | | **964** | |

**Out of scope**: `mocks/`, `libraries/`, test files, deployment scripts, frontend code, `contracts/liquid-lock/`.

---

## Architecture

```
                       +------------------------+
                       |   TulpeaYieldVault     |
                       | ERC-4626 + ERC-7540    |
                       | UUPS Upgradeable       |
                       | Ownable2Step, Pausable  |
                       +-----------+------------+
                                   |
                   +---------------+---------------+
                   |                               |
          +--------v--------+             +--------v--------+
          | RealEstate      |             | AvonStrategy     |
          | Strategy        |             | (Kumbaya DEX +   |
          | (NFT-backed,    |             |  Avon MegaVault) |
          |  illiquid)      |             +---------+--------+
          +--------+--------+                       |
                   |                        +-------v---------+
        +----------+----------+             | Kumbaya DEX     |
        |                     |             | (Uni V3 fork)   |
  +-----v------+  +-----v----+             +-------+---------+
  | Property   |  | Portfolio |                     |
  | Vault      |  | NFT      |             +-------v---------+
  | (deposit)  |  | (yield)  |             | Avon MegaVault  |
  +------------+  +----------+             | (ERC-4626)      |
                                           +-----------------+
```

---

## Trusted Roles & Admin Powers

| Role | Who | Trust Assumption |
|------|-----|------------------|
| **Owner** (vault) | Multisig | Full control: deploy funds (24h timelock), fulfill redemptions, pause, upgrade, add/remove strategies. **Can delay withdrawals indefinitely** by not calling `fulfillRedeem`. **Cannot steal deposited funds** without 24h timelock window. |
| **Owner** (strategies) | Same multisig | Can call `depositToProperty`, `emergencyWithdraw*`, `emergencyTransferNft`. **Can move all strategy assets** via emergency functions. |
| **Keeper** | Bot EOA | Can call `processReport` (vault) and `harvest`/`deposit` (strategies). **Cannot** deploy funds, fulfill redemptions, pause, or upgrade. Cannot move funds to arbitrary addresses. |
| **Operator** (ERC-7540) | Per-user approval | Can call `requestRedeem` on behalf of owner, and `withdraw`/`redeem` on behalf of controller. Set via `setOperator`. |

---

## Core Mechanics

### Share Price

```
totalAssets() = vaultBalance + totalDebt - totalClaimableWithdrawals
```

- `vaultBalance` = `IERC20(asset()).balanceOf(address(this))`
- `totalDebt` = sum of assets deployed to strategies
- `totalClaimableWithdrawals` = fulfilled but unclaimed assets

`DECIMALS_OFFSET = 6` for ERC-4626 inflation/donation attack protection (1 asset unit = 1M internal shares).

### Deposits

Standard ERC-4626 `deposit`/`mint`. Protected by `nonReentrant` + `whenNotPaused`. Blocked when: paused, `emergencyShutdown`, orphaned debt (`totalSupply == 0 && totalDebt > 0`), or deposit limit exceeded.

### Strategy Lifecycle

```
addStrategy(addr)
    |
    v
requestDeploy(strategy, amount) --- 24h timelock ---> executeDeploy(id)
    |                                                       |
    |  cancelDeploy(id)                                     v
    v                                            funds transferred to strategy
    |
processReport(strategy)  <--- called periodically by keeper/owner
    |
    +--- profit: totalDebt increases, share price rises
    +--- loss: totalDebt decreases, share price drops
    |    +--- loss >= 50%: emergencyShutdown = true
    |
    v
withdrawFromStrategy(strategy, amount)  --- pulls funds back to vault
    |
    v
removeStrategy(addr)  --- only if currentDebt == 0
```

---

## ERC-7540 Withdrawal Flow

3-step async redemptions. `previewWithdraw`/`previewRedeem` revert per ERC-7540 spec.

### Step 1: `requestRedeem(shares, controller, owner)` -- User

Escrows shares from `owner` to vault (transfer, NOT burn). Records pending under `controller`. One pending request per controller. Event `assets` field is an estimate only, not stored.

### Step 2: `fulfillRedeem(controller)` -- Owner (admin)

Converts ALL pending shares to assets at CURRENT price (loss socialization). Burns escrowed shares. Requires `_vaultBalance() >= totalClaimableWithdrawals + newAssets`.

### Step 3: `withdraw` / `redeem` -- User or Operator

Claims fulfilled assets. Partial claims supported. Skips `mulDiv` when claiming all remaining (rounding dust protection).

### Cancel: `cancelWithdraw()` -- Controller

Returns escrowed shares to `pendingWithdrawalOwner` (original owner, not controller).

---

## Strategy: RealEstateStrategy

Deposits into PropertyVaults as lender, holds portfolio NFTs, harvests yield via `claimLenderYield`.

- **Illiquid**: `withdraw()` only sends idle assets. Must `harvest()` first.
- **MAX_NFTS = 50**: Gas cap on `totalAssets()` iteration.
- **O(1) NFT tracking**: swap-and-pop via `heldNftIds[]` + `nftIndex` mapping.
- **Auto-cleanup**: `harvest()` removes burned/transferred NFTs.
- **Unsolicited NFT rejection**: reverts for portfolio NFTs outside `depositToProperty()`.

### NFT Value Formula

```
maxReturn       = invested * (10000 + yieldCapBps) / 10000
totalAllocated  = totalClaimed + amountOwed
lockedPrincipal = invested * (maxReturn - totalAllocated) / maxReturn   [0 if totalAllocated >= maxReturn]
nftValue        = min(lockedPrincipal + amountOwed, maxReturn)

totalAssets()   = idle balance + sum(nftValue) for all held NFTs
```

---

## Strategy: AvonStrategy

Swaps asset to USDm via Kumbaya DEX (Uni V3 fork), deposits into Avon MegaVault (ERC-4626).

- **DECIMAL_SCALE = 1e12**: USDm (18 dec) to asset (6 dec) conversion.
- **MAX_SLIPPAGE_BPS = 50** (0.5%): Hardcoded, not configurable post-deployment.
- **SWAP_FEE_TIER = 100** (0.01%): Kumbaya pool fee.
- **SWAP_DEADLINE_BUFFER = 300s**: Multicall deadline.
- **1:1 approximation**: `totalAssets()` assumes USDm ~ asset. Depeg = overstated value until `processReport`.

```
totalAssets() = megaVault.convertToAssets(shares) / 1e12
              + usdm.balanceOf(this) / 1e12
              + asset.balanceOf(this)
```

---

## Access Control

### Vault

| Function | Caller | Notes |
|----------|--------|-------|
| `deposit` / `mint` | Anyone | Deposit limit, pause, emergency shutdown |
| `requestRedeem` | Share owner or operator | Escrows shares |
| `cancelWithdraw` | Controller | Returns shares to original owner |
| `withdraw` / `redeem` | Owner or operator | Claims fulfilled assets |
| `setOperator` | Anyone (for self) | ERC-7540 operator |
| `fulfillRedeem` | `onlyOwner` | |
| `setDepositLimit` / `pause` / `unpause` | `onlyOwner` | |
| `resolveEmergencyShutdown` | `onlyOwner` | |
| `setKeeper` / `setHealthCheck` | `onlyOwner` | |
| `addStrategy` / `removeStrategy` | `onlyOwner` | |
| `requestDeploy` / `executeDeploy` / `cancelDeploy` | `onlyOwner` | 24h timelock |
| `withdrawFromStrategy` | `onlyOwner` | |
| `processReport` | `onlyKeeperOrOwner` | |
| `_authorizeUpgrade` | `onlyOwner` | UUPS |

### RealEstateStrategy

| Function | Caller |
|----------|--------|
| `withdraw` | Vault only |
| `depositToProperty` | `onlyOwner` |
| `harvest` / `harvestSingle` / `cleanupBurnedNfts` | `onlyKeeperOrOwner` |
| `emergencyWithdrawToken` / `emergencyTransferNft` / `emergencyRecoverNft` | `onlyOwner` |

### AvonStrategy

| Function | Caller |
|----------|--------|
| `withdraw` | Vault only |
| `deposit` | `onlyKeeperOrOwner` |
| `emergencyWithdrawToken` | `onlyOwner` |

---

## External Integrations

| Protocol | Contract | Assumption |
|----------|----------|------------|
| **Kumbaya DEX** (Uni V3 fork) | `IV3SwapRouter` (SwapRouter02) | Pool for asset/USDm exists with fee tier 100. Router is not paused or upgraded. |
| **Avon MegaVault** | `IERC4626` | Standard ERC-4626. `convertToAssets` returns accurate USDm value. Not paused. |
| **PropertyVault** | `IPropertyVaultStrategy` | `depositAsLender` mints exactly one NFT per deposit via `_safeMint`. |
| **PortfolioMaster** | `IPortfolioMasterStrategy` | `claimLenderYield` transfers accrued yield to caller. May auto-burn fully repaid NFTs. |
| **PortfolioNFT** | `IPortfolioNFTStrategy` | `getPosition` returns accurate NFT state. `ownerOf` reverts for burned tokens. |

Issues in external protocols (Kumbaya, Avon, PropertyVault, PortfolioMaster, PortfolioNFT) are **out of scope** unless they create a vulnerability in the in-scope contracts.

---

## Attack Ideas / Focus Areas

1. **Share price manipulation**: Can an attacker manipulate `totalAssets()` (via donation, strategy reporting, or external protocol state) to extract value from other depositors?
2. **Withdrawal accounting**: Can escrowed shares, claimable assets, or `totalClaimableWithdrawals` become inconsistent, leading to stuck funds or over-claiming?
3. **Strategy debt desync**: Can `totalDebt` or `strategies[s].currentDebt` diverge from actual strategy holdings, causing incorrect share pricing?
4. **Cross-function reentrancy**: External calls to strategies, DEX router, and MegaVault -- can any callback path bypass `nonReentrant` or manipulate state between checks?
5. **Fund reservation bypass**: Can `executeDeploy` deploy funds that are reserved for pending/claimable withdrawals, leaving the vault unable to fulfill redemptions?

---

## Key Invariants

| ID | Invariant |
|----|-----------|
| SOLVENCY_01 | `totalAssets() == _vaultBalance() + totalDebt - totalClaimableWithdrawals` (0 if underflow) |
| SOLVENCY_02 | `totalDebt == sum(strategies[s].currentDebt)` for all active strategies |
| SOLVENCY_03 | After `fulfillRedeem`: `_vaultBalance() >= totalClaimableWithdrawals` |
| ESCROW_01 | `totalEscrowedShares == sum(pendingWithdrawalShares[c])` for all controllers |
| ESCROW_02 | Vault's self-held shares (`balanceOf(address(this))`) == `totalEscrowedShares` |
| WITHDRAW_01 | `previewWithdraw` and `previewRedeem` always revert |
| WITHDRAW_02 | At most one pending request per controller address |
| STRATEGY_01 | `removeStrategy` requires `currentDebt == 0` |
| STRATEGY_02 | `executeDeploy` re-validates strategy is active at execution time |
| SHUTDOWN_01 | Emergency shutdown is triggered only by `processReport` (loss >= 50%), resolved only by `resolveEmergencyShutdown` |

---

## Known Limitations / Out-of-Scope Issues

These are intentional design decisions. Do NOT report as findings.

1. **Single request per controller**: One pending redemption per address. By design to simplify accounting.
2. **Admin-gated fulfillment**: No automated fulfillment. Admin controls liquidity timing. Can delay indefinitely.
3. **RealEstateStrategy is illiquid**: `withdraw()` only sends idle assets (harvested yield). NFT principal is locked until properties repay -- the USDT was disbursed to the property owner via `withdrawPropertyFunds()`, so there is no contract holding it that can be force-liquidated. Admin must call `harvest()` first. Cross-strategy liquidity (pull from AvonStrategy) is the intended mitigation.
4. **NFT gas cap at 50**: `totalAssets()` iterates all NFTs. Bounded but expensive at cap.
5. **1:1 stablecoin assumption**: AvonStrategy `totalAssets()` assumes USDm ~ asset. Depeg overstates value until `processReport`.
6. **No partial fulfillment**: `fulfillRedeem` converts all pending shares for a controller.
7. **No withdrawal queue ordering**: Fulfillment order is admin's discretion, no FIFO.
8. **Hardcoded swap slippage**: AvonStrategy `MAX_SLIPPAGE_BPS = 50` is immutable.
9. **`cancelWithdraw` returns to original owner**: Not controller. Intentional (F1 audit fix).
10. **Keeper is dynamic**: Strategies read `vault.keeper()` at call time. Keeper change propagates automatically.

---

## Build and Test

**Prerequisites**: Node.js 20.x (`source ~/.nvm/nvm.sh && nvm use 20`)

```bash
# Compile
npm run compile

# Vault tests (15 files)
npx hardhat test test/TulpeaYieldVault.*.test.ts --config hardhat.config.cjs --no-compile

# Strategy tests (3 files)
npx hardhat test test/strategies/*.test.ts --config hardhat.config.cjs --no-compile

# All yield vault tests
npx hardhat test test/TulpeaYieldVault.*.test.ts test/strategies/*.test.ts --config hardhat.config.cjs --no-compile
```

`--no-compile` is required: `hardhat.config.cjs` uses `viaIR: true` which breaks unrelated Aave V3 contracts. Compile first with default config.

---

## Deployment

- **Vault**: UUPS proxy. Constructor `_disableInitializers()`. `initialize()` on proxy. Storage gap: `uint256[27] __gap`.
- **Strategies**: Non-upgradeable, immutable constructor args, not proxied.
