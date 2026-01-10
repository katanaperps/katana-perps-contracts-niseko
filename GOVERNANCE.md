# Controls and Governance

## Overview

Niseko’s on-chain components span three primary contracts, each with attendant controls and governance. Niseko’s primary contracts also interact with an extensible set of cross-chain bridge adapter contracts, index price adapter contracts, oracle price adapter contracts, and managed account provider contracts.

## Custodian Contract

The Custodian contract custodies user funds with minimal additional logic. Specifically, it tracks two control contract addresses:

- Exchange: the Exchange contract address is the only agent whitelisted to authorize transfers of funds out of the Custodian.
- Governance: the Governance contract address is the only agent whitelisted to authorize changing the Exchange and Governance contract addresses within the Custodian.

Additionally, the Custodian contract includes the ability to migrate a held asset from one token contract to another. No Asset Migrator contract is specified at deployment time. Specifying an Asset Migrator is exclusively controlled by the Governance contract subject to a delay for safety. 

## Governance Contract

The Governance contract implements the contract upgrade logic while enforcing governance constraints.

- The Governance contract has a single owner, and the owner can be changed with no delay by the owner.
- The Governance contract has a single admin, and the admin can be changed with no delay by the owner.
- The admin is the only agent whitelisted to change the Custodian’s Exchange or Governance contract addresses, or specify an Asset Migrator contract, but the change is a two-step process.
  - The admin first calls an upgrade authorization with the new contract address, which initiates the Contract Upgrade Period.
  - Once the Contract Upgrade Period expires, the admin can make a second call that completes the change to the new contract address.
- At any time during the Contract Upgrade Period, the admin can cancel the upgrade immediately.
- The admin can clear the Asset Migrator contract address immediately.

The Governance contract also implements field update logic for sensitive Exchange settings.

- The admin is the only agent whitelisted to change several Exchange settings:
  - Bridge adapter contract address whitelist
  - Index price adapter contract address whitelist
  - Insurance fund wallet address, provided that neither the existing nor new wallet has any open non-quote positions and the new wallet is not exited
  - Managed account provider contract address whitelist, provided existing addresses are not removed from the list
  - Market configuration override values, subject to limits as defined in Exchange contract’s [fixed parameter settings](#market-override-fixed-parameter-settings).
  - Oracle price adapter contract address
- Updating any of the governed fields is a two-step process.
  - The admin first calls an update initiation with the new value(s), which initiates the Field Update Period.
  - Once the Field Update Period expires, the admin or the dispatcher wallet can make a second call that completes the change to the setting. The dispatcher wallet is authorized to finalize an update in order to synchronize configuration changes between on-chain and off-chain systems.
- At any time during the Field Update Period, the admin can cancel the update immediately.

### Fixed Parameter Settings

These settings have been pre-determined and may be hard-coded or implicit in the contract logic.

- Owner Change Period: immediate
- Admin Change Period: immediate
- Contract Upgrade Period: 72 hours, set during deployment
- Contract Upgrade Cancellation Period: immediate
- Field Update Period: 24 hours
- Field Update Cancellation Period: immediate

## Exchange Contract

The Exchange contract implements the majority of exchange functionality, including wallet asset balance tracking. As such, it contains several fine-grained control and protection mechanisms:

- Exchange has a single owner, and the owner can be changed with no delay by the owner.
- Exchange has a single admin, and the admin can be changed with no delay by the owner.
- The admin can change the Chain Propagation Period with no delay, subject to the Minimum Chain Propagation Period and Maximum Chain Propagation Period limits.
- The admin can change the Delegated Key Expiration Period with no delay, subject to the Minimum Delegated Key Expiration Period and Maximum Delegated Key Expiration Period limits.
- The admin can change the Position Below Minimum Liquidation Price Tolerance Multiplier with no delay to a non-negative value less than or equal to the Maximum Fee Rate.
- The admin can enable or disable deposits with no delay.
- Exchange tracks a single exit fund wallet address, and the exit fund wallet can be changed with no delay by the admin, provided that neither the existing nor new wallet has any open positions or quote balance.
- The admin can withdraw any positive quote balance from the exit fund after a fixed delay after the exit fund opens its first non-quote position.
- Exchange tracks a single fee wallet address, and the fee wallet can be changed with no delay by the admin.
- The admin can change the quote token address with no delay once an Asset Migrator has been added to the Custodian via Governance. Governance introduces its own delay for adding an Asset Migrator to the Custodian for safety.
- The admin can change or remove an address as the dispatcher wallet with no delay. The dispatcher wallet is authorized to call operator-only contract functions: `executeTrade`, `liquidatePositionBelowMinimum`, `liquidatePositionInDeactivatedMarket`, `liquidateWalletInMaintenance`, `liquidateWalletInMaintenanceDuringSystemRecovery`, `liquidateWalletExited`, `deleverageInMaintenanceAcquisition`, `deleverageInsuranceFundClosure`, `deleverageExitAcquisition`, `deleverageExitFundClosure`, `transfer`, `withdraw`, `activateMarket`, `deactivateMarket`, `publishIndexPrices`, `publishFundingMultiplier`, `applyPendingDepositToManagedAccount`, `applyPendingWithdrawalFromManagedAccount`, and `cancelPendingWithdrawalFromManagedAccount`.
- The admin can add new markets with no delay, up to the maximum number of markets, with new market fields subject to limits. The dispatcher wallet can activate and deactivate markets.
- The admin can skim any tokens mistakenly sent to the Exchange contract rather than deposited.
- Wallet exits are user-initiated, and 1) prevent the target wallet from deposits, trades, normal withdrawals, and transfers and 2) subsequently allow the user to close all open positions and withdraw any positive quote balance. Managed account manager wallets cannot use the standard Exchange `exitWallet` function.
  - User calls `exitWallet` on Exchange.
  - Exchange records the exit and block timestamp, immediately blocks deposits, and starts the Chain Propagation Period.
  - Exchange allows the admin or the dispatcher wallet to close all open positions for the wallet at the exit price and withdraw any positive quote balance via `withdrawExitAdmin`.
  - After the Chain Propagation Period expires:
    - Exchange blocks any trades, normal withdrawals, and transfers for the wallet.
    - Exchange allows the user to close all open positions at the exit price and withdraw any positive quote balance via `withdrawExit`.
  - Off-chain, on detecting the `WalletExited` event:
    - All core actions are disabled for the wallet.
    - The wallet is marked as exited, which prevents re-enabling any of the core actions.
    - All open orders are canceled for the wallet.
    - The dispatcher wallet calls `liquidateWalletExited` or `deleverageExitAcquisition`, proactively closing all open positions of the wallet at the exit price.
  - An exited wallet can be reinstated for trading by calling the `clearWalletExit` function on Exchange.
- Nonce invalidation is user-initiated rather than operator-initiated.
  - User calls `invalidateOrderNonce` on Exchange with a nonce before which all orders and delegated keys should be invalidated.
    - Exchange validates:
      - The new nonce is not more than one day in the future.
      - The new nonce is newer than the last invalidated nonce, if present.
      - The current block timestamp is at or greater than the last invalidation's effective block timestamp, if present.
    - Exchange records the invalidation, and starts enforcing it in the trade function after the Chain Propagation Period.
  - Off-chain, on detecting the `OrderNonceInvalidated` event:
    - All orders opened prior to the target nonce for the wallet are canceled.
    - All delegated keys authorized prior to the target nonce are revoked.
- Fee maximums are enforced by Exchange and specified by the Maximum Fee Rate, which cannot be changed. The Maximum Fee Rate applies to both maker and taker trade fees, position in deactivated market liquidation, and transfers.
  - Maximum fees for withdrawals are not subject to the Maximum Fee Rate. They are included as a parameter signed by the withdrawing wallet at request time and cannot exceed the withdrawal quantity.

### Fixed Parameter Settings

These settings have been pre-determined and may be hard-coded or implicit in the contract logic.

- Owner Change Period: immediate
- Admin Change Period: immediate
- Minimum Chain Propagation Period: 0
- Maximum Chain Propagation Period: 1 day
- Chain Propagation Change Period: immediate
- Minimum Delegated Key Expiration Period: 0
- Maximum Delegated Key Expiration Period: 1 year
- Delegated Key Expiration Change Period: immediate
- Exit Fund Wallet Change Period: immediate
- Exit Fund Withdraw Delay: 1 week
- Fee Wallet Change Period: immediate
- Dispatcher Wallet Change Period: immediate
- Maximum Number of Markets: 255
- Market Override Field Limits <a id="market-override-fixed-parameter-settings"></a>
  - Minimum Initial Margin Fraction: 0.005
  - Minimum Maintenance Margin Fraction: 0.003
  - Minimum Incremental Initial Margin Fraction: 0.001
  - Maximum Baseline Position Size: 2^63 - 1
  - Incremental Position Size: > 0
  - Maximum Maximum Position Size: 2^63 - 1
  - Maximum Minimum Position Size: 2^63 - 2
- Maximum Fee Rate: 5%

### Changeable Parameters

These settings have the initial values below but are changeable in the contract according to the above specs.

- Chain Propagation Period: 1 hour
- Delegated Key Expiration Period: 35 days

## Bridge Adapter Contracts

The Exchange contract integrates with an extensible set of bridge adapter contracts (BACs). BACs contain the necessary logic to support seamless cross-chain deposits and withdrawal via bridge protocols.

- A whitelist defines the supported BAC addresses, and the admin can update the whitelist according to [Governance’s](#governance-contract) field update logic.
- Older BACs use an owner and admin model. In these contacts, the admin is authorized to make the changes noted below.
  - These have a single owner, and the owner can be changed with no delay by the owner.
  - These have a single admin, and the admin can be changed with no delay by the owner.
- Newer BACs use a single owner model with a 2-step update process. In these contracts, the owner is authorized to make the changes noted below.
- BACs implement controls for enabling and disabling deposits and withdrawals, and the admin or owner can change either setting with no delay.
  - Loopback adapters only include a withdrawal control as they do not support new deposits.
- The admin or owner can withdraw the native asset, used by some protocols for additional fee settlement, with no delay.
- Some BACs implement a configurable slippage multiplier, which the admin or owner can change to any non-negative value with no delay.
- Some BACs implement configurable compose parameters, which the owner can change with no delay.
  - Some parameter fields are subject to validation for safety.

### Fixed Parameter Settings

These settings have been pre-determined and may be hard-coded or implicit in the contract logic.

- Owner Change Period: immediate
- Admin Change Period: immediate
- Deposit Change Period: immediate
- Withdrawal Change Period: immediate
- Slippage Change Period: immediate.
- Compose Parameter Change Period: immediate.

## Index and Oracle Price Adapter Contracts

The Exchange contract integrates with an extensible set of index price adapter contracts (IPAC) and oracle price adapter contracts (OPAC). IPACs contain the necessary logic to validate index prices from a range of sources. OPACs provide on-chain pricing information when index pricing is unavailable.

- A whitelist defines the supported IPAC addresses, and the admin can update the whitelist according to [Governance’s](#governance-contract) field update logic.
- A single OPAC is whitelisted for oracle pricing, and the admin can change the OPAC according to [Governance’s](#governance-contract) field update logic.
- IPACs and OPACs implement controls and governance as required by the underlying providers.

## Managed Account Provider Contracts

The Exchange contract integrates with an extensible set of managed account provider contracts (MAPCs). MAPCs contain the necessary logic to support shared account ownership, with a manager wallet trading on behalf of depositor wallets.

- A whitelist defines the supported MAPC addresses, and the admin can update the whitelist according to [Governance’s](#governance-contract) field update logic.
- MAPCs have a single owner, and the owner can be changed with no delay by the owner.
- MAPCs have a single admin, and the admin can be changed with no delay by the owner.
- The admin can enable or disable managed account creation, deposit initiation, and deposit application with no delay.
- The admin can change the Managed Account Upgrade Block Timestamp Delay with no delay, subject to the Minimum Managed Account Upgrade Block Timestamp Delay and Maximum Managed Account Upgrade Block Timestamp Delay limits.
- The admin can skim any tokens mistakenly sent to a MAPC.

### FixedIncomeVaultProvider v1

- Only whitelisted [BACs](#bridge-adapter-contracts) are authorized to add new managed accounts.
- The manager wallet sets the vault configuration fields on creation and can update the fields subject to a governance delay.
  - Updating any of the vault configuration fields is a two-step process.
    - The manager wallet first calls `initiateManagedAccountUpgrade` with the new values, which initiates the Managed Account Upgrade Block Timestamp Delay.
    - Once the Managed Account Upgrade Block Timestamp Delay expires, the manager wallet can make a second call to `finalizeManagedAccountUpgrade` to complete and apply the change.
    - At any time during the Managed Account Upgrade Block Timestamp Delay, the manager wallet can cancel the change immediately with `cancelManagedAccountUpgrade`.
  - Vault configuration fields are subject to validation as captured in the Fixed Parameter Settings.
- The admin can change the address of the withdrawal dispatcher wallet with no delay. The withdrawal dispatcher wallet is distinct from the Exchange dispatcher wallet and is authorized to call `withdrawByQuantity` for non-local withdrawal requests and `emitEventsForFrontOfDepositAndWithdrawalQueues`.
  - `withdrawByQuantity` is open to public calls for local withdrawal requests.
- Only the Exchange contract is authorized to call: `deposit`, `applyPendingDeposit`, `cancelPendingWithdrawal`, `applyPendingWithdrawal`, `liquidateManagerWallet`.
- Manager wallets can enable or disable deposits for their managed accounts with no delay.
- Only the manager wallet and depositor wallets with nonzero balances can initiate an exit with `exitWallet`.

### Fixed Parameter Settings

These settings have been pre-determined and may be hard-coded or implicit in the contract logic.

- Owner Change Period: immediate
- Admin Change Period: immediate
- Minimum Managed Account Upgrade Block Timestamp Delay: 0
- Maximum Managed Account Upgrade Block Timestamp Delay: 4 weeks
- Vault Configuration Field Validation
  - Minimum Interest Multiplier: 0%
  - Maximum Interest Multiplier: 1000%
  - Minimum Maximum Net Deposits: $100
  - Maximum Maximum Net Deposits: $2^63 - 1
  - Minimum Maximum Total Owed Quantity Available Multiplier To Initiate Exit: 50%
  - Maximum Maximum Total Owed Quantity Available Multiplier To Initiate Exit: 200%
  - Minimum Minimum Total Owed Quantity Available Multiplier To Allow Manager Wallet Withdrawal: 50%
  - Maximum Minimum Total Owed Quantity Available Multiplier To Allow Manager Wallet Withdrawal: 999.999999%
  - Minimum Minimum Unapplied Withdrawal Age In S To Initiate Exit: 1 hour
  - Maximum Minimum Unapplied Withdrawal Age In S To Initiate Exit: 28 days
  - Minimum Withdrawal Limit Percent For Depositors: 10%
  - Maximum Withdrawal Limit Percent For Depositors: 100%
  - Minimum Withdrawal Limit Percent For Vault: 0%
  - Maximum Withdrawal Limit Percent For Vault: 100%
