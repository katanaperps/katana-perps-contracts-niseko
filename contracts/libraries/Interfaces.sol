// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import {
  Balance,
  IndexPrice,
  Market,
  OverridableMarketFields,
  WalletExit,
  WithdrawalFromManagedAccount,
  WithdrawalFromManagedAccountByQuantity,
  WithdrawalFromManagedAccountByShares
} from "./Structs.sol";

/*
 * @notice Interface to Asset Migrator contract used by Custodian to migrate funds from one ERC-20 contract to another
 */
interface IAssetMigrator {
  /**
   * @notice Migrate an asset quantity to a new address
   *
   * @param sourceAsset The address of the old asset that will be migrated from
   * @param quantityInAssetUnits The quantity of token to transfer in asset units
   */
  function migrate(address sourceAsset, uint256 quantityInAssetUnits) external;

  /**
   * @notice Load the address of the destination asset that will be migrated to
   *
   * @return destinationAsset The address of the new asset that will migrated to
   */
  function destinationAsset() external returns (address);
}

/**
 * @notice Interface to Bridge Adapter contracts used by Exchange for routing withdrawals
 */
interface IBridgeAdapter {
  /**
   * @notice Withdraw quote asset quantity to destination wallet using bridge-specific payload
   */
  function withdrawQuoteAsset(address destinationWallet, uint256 quantity, bytes memory payload) external;
}

/**
 * @notice Interface to Custodian contract. Used by Exchange and Governance contracts for internal
 * calls
 */
interface ICustodian {
  /**
   * @notice Migrate the entire balance of an asset to a new address using the currently whitelisted Asset Migrator
   *
   * @param sourceAsset The address of the asset the Custodian currently holds a balance in
   *
   * @return destinationAsset The address of the new asset that will migrated to
   */
  function migrateAsset(address sourceAsset) external returns (address destinationAsset);

  /**
   * @notice Withdraw any asset and amount to a target wallet
   *
   * @dev No balance checking performed
   *
   * @param wallet The wallet to which assets will be returned
   * @param asset The address of the asset to withdraw (ERC-20 contract)
   * @param quantityInAssetUnits The quantity in asset units to withdraw
   */
  function withdraw(address wallet, address asset, uint256 quantityInAssetUnits) external;

  /**
   * @notice Load address of the currently whitelisted Exchange contract
   *
   * @return The address of the currently whitelisted Exchange contract
   */
  function exchange() external view returns (address);

  /**
   * @notice Sets a new Asset Migrator contract address
   *
   * @param newAssetMigrator The address of the new whitelisted Asset Migrator contract or zero address to disable migration
   */
  function setAssetMigrator(address newAssetMigrator) external;

  /**
   * @notice Sets a new Exchange contract address
   *
   * @param newExchange The address of the new whitelisted Exchange contract
   */
  function setExchange(address newExchange) external;

  /**
   * @notice Load address of the currently whitelisted Asset Migrator contract
   *
   * @return The address of the currently whitelisted Asset Migrator contract
   */
  function assetMigrator() external view returns (address);

  /**
   * @notice Load address of the currently whitelisted Governance contract
   *
   * @return The address of the currently whitelisted Governance contract
   */
  function governance() external view returns (address);

  /**
   * @notice Sets a new Governance contract address
   *
   * @param newGovernance The address of the new whitelisted Governance contract
   */
  function setGovernance(address newGovernance) external;
}

/**
 * @notice Interface to Exchange contract
 */
interface IExchange {
  /**
   * @dev Returns the EIP-712 domain separator for the current chain
   */
  function domainSeparatorV4() external view returns (bytes32);

  /**
   * @notice Load a wallet's balance by asset symbol, in pips
   *
   * @param wallet The wallet address to load the balance for. Can be different from `msg.sender`
   * @param assetSymbol The asset symbol to load the wallet's balance for
   *
   * @return balance The quantity denominated in pips of asset at `assetSymbol` currently in an open position or
   * quote balance by `wallet` if base or quote respectively. Result may be negative
   */
  function loadBalanceBySymbol(address wallet, string calldata assetSymbol) external view returns (int64);

  /**
   * @notice Load a wallet's balance-tracking struct by asset symbol
   *
   * @param wallet The wallet address to load the balance for. Can be different from `msg.sender`
   * @param assetSymbol The asset symbol to load the wallet's balance for
   *
   * @return The internal `Balance` struct tracking the asset at `assetSymbol` currently in an open position for or
   * deposited by `wallet`
   */
  function loadBalanceStructBySymbol(
    address wallet,
    string calldata assetSymbol
  ) external view returns (Balance memory);

  /**
   * @notice Loads a list of all currently open positions for a wallet
   *
   * @param wallet The wallet address to load open positions for for. Can be different from `msg.sender`
   *
   * @return A list of base asset symbols corresponding to markets in which the wallet currently has an open position
   */
  function loadBaseAssetSymbolsWithOpenPositionsByWallet(address wallet) external view returns (string[] memory);

  /**
   * @notice Loads the total count of all Bridge Adapters currently whitelisted
   *
   * @return The total count of all Bridge Adapters currently whitelisted
   *
   */
  function loadBridgeAdaptersLength() external view returns (uint256);

  /**
   * @notice Loads the Bridge Adapter at the given index
   *
   * @param index The index at which to load
   *
   * @return The Bridge Adapter at the given index
   */
  function loadBridgeAdapter(uint8 index) external view returns (IBridgeAdapter);

  /**
   * @notice Loads the total count of all Index Price Adapters currently whitelisted
   *
   * @return The total count of all Index Price Adapters currently whitelisted
   *
   */
  function loadIndexPriceAdaptersLength() external view returns (uint256);

  /**
   * @notice Loads the Index Price Adapter at the given index
   *
   * @param index The index at which to load
   *
   * @return The Index Price Adapter at the given index
   */
  function loadIndexPriceAdapter(uint8 index) external view returns (IIndexPriceAdapter);

  /**
   * @notice Loads the total count of all Managed Account Providers currently whitelisted
   *
   * @return The total count of all Managed Account Providers currently whitelisted
   *
   */
  function loadManagedAccountProvidersLength() external view returns (uint256);

  /**
   * @notice Loads the Managed Account Provider at the given index
   *
   * @param index The index at which to load
   *
   * @return The Managed Account Provider at the given index
   */
  function loadManagedAccountProvider(uint8 index) external view returns (IManagedAccountProvider);

  /**
   * @notice Loads the total count of all markets added
   *
   * @return The total count of all markets added
   *
   */
  function loadMarketsLength() external view returns (uint256);

  /**
   * @notice Loads the Market at the given index by addition order
   *
   * @param index The index at which to load
   *
   * @return The Market at the given index by addition order
   */
  function loadMarket(uint8 index) external view returns (Market memory);

  /**
   * @notice Load the balance of quote asset the wallet can withdraw after exiting, in pips. Note that due to changing
   * prices the value returned is only an estimate and may not exactly match the value actually transferred after exit
   *
   * @param wallet The wallet address to load the exit quote balance for. Can be different from `msg.sender`
   *
   * @return balance The quantity denominated in pips of quote asset that can be withdrawn after exiting the wallet.
   * Result may be zero, in which case an exit withdrawal would not transfer out any quote but would still close all
   * positions and quote balance. The available quote for exit withdrawal can validly be negative for the EF wallet, in
   * which case this function will return 0 since no withdrawal is possible. For all other wallets, the exit quote
   * calculations are designed such that the result quantity to withdraw is never negative; however the return type is
   * still signed to provide visibility into unforeseen bugs or rounding errors
   */
  function loadQuoteQuantityAvailableForExitWithdrawal(address wallet) external view returns (int64);

  /**
   * @notice Calculate total account value for a wallet by summing its quote asset balance and each open position's
   * notional values as computed by latest published index price. Result may be negative. Since index prices are
   * published lazily, the result may be out of date for a market with little activity
   *
   * @param wallet The wallet address to calculate total account value for
   */
  function loadTotalAccountValueFromIndexPrices(address wallet) external view returns (int64);

  /*
   * @notice Loads the exit status for a wallet
   *
   * @param wallet The wallet to load exit status for
   *
   * @return The WalletExit struct corresponding to the wallet
   */
  function loadWalletExitStatus(address wallet) external view returns (WalletExit memory);

  /**
   * @notice Load the address of the Custodian contract
   *
   * @return The address of the Custodian contract
   */
  function custodian() external view returns (ICustodian);

  /**
   * @notice Load the number of deposits made to the contract, for use when upgrading to a new Exchange via Governance
   *
   * @return The number of deposits successfully made to the Exchange
   */
  function depositIndex() external view returns (uint64);

  /**
   * @notice Load the address of the currently whitelisted Dispatcher wallet
   *
   * @return The address of the Dispatcher wallet
   */
  function dispatcherWallet() external view returns (address);

  /**
   * @notice Load the address of the Exit Fund Wallet
   *
   * @return The address of the Exit Fund Wallet
   */
  function exitFundWallet() external view returns (address);

  /**
   * @notice Load the address of the Fee Wallet
   *
   * @return The address of the Fee Wallet
   */
  function feeWallet() external view returns (address);

  /**
   * @notice Load the address of the current Insurance Fund wallet
   *
   * @return The address of the Insurance Fund wallet
   */
  function insuranceFundWallet() external view returns (address);

  /**
   * @notice Load the address of the Oracle Price Adapter
   *
   * @return The address of the Oracle Price Adapter
   */
  function oraclePriceAdapter() external view returns (IOraclePriceAdapter);

  /**
   * @notice Load the address of the quote token address
   *
   * @return The address of the quote token ERC-20 contract
   */
  function quoteTokenAddress() external view returns (address);

  /**
   * @notice Associate a manager wallet with a Managed Account Provider contract. The sender must be a whitelisted Managed
   * Account and will be used as the contract to associate the wallet with
   *
   * @param managerWallet The wallet which will be associated with the Managed Account
   */
  function associateManagerWalletWithManagedAccount(address managerWallet) external;

  /**
   * @notice Deposit quote token
   *
   * @param quantityInAssetUnits The quantity to deposit. The sending wallet must first call the `approve` method on
   * the token contract for at least this quantity
   * @param depositorWallet The wallet which will be credited for the new balance. Defaults to sending wallet if zero
   */
  function deposit(uint256 quantityInAssetUnits, address depositorWallet) external;

  /**
   * @notice Deposit quote token to managed account
   *
   * @param quantityInAssetUnits The quantity to deposit. The sending wallet must first call the `approve` method on
   * the token contract for at least this quantity
   * @param depositorWallet The wallet which will be credited for the new shares resulting from the deposit
   * @param managedAccountProvider Address of ManagedAccount contract
   * @param managedAccountProviderPayload ABI-encoded parameters to supply specific Managed Account Provider contract
   * @param managerWallet Address of wallet associated with Managed Account that will be credited for the new balance
   */
  function depositToManagedAccount(
    uint256 quantityInAssetUnits,
    address depositorWallet,
    IManagedAccountProvider managedAccountProvider,
    bytes memory managedAccountProviderPayload,
    address managerWallet
  ) external;

  /**
   * @notice Flags a wallet as exited, immediately disabling deposits upon mining. After the Chain Propagation Period
   * passes trades and withdrawals are also disabled for the wallet, and quote asset may then be withdrawn via
   * `withdrawExit`
   *
   * @param wallet The wallet to exit. If the wallet is associated with a Managed Account, then the sender must be the
   * Managed Account Provider contract. Otherwise, the sender must be the same as the wallet to be flagged as exited
   */
  function exitWallet(address wallet) external;

  /**
   * @notice Sets bridge adapter contract addresses whitelisted for withdrawals
   *
   * @param newBridgeAdapters An array of bridge adapter contract addresses
   */
  function setBridgeAdapters(IBridgeAdapter[] memory newBridgeAdapters) external;

  /**
   * @notice Sets Index Price Adapter contract addresses
   *
   * @param newIndexPriceAdapters An array of contract addresses
   */
  function setIndexPriceAdapters(IIndexPriceAdapter[] memory newIndexPriceAdapters) external;

  /**
   * @notice Sets IF wallet address
   *
   * @param newInsuranceFundWallet The new IF wallet address
   */
  function setInsuranceFundWallet(address newInsuranceFundWallet) external;

  /**
   * @notice Sets whitelisted Managed Account Provider contract addresses
   *
   * @param newManagedAccountProviders An array of Managed Account Provider contract addresses
   */
  function setManagedAccountProviders(IManagedAccountProvider[] memory newManagedAccountProviders) external;

  /**
   * @notice Set overridable market parameters for a specific wallet or as new market defaults
   *
   * @param baseAssetSymbol The base asset symbol for the market
   * @param overridableFields New values for overridable fields
   * @param wallet The wallet to apply overrides to. If zero, overrides apply to entire market
   */
  function setMarketOverrides(
    string memory baseAssetSymbol,
    OverridableMarketFields memory overridableFields,
    address wallet
  ) external;

  /**
   * @notice Sets Oracle Price Adapter contract address
   *
   * @param newOraclePriceAdapter The new contract addresses
   */
  function setOraclePriceAdapter(IOraclePriceAdapter newOraclePriceAdapter) external;

  /**
   * @notice Withdraw quote token from an exited Managed Account wallet
   *
   * @param depositorWallet The depositor wallet which will receive the withdrawn quantity
   * @param managerWallet Address of wallet associated with Managed Account that will be withdrawn from
   * @param quantity The quantity to withdraw
   */
  function withdrawExitFromManagedAccount(address depositorWallet, address managerWallet, uint64 quantity) external;
}

/**
 * @notice Interface to Index Price Adapter
 */
interface IIndexPriceAdapter {
  /**
   * @notice Validate encoded payload and return `IndexPrice` struct
   */
  function validateIndexPricePayload(bytes calldata payload) external returns (IndexPrice memory);

  /**
   * @notice Sets adapter as active, indicating that it is now whitelisted by the Exchange
   */
  function setActive(IExchange exchange) external;
}

/**
 * @notice Interface to Managed Account Provider contract
 */
interface IManagedAccountProvider {
  // Events //

  event AddManagedAccountsDisabledAdmin();

  event AddManagedAccountsEnabledAdmin();

  event DepositsDisabledAdmin(bool isDepositEnabled, bool isApplyDepositEnabled);

  event DepositsEnabledAdmin();

  event DepositsDisabled(address indexed managerWallet);

  event DepositsEnabled(address indexed managerWallet);

  event DepositToManagedAccountReadyToApply(
    uint64 depositIndex,
    uint64 quantity,
    address sourceWallet,
    address depositorWallet,
    address managerWallet
  );

  /**
   * @notice Emitted when a manager wallet creates a new Managed Account via `addManagedAccount`
   */
  event ManagedAccountAdded(address managerWallet);
  /**
   * @notice Emitted when a manager wallet initiates upgrade of Managed Account configuration via
   * `initiateManagedAccountUpgrade`
   */
  event ManagedAccountUpgradeInitiated(address indexed managerWallet, uint256 blockTimestampThreshold);
  /**
   * @notice Emitted when a manager wallet cancels a previously initiated Managed Account
   * configuration upgrade via `cancelManagedAccountUpgrade`
   */
  event ManagedAccountUpgradeCanceled(address indexed managerWallet);
  /**
   * @notice Emitted when a manager wallet finalizes a Managed Account upgrade via `finalizeManagedAccountUpgrade`
   */
  event ManagedAccountUpgradeFinalized(address indexed managerWallet);
  /**
   * @notice Emitted when a vault manager wallet is liquidated  with `liquidateManagerWallet`
   */
  event ManagerWalletLiquidated(address managerWallet);
  /**
   * @notice Emitted when an enqueued withdrawal becomes ready to apply. May be emitted more than
   * once for the same withdrawal
   */
  event WithdrawalFromManagedAccountReadyToApply(
    WithdrawalFromManagedAccount withdrawal,
    uint64 totalShareSupply,
    uint256 numberOfWithdrawalsInQueue
  );

  error AddManagedAccountDisabled();

  error DepositDisabled(address managerWallet);

  error ApplyDepositDisabled(address managerWallet);

  // Admin controls //

  /**
   * @notice Enables or disables Managed Account creation across the provider
   *
   * @param isAddManagedAccountEnabled Enables Managed Account creation if true, disables if false
   */
  function setAddManagedAccountEnabledAdmin(bool isAddManagedAccountEnabled) external;

  /**
   * @notice Enables or disables Managed Account depositing across the provider
   *
   * @param isDepositEnabled Enables the `deposit` function if true, disables if false
   * @param isDepositEnabled Enables the `applyPendingDeposit` function if true, disables if false
   */
  function setDepositEnabledAdmin(bool isDepositEnabled, bool isApplyDepositEnabled) external;

  // MA creation //

  /**
   * @notice Create a new Managed Account including an initial deposit
   *
   * @param managerWallet The manager wallet for the new Managed Account
   * @param payload ABI-encoded provider-specific parameters for new Managed Account
   */
  function addManagedAccount(address managerWallet, bytes calldata payload) external;

  /**
   * @notice Returns true if function `addManagedAccount` is enabled for the provider, false if
   * function is disabled
   */
  function isAddManagedAccountEnabled() external view returns (bool);

  // MA upgrades //

  /**
   * @notice Initiate an upgrade of an existing Managed Account. Caller must be the manager wallet
   * associated with the Managed Account
   */
  function initiateManagedAccountUpgrade(bytes calldata payload) external;

  /**
   * @notice Cancel an in-flight upgrade of a Managed Account. Caller must be the manager wallet
   * associated with the Managed Account
   */
  function cancelManagedAccountUpgrade() external;

  /**
   * @notice Finalize an in-flight upgrade of a Managed Account. Caller must be the manager wallet
   * associated with the Managed Account
   */
  function finalizeManagedAccountUpgrade() external;

  // Interval ticks //

  /**
   * @notice Execute logic on Managed Accounts on regularly timed interval ticks
   */
  function intervalTick(bytes calldata payload) external;

  // Deposits //

  /**
   * @notice Enqueues a deposit. Called by Exchange contract via `depositToManagedAccount`
   */
  function deposit(
    uint64 depositIndex,
    uint64 quantity,
    address sourceWallet,
    address depositingWallet,
    address managerWallet,
    bytes calldata payload
  ) external;

  /**
   * @notice Apply the deposit that is currently at the front of the queue. Called by Exchange
   * contract via `applyPendingDepositToManagedAccount`
   */
  function applyPendingDeposit(uint64 depositIndex, address managerWallet, uint64 quantityInAssetUnits) external;

  /**
   * @notice Enables or disables depositing assets into a Managed Account. Caller must be the
   * manager wallet associated with the Managed Account
   *
   * @param isEnabled Enables deposit if true, disables if false
   */
  function setDepositEnabled(bool isEnabled) external;

  /**
   * @notice Returns true if function `deposit` is enabled for the Managed Account, false if
   * function is disabled
   */
  function isDepositEnabled(address managerWallet) external view returns (bool);

  /**
   * @notice Returns true if function `applyPendingDeposit` is enabled for the Managed Account,
   * false if function is disabled
   */
  function isApplyDepositEnabled(address managerWallet) external view returns (bool);

  // Withdrawals //

  /**
   * @notice Enqueues a user withdrawal specified in exact quote quantity
   *
   * @param withdrawal A `WithdrawalFromManagedAccountByQuantity` struct encoding the parameters
   * of the withdrawal
   */
  function withdrawByQuantity(WithdrawalFromManagedAccountByQuantity calldata withdrawal) external;

  /**
   * @notice Enqueues a user withdrawal specified in exact number of shares
   *
   * @param withdrawal A `WithdrawalFromManagedAccountByShares` struct encoding the parameters
   * of the withdrawal
   */
  function withdrawByShares(WithdrawalFromManagedAccountByShares calldata withdrawal) external;

  /**
   * @notice Cancel the withdrawal that is currently at the front of the queue
   */
  function cancelPendingWithdrawal(uint64 gasFee, address managerWallet, bytes32 withdrawalHash) external;

  /**
   * @notice Apply the withdrawal that is currently at the front of the queue and transfer the
   * corresponding amount of quote asset out of the contract
   */
  function applyPendingWithdrawal(
    uint64 gasFee,
    uint64 grossQuantity,
    address managerWallet,
    bytes32 withdrawalHash
  ) external;

  // Liquidation //

  /**
   * @notice Flag the manager wallet as liquidated by the Exchange contract and refund any pending
   * deposits
   */
  function liquidateManagerWallet(address managerWallet) external;

  // Exits //

  /**
   * @notice Flags the manager wallet as exited, immediately disabling deposits upon mining. After
   * the Chain Propagation Period passes trades and withdrawals are also disabled for the wallet,
   * and quote asset may then be withdrawn via `withdrawExit`
   */
  function exitWallet(address managerWallet) external;

  /**
   * @notice Close all open positions and withdraw the owed quote balance for an exited wallet. The
   * Chain Propagation Period must have already passed since calling `exitWallet`
   */
  function withdrawExit(address managerWallet, address depositorWallet) external;
}

/**
 * @notice Interface to Oracle Price Adapter
 */
interface IOraclePriceAdapter {
  /**
   * @notice Return latest price for base asset symbol in quote asset terms. Reverts if no price is available
   */
  function loadPriceForBaseAssetSymbol(string memory baseAssetSymbol) external view returns (uint64 price);

  /**
   * @notice Sets adapter as active, indicating that it is now whitelisted by the Exchange
   */
  function setActive(IExchange exchange) external;
}
