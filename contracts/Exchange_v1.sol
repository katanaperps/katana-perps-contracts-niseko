// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import { Address } from "./libraries/Address.sol";
import { BalanceLoading } from "./libraries/BalanceLoading.sol";
import { BalanceTracking } from "./libraries/BalanceTracking.sol";
import { ClosureDeleveraging } from "./libraries/ClosureDeleveraging.sol";
import { Constants } from "./libraries/Constants.sol";
import { Depositing } from "./libraries/Depositing.sol";
import { ExchangeErrors } from "./libraries/ExchangeErrors.sol";
import { ExchangeEvents } from "./libraries/ExchangeEvents.sol";
import { ExitFund } from "./libraries/ExitFund.sol";
import { Funding } from "./libraries/Funding.sol";
import { IndexPriceMargin } from "./libraries/IndexPriceMargin.sol";
import { ManagedAccounts } from "./libraries/ManagedAccounts.sol";
import { MarketAdmin } from "./libraries/MarketAdmin.sol";
import { NonceInvalidations } from "./libraries/NonceInvalidations.sol";
import { OraclePriceMargin } from "./libraries/OraclePriceMargin.sol";
import { Owned } from "./Owned.sol";
import { PositionBelowMinimumLiquidation } from "./libraries/PositionBelowMinimumLiquidation.sol";
import { PositionInDeactivatedMarketLiquidation } from "./libraries/PositionInDeactivatedMarketLiquidation.sol";
import { Trading } from "./libraries/Trading.sol";
import { Transferring } from "./libraries/Transferring.sol";
import { WalletExitAcquisitionDeleveraging } from "./libraries/WalletExitAcquisitionDeleveraging.sol";
import { WalletExitLiquidation } from "./libraries/WalletExitLiquidation.sol";
import { WalletInMaintenanceAcquisitionDeleveraging } from "./libraries/WalletInMaintenanceAcquisitionDeleveraging.sol";
import { WalletInMaintenanceLiquidation } from "./libraries/WalletInMaintenanceLiquidation.sol";
import { Withdrawing } from "./libraries/Withdrawing.sol";
import {
  AcquisitionDeleverageArguments,
  Balance,
  ClosureDeleverageArguments,
  FundingMultiplierQuartet,
  IndexPricePayload,
  Market,
  MarketOverrides,
  NonceInvalidation,
  Order,
  Trade,
  OverridableMarketFields,
  PositionBelowMinimumLiquidationArguments,
  PositionInDeactivatedMarketLiquidationArguments,
  Transfer,
  WalletExit,
  WalletLiquidationArguments,
  Withdrawal,
  WithdrawalFromManagedAccount
} from "./libraries/Structs.sol";
import { DeleverageType, LiquidationType } from "./libraries/Enums.sol";
import {
  IBridgeAdapter,
  ICustodian,
  IExchange,
  IIndexPriceAdapter,
  IManagedAccountProvider,
  IOraclePriceAdapter
} from "./libraries/Interfaces.sol";

// solhint-disable-next-line contract-name-capwords
contract Exchange_v1 is EIP712, ExchangeErrors, ExchangeEvents, IExchange, Owned {
  using NonceInvalidations for mapping(address => NonceInvalidation[]);

  // State variables //

  // Balance tracking
  BalanceTracking.Storage private _balanceTracking;
  // Mapping of wallet => list of base asset symbols with open positions
  mapping(address => string[]) private _baseAssetSymbolsWithOpenPositionsByWallet;
  // Mapping of order wallet hash => isComplete
  mapping(bytes32 => bool) private _completedOrderHashes;
  // Transfers - mapping of transfer wallet hash => isComplete
  mapping(bytes32 => bool) private _completedTransferHashes;
  // Withdrawals - mapping of withdrawal wallet hash => isComplete
  mapping(bytes32 => bool) private _completedWithdrawalHashes;
  // Withdrawals - mapping of MA withdrawal wallet hash => isComplete
  mapping(bytes32 => bool) private _completedWithdrawalFromManagedAccountHashes;
  // List of whitelisted cross-chain Bridge Adapter contracts
  IBridgeAdapter[] private _bridgeAdapters;
  // Fund custody contract
  ICustodian public custodian;
  // Deposit index
  uint64 public depositIndex;
  // Zero only if Exit Fund has no open positions or quote balance
  uint256 public exitFundPositionOpenedAtBlockTimestamp;
  // List of whitelisted Index Price Adapter contracts
  IIndexPriceAdapter[] private _indexPriceAdapters;
  // Must be true or `deposit` will revert
  bool public isDepositEnabled;
  // If positive (index increases) longs pay shorts; if negative (index decreases) shorts pay longs
  mapping(string => FundingMultiplierQuartet[]) public fundingMultipliersByBaseAssetSymbol;
  // Milliseconds since epoch, always aligned to funding period
  mapping(string => uint64) public lastFundingRatePublishTimestampInMsByBaseAssetSymbol;
  // List of whitelisted Managed Account Provider contracts
  IManagedAccountProvider[] private _managedAccountProviders;
  // Wallet-specific market parameter overrides
  mapping(string => mapping(address => MarketOverrides)) public marketOverridesByBaseAssetSymbolAndWallet;
  // A list of base asset symbols for all markets in addition order
  string[] private _marketBaseAssetSymbols;
  // Mapping of base asset symbol => market struct
  mapping(string => Market) private _marketsByBaseAssetSymbol;
  // Mapping of wallet => last invalidated timestamp in milliseconds
  mapping(address => NonceInvalidation[]) private _nonceInvalidationsByWallet;
  // Currently whitelisted Oracle Price Adapter, used for on-chain exits
  IOraclePriceAdapter public oraclePriceAdapter;
  // Mapping of order hash => filled quantity in pips
  mapping(bytes32 => uint64) private _partiallyFilledOrderQuantities;
  // Mapping of wallet address to total pending deposit quantity
  mapping(address => uint64) public pendingDepositQuantityByWallet;
  // Address of ERC-20 contract used as collateral and quote for all markets
  address public quoteTokenAddress;
  // Exits
  mapping(address => WalletExit) private _walletExits;

  // State variables - tunable parameters //

  uint256 public chainPropagationPeriodInS;
  uint64 public delegateKeyExpirationPeriodInMs;
  // Slippage tolerance to account for rounding errors when validating liquidation prices for very small position sizes
  uint64 public positionBelowMinimumLiquidationPriceToleranceMultiplier;

  // State variables - changeable wallets //

  address public dispatcherWallet;
  address public exitFundWallet;
  address public feeWallet;
  address public insuranceFundWallet;

  // Modifiers //

  modifier onlyAdminOrDispatcher() {
    if (msg.sender != adminWallet && msg.sender != dispatcherWallet) {
      revert SenderMustBeAdminOrDispatcher();
    }
    _;
  }

  modifier onlyDispatcher() {
    _onlyDispatcher();
    _;
  }

  modifier onlyDispatcherWhenExitFundHasNoPositions() {
    _onlyDispatcher();
    if (_baseAssetSymbolsWithOpenPositionsByWallet[exitFundWallet].length > 0) {
      revert ExitFundCannotHaveOpenPosition();
    }
    _;
  }

  modifier onlyWhenExitFundHasOpenPositions() {
    _onlyWhenExitFundHasOpenPositions();
    _;
  }

  modifier onlyDispatcherWhenExitFundHasOpenPositions() {
    _onlyDispatcher();
    _onlyWhenExitFundHasOpenPositions();
    _;
  }

  modifier onlyGovernance() {
    if (msg.sender != custodian.governance()) {
      revert SenderMustBeGovernance();
    }
    _;
  }

  // Functions //

  /**
   * @notice Instantiate a new `Exchange` contract
   *
   * @param balanceMigrationSource Previous Exchange contract to migrate wallet balances from. Not used if zero
   * @param exitFundWallet_ Address of EF wallet
   * @param feeWallet_ Address of Fee wallet
   * @param indexPriceAdapters Addresses of Index Price Adapter contracts whitelisted to validate index price payloads
   * @param insuranceFundWallet_ Address of IF wallet
   * @param oraclePriceAdapter_ Addresses of Oracle Price Adapter contract used for on-chain exit pricing
   * @param quoteTokenAddress_ Address of quote asset ERC20 contract
   *
   * @dev Sets `owner_` and `admin_` to `msg.sender`
   */
  constructor(
    IExchange balanceMigrationSource,
    address exitFundWallet_,
    address feeWallet_,
    IIndexPriceAdapter[] memory indexPriceAdapters,
    address insuranceFundWallet_,
    IOraclePriceAdapter oraclePriceAdapter_,
    address quoteTokenAddress_
  ) EIP712(Constants.EIP_712_DOMAIN_NAME, Constants.EIP_712_DOMAIN_VERSION) Owned() {
    require(
      address(balanceMigrationSource) == address(0x0) || Address.isContract(address(balanceMigrationSource)),
      "Invalid migration source"
    );
    _balanceTracking.migrationSource = IExchange(balanceMigrationSource);

    require(Address.isContract(address(quoteTokenAddress_)), "Invalid quote asset address");
    quoteTokenAddress = quoteTokenAddress_;

    setExitFundWallet(exitFundWallet_);

    setFeeWallet(feeWallet_);

    require(insuranceFundWallet_ != address(0x0), "Invalid IF wallet");
    insuranceFundWallet = insuranceFundWallet_;

    for (uint8 i = 0; i < indexPriceAdapters.length; i++) {
      require(Address.isContract(address(indexPriceAdapters[i])), "Invalid Index Price Adapter address");
    }
    _indexPriceAdapters = indexPriceAdapters;

    require(Address.isContract(address(oraclePriceAdapter_)), "Invalid Oracle Price Adapter address");
    oraclePriceAdapter = oraclePriceAdapter_;

    // Deposits must be manually enabled via `setDepositIndex` and `setDepositEnabled`
    depositIndex = Constants.DEPOSIT_INDEX_NOT_SET;
  }

  // Tunable parameters //

  /**
   * @notice Sets a new Chain Propagation Period - the block timestamp delay after which order nonce invalidations are
   * respected by `executeTrade` and wallet exits are respected by `executeTrade` and `withdraw`
   *
   * @param newChainPropagationPeriodInS The new Chain Propagation Period expressed in seconds. Must be less than
   * `Constants.MAX_CHAIN_PROPAGATION_PERIOD_IN_S`
   */
  function setChainPropagationPeriod(uint256 newChainPropagationPeriodInS) public onlyAdmin {
    if (newChainPropagationPeriodInS > Constants.MAX_CHAIN_PROPAGATION_PERIOD_IN_S) {
      revert NewValueExceedsMaximum();
    }

    uint256 oldChainPropagationPeriodInS = chainPropagationPeriodInS;
    chainPropagationPeriodInS = newChainPropagationPeriodInS;

    emit ChainPropagationPeriodChanged(oldChainPropagationPeriodInS, newChainPropagationPeriodInS);
  }

  /**
   * @notice Sets a new Delegated Key Expiration Period - the delay following a delegated key's nonce timestamp after
   * which it cannot be used to sign orders
   *
   * @param newDelegateKeyExpirationPeriodInMs The new Delegated Key Expiration Period expressed as milliseconds. Must
   * be less than `Constants.MAX_DELEGATE_KEY_EXPIRATION_PERIOD_IN_MS`
   */
  function setDelegatedKeyExpirationPeriod(uint64 newDelegateKeyExpirationPeriodInMs) public onlyAdmin {
    if (newDelegateKeyExpirationPeriodInMs > Constants.MAX_DELEGATE_KEY_EXPIRATION_PERIOD_IN_MS) {
      revert NewValueExceedsMaximum();
    }

    uint64 oldDelegateKeyExpirationPeriodInMs = delegateKeyExpirationPeriodInMs;
    delegateKeyExpirationPeriodInMs = newDelegateKeyExpirationPeriodInMs;

    emit DelegateKeyExpirationPeriodChanged(oldDelegateKeyExpirationPeriodInMs, newDelegateKeyExpirationPeriodInMs);
  }

  /**
   * @notice Sets a new position below minimum liquidation price tolerance multiplier
   *
   * @param newPositionBelowMinimumLiquidationPriceToleranceMultiplier The new position below minimum liquidation price
   * tolerance multiplier. Must be less than `Constants.MAX_FEE_MULTIPLIER`
   */
  function setPositionBelowMinimumLiquidationPriceToleranceMultiplier(
    uint64 newPositionBelowMinimumLiquidationPriceToleranceMultiplier
  ) public onlyAdmin {
    if (newPositionBelowMinimumLiquidationPriceToleranceMultiplier > Constants.MAX_FEE_MULTIPLIER) {
      revert NewValueExceedsMaximum();
    }

    uint64 oldPositionBelowMinimumLiquidationPriceToleranceMultiplier = positionBelowMinimumLiquidationPriceToleranceMultiplier;
    positionBelowMinimumLiquidationPriceToleranceMultiplier = newPositionBelowMinimumLiquidationPriceToleranceMultiplier;

    emit PositionBelowMinimumLiquidationPriceToleranceMultiplierChanged(
      oldPositionBelowMinimumLiquidationPriceToleranceMultiplier,
      newPositionBelowMinimumLiquidationPriceToleranceMultiplier
    );
  }

  /**
   * @notice Sets the address of the `Custodian` contract
   *
   * @dev The `Custodian` accepts `Exchange` and `Governance` addresses in its constructor, after which they can only be
   * changed by the `Governance` contract itself. Therefore the `Custodian` must be deployed last and its address set
   * here on an existing `Exchange` contract. This value is immutable once set and cannot be changed again
   *
   * @param newCustodian The address of the `Custodian` contract deployed against this `Exchange` contract's address
   */
  function setCustodian(ICustodian newCustodian) public onlyAdmin {
    if (custodian != ICustodian(payable(address(0x0)))) {
      revert ValueCanOnlyBetSetOnce();
    }
    if (!Address.isContract(address(newCustodian))) {
      revert InvalidContractAddress();
    }
    custodian = newCustodian;
  }

  /**
   * @notice Enable depositing assets into the Exchange by setting the current deposit index from
   * the old Exchange contract's value. This function can only be called once
   */
  function setDepositIndex() public onlyAdmin {
    if (depositIndex != Constants.DEPOSIT_INDEX_NOT_SET) {
      revert ValueCanOnlyBetSetOnce();
    }

    depositIndex = address(_balanceTracking.migrationSource) == address(0x0)
      ? 0
      : _balanceTracking.migrationSource.depositIndex();
  }

  /**
   * @notice Enables or disables depositing assets into the Exchange
   *
   * @param isEnabled Enables deposit if true, disables if false
   */
  function setDepositEnabled(bool isEnabled) public onlyAdmin {
    if (isEnabled) {
      if (isDepositEnabled) {
        revert NewValueMustBeDifferentFromCurrent();
      }
      emit DepositsEnabled();
    } else {
      if (!isDepositEnabled) {
        revert NewValueMustBeDifferentFromCurrent();
      }
      emit DepositsDisabled();
    }

    isDepositEnabled = isEnabled;
  }

  /**
   * @notice Sets the address of the Exit Fund wallet
   *
   * @dev The current Exit Fund wallet cannot have any open balances
   *
   * @param newExitFundWallet The new Exit Fund wallet. Must be different from the current one
   */
  function setExitFundWallet(address newExitFundWallet) public onlyAdmin {
    ExitFund.validateExitFundWallet_delegatecall(
      exitFundWallet,
      newExitFundWallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet
    );

    exitFundWallet = newExitFundWallet;
  }

  /**
   * @notice Sets the address of the Fee wallet
   *
   * @dev Trade and Withdraw fees will accrue in the `_balanceTracking` quote mapping for this wallet
   *
   * @param newFeeWallet The new Fee wallet. Must be different from the current one
   */
  function setFeeWallet(address newFeeWallet) public onlyAdmin {
    if (newFeeWallet == address(0x0)) {
      revert InvalidWalletAddress();
    }
    if (newFeeWallet == feeWallet) {
      revert NewValueMustBeDifferentFromCurrent();
    }

    address oldFeeWallet = feeWallet;
    feeWallet = newFeeWallet;

    emit FeeWalletChanged(oldFeeWallet, newFeeWallet);
  }

  /**
   * @notice Sets Bridge Adapter contract addresses whitelisted for withdrawals
   *
   * @param newBridgeAdapters An array of Bridge Adapter contract addresses
   */
  function setBridgeAdapters(IBridgeAdapter[] calldata newBridgeAdapters) public onlyGovernance {
    _bridgeAdapters = newBridgeAdapters;
  }

  /**
   * @notice Sets Index Price Adapter contract addresses
   *
   * @param newIndexPriceAdapters An array of contract addresses
   */
  function setIndexPriceAdapters(IIndexPriceAdapter[] calldata newIndexPriceAdapters) public onlyGovernance {
    _indexPriceAdapters = newIndexPriceAdapters;
  }

  /**
   * @notice Sets IF wallet address
   *
   * @param newInsuranceFundWallet The new IF wallet address
   */
  function setInsuranceFundWallet(address newInsuranceFundWallet) public onlyGovernance {
    if (_walletExits[newInsuranceFundWallet].exists) {
      revert NewInsuranceFundWalletCannotBeExited();
    }
    insuranceFundWallet = newInsuranceFundWallet;
  }

  /**
   * @notice Sets Managed Account Provider contract addresses
   *
   * @param newManagedAccountProviders The new contract addresses
   */
  function setManagedAccountProviders(
    IManagedAccountProvider[] calldata newManagedAccountProviders
  ) public onlyGovernance {
    _managedAccountProviders = newManagedAccountProviders;
  }

  /**
   * @notice Sets Oracle Price Adapter contract address used for on-chain exit pricing
   *
   * @param newOraclePriceAdapter The new contract addresses
   */
  function setOraclePriceAdapter(IOraclePriceAdapter newOraclePriceAdapter) public onlyGovernance {
    oraclePriceAdapter = newOraclePriceAdapter;
  }

  /**
   * @notice Migrates all quote asset funds held by Custodian to new token contract and sets new `quoteTokenAddress`
   */
  function migrateQuoteTokenAddress() public onlyAdmin {
    address oldQuoteTokenAddress = quoteTokenAddress;

    address newQuoteTokenAddress = custodian.migrateAsset(quoteTokenAddress);
    quoteTokenAddress = newQuoteTokenAddress;

    emit QuoteTokenAddressChanged(oldQuoteTokenAddress, newQuoteTokenAddress);
  }

  /**
   * @dev Returns the EIP-712 domain separator for the current chain
   */
  function domainSeparatorV4() public view returns (bytes32) {
    return _domainSeparatorV4();
  }

  /**
   * @notice Load a wallet's balance by asset symbol, in pips
   *
   * @param wallet The wallet address to load the balance for. Can be different from `msg.sender`
   * @param assetSymbol The asset symbol to load the wallet's balance for
   *
   * @return balance The quantity denominated in pips of asset at `assetSymbol` currently in an open position or
   * quote balance by `wallet` if base or quote respectively. Result may be negative
   */
  function loadBalanceBySymbol(address wallet, string memory assetSymbol) public view override returns (int64) {
    return
      BalanceLoading.loadBalanceBySymbol_delegatecall(
        wallet,
        assetSymbol,
        _balanceTracking,
        _baseAssetSymbolsWithOpenPositionsByWallet,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        _marketsByBaseAssetSymbol,
        pendingDepositQuantityByWallet
      );
  }

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
    string memory assetSymbol
  ) public view override returns (Balance memory) {
    return BalanceLoading.loadBalanceStructBySymbol_delegatecall(wallet, assetSymbol, _balanceTracking);
  }

  /**
   * @notice Loads a list of all currently open positions for a wallet
   *
   * @param wallet The wallet address to load open positions for for. Can be different from `msg.sender`
   *
   * @return A list of base asset symbols corresponding to markets in which the wallet currently has an open position
   */
  function loadBaseAssetSymbolsWithOpenPositionsByWallet(
    address wallet
  ) public view override returns (string[] memory) {
    return _baseAssetSymbolsWithOpenPositionsByWallet[wallet];
  }

  /**
   * @notice Loads the total count of all Bridge Adapters currently whitelisted
   *
   * @return The total count of all Bridge Adapters currently whitelisted
   *
   */
  function loadBridgeAdaptersLength() public view returns (uint256) {
    return _bridgeAdapters.length;
  }

  /**
   * @notice Loads the Bridge Adapter at the given index
   *
   * @param index The index at which to load
   *
   * @return The Bridge Adapter at the given index
   */
  function loadBridgeAdapter(uint8 index) public view returns (IBridgeAdapter) {
    return _bridgeAdapters[index];
  }

  /**
   * @notice Loads the total count of all Index Price Adapters currently whitelisted
   *
   * @return The total count of all Index Price Adapters currently whitelisted
   *
   */
  function loadIndexPriceAdaptersLength() public view returns (uint256) {
    return _indexPriceAdapters.length;
  }

  /**
   * @notice Loads the Index Price Adapter at the given index
   *
   * @param index The index at which to load
   *
   * @return The Index Price Adapter at the given index
   */
  function loadIndexPriceAdapter(uint8 index) public view returns (IIndexPriceAdapter) {
    return _indexPriceAdapters[index];
  }

  /**
   * @notice Loads the total count of all Managed Account Providers currently whitelisted
   *
   * @return The total count of all Managed Account Providers currently whitelisted
   *
   */
  function loadManagedAccountProvidersLength() public view returns (uint256) {
    return _managedAccountProviders.length;
  }

  /**
   * @notice Loads the Managed Account Provider at the given index
   *
   * @param index The index at which to load
   *
   * @return The Managed Account Provider at the given index
   */
  function loadManagedAccountProvider(uint8 index) public view returns (IManagedAccountProvider) {
    return _managedAccountProviders[index];
  }

  /**
   * @notice Loads the total count of all markets added
   *
   * @return The total count of all markets added
   *
   */
  function loadMarketsLength() public view returns (uint256) {
    return _marketBaseAssetSymbols.length;
  }

  /**
   * @notice Loads the Market at the given index by addition order
   *
   * @param index The index at which to load
   *
   * @return The Market at the given index by addition order
   */
  function loadMarket(uint8 index) public view returns (Market memory) {
    return _marketsByBaseAssetSymbol[_marketBaseAssetSymbols[index]];
  }

  /**
   * @notice Loads the last nonce invalidation created by a wallet
   *
   * @param wallet The wallet address
   *
   * @return nonceInvalidation The most recent nonce invalidation struct created by the wallet with `invalidateNonce`. Struct will be
   * empty if wallet has never invalidated a nonce
   */
  function loadLastNonceInvalidationForWallet(
    address wallet
  ) public view returns (NonceInvalidation memory nonceInvalidation) {
    if (_nonceInvalidationsByWallet[wallet].length > 0) {
      nonceInvalidation = _nonceInvalidationsByWallet[wallet][_nonceInvalidationsByWallet[wallet].length - 1];
    }
  }

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
  function loadQuoteQuantityAvailableForExitWithdrawal(address wallet) public view returns (int64) {
    return
      OraclePriceMargin.loadQuoteQuantityAvailableForExitWithdrawalIncludingOutstandingWalletFunding_delegatecall(
        exitFundWallet,
        oraclePriceAdapter,
        wallet,
        _balanceTracking,
        _baseAssetSymbolsWithOpenPositionsByWallet,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        marketOverridesByBaseAssetSymbolAndWallet,
        _marketsByBaseAssetSymbol,
        pendingDepositQuantityByWallet
      );
  }

  /*
   * @notice Loads the exit status for a wallet
   *
   * @param wallet The wallet to load exit status for
   *
   * @return The WalletExit struct corresponding to the wallet
   */
  function loadWalletExitStatus(address wallet) external view returns (WalletExit memory) {
    return _walletExits[wallet];
  }

  // Dispatcher whitelisting //

  /**
   * @notice Sets the wallet whitelisted to dispatch transactions calling the `executeTrade` and `withdraw`
   * functions
   *
   * @param newDispatcherWallet The new whitelisted dispatcher wallet. Must be different from the current one
   */
  function setDispatcher(address newDispatcherWallet) public onlyAdmin {
    if (newDispatcherWallet == address(0x0)) {
      revert InvalidWalletAddress();
    }
    if (newDispatcherWallet == dispatcherWallet) {
      revert NewValueMustBeDifferentFromCurrent();
    }

    emit DispatcherChanged(dispatcherWallet, newDispatcherWallet);

    dispatcherWallet = newDispatcherWallet;
  }

  /**
   * @notice Clears the currently set whitelisted dispatcher wallet, effectively disabling calling any functions
   * restricted by the `onlyDispatcherWhenExitFundHasNoPositions` modifier until a new wallet is set with `setDispatcher`
   */
  function removeDispatcher() public onlyAdmin {
    emit DispatcherChanged(dispatcherWallet, address(0x0));

    dispatcherWallet = address(0x0);
  }

  // Depositing //

  /**
   * @notice Deposit quote token
   *
   * @param quantityInAssetUnits The quantity to deposit. The sending wallet must first call the `approve` method on
   * the token contract for at least this quantity
   * @param depositorWallet The wallet which will be credited for the new balance. Defaults to sending wallet if zero
   */
  function deposit(uint256 quantityInAssetUnits, address depositorWallet) public {
    address depositorWallet_ = depositorWallet == address(0x0) ? msg.sender : depositorWallet;

    Depositing.deposit_delegatecall(
      depositorWallet_,
      msg.sender,
      quantityInAssetUnits,
      custodian,
      depositIndex,
      exitFundWallet,
      isDepositEnabled,
      quoteTokenAddress,
      _balanceTracking,
      pendingDepositQuantityByWallet,
      _walletExits
    );

    depositIndex++;
  }

  /**
   * @notice Apply pending deposits
   *
   * @param quantity The quantity to apply. Must be less than or equal to the total amount pending for the wallet
   * @param wallet The wallet for which to apply pending deposits
   */
  function applyPendingDepositsForWallet(uint64 quantity, address wallet) public onlyAdminOrDispatcher {
    Depositing.applyPendingDepositsForWallet_delegatecall(
      quantity,
      wallet,
      _balanceTracking,
      pendingDepositQuantityByWallet
    );
  }

  // Trades //

  /**
   * @notice Settles a trade between two orders submitted and matched off-chain
   *
   * @param trade Trade execution parameters
   * @param buy Buy order
   * @param sell Sell order
   */
  function executeTrade(
    Trade memory trade,
    Order memory buy,
    Order memory sell
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    Trading.executeTrade_delegatecall(
      trade,
      buy,
      sell,
      delegateKeyExpirationPeriodInMs,
      _domainSeparatorV4(),
      exitFundWallet,
      feeWallet,
      insuranceFundWallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      _completedOrderHashes,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      _nonceInvalidationsByWallet,
      _partiallyFilledOrderQuantities,
      _walletExits
    );
  }

  // Liquidation //

  /**
   * @notice Liquidates a single position below the market's configured `minimumPositionSize` to the Insurance Fund
   * at the current index price
   */
  function liquidatePositionBelowMinimum(
    PositionBelowMinimumLiquidationArguments memory liquidationArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    PositionBelowMinimumLiquidation.liquidate_delegatecall(
      liquidationArguments,
      exitFundWallet,
      insuranceFundWallet,
      positionBelowMinimumLiquidationPriceToleranceMultiplier,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Liquidates a single position in a deactivated market at the previously set index price
   */
  function liquidatePositionInDeactivatedMarket(
    PositionInDeactivatedMarketLiquidationArguments memory liquidationArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    PositionInDeactivatedMarketLiquidation.liquidate_delegatecall(
      liquidationArguments,
      feeWallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Liquidates all positions held by a wallet below maintenance requirements to the Insurance Fund at each
   * position's bankruptcy price
   */
  function liquidateWalletInMaintenance(
    WalletLiquidationArguments memory liquidationArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    WalletInMaintenanceLiquidation.liquidate_delegatecall(
      liquidationArguments,
      exitFundPositionOpenedAtBlockTimestamp, // Will always be 0 per modifier
      exitFundWallet,
      insuranceFundWallet,
      LiquidationType.WalletInMaintenance,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      pendingDepositQuantityByWallet
    );
  }

  /**
   * @notice Liquidates all positions held by a wallet below maintenance requirements to the Exit Fund at each
   * position's bankruptcy price
   */
  function liquidateWalletInMaintenanceDuringSystemRecovery(
    WalletLiquidationArguments memory liquidationArguments
  ) public onlyDispatcherWhenExitFundHasOpenPositions {
    exitFundPositionOpenedAtBlockTimestamp = WalletInMaintenanceLiquidation.liquidate_delegatecall(
      liquidationArguments,
      exitFundPositionOpenedAtBlockTimestamp,
      exitFundWallet,
      insuranceFundWallet,
      LiquidationType.WalletInMaintenanceDuringSystemRecovery,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      pendingDepositQuantityByWallet
    );
  }

  /**
   * @notice Liquidates all positions of an exited wallet to the Insurance Fund at each position's exit price
   */
  function liquidateWalletExit(
    WalletLiquidationArguments memory liquidationArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    if (!_walletExits[liquidationArguments.liquidatingWallet].exists) {
      revert WalletMustBeExited();
    }

    WalletExitLiquidation.liquidate_delegatecall(
      liquidationArguments,
      exitFundWallet,
      insuranceFundWallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  // Automatic Deleveraging (ADL) //

  /**
   * @notice Reduces a single position held by a wallet below maintenance requirements by deleveraging a counterparty
   * position at the bankruptcy price of the liquidating wallet
   */
  function deleverageInMaintenanceAcquisition(
    AcquisitionDeleverageArguments memory deleverageArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    WalletInMaintenanceAcquisitionDeleveraging.deleverage_delegatecall(
      deleverageArguments,
      exitFundWallet,
      insuranceFundWallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      pendingDepositQuantityByWallet
    );
  }

  /**
   * @notice Reduces a single position held by the Insurance Fund by deleveraging a counterparty position at the entry
   * price of the Insurance Fund
   */
  function deleverageInsuranceFundClosure(
    ClosureDeleverageArguments memory deleverageArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    ClosureDeleveraging.deleverage_delegatecall(
      deleverageArguments,
      DeleverageType.InsuranceFundClosure,
      exitFundPositionOpenedAtBlockTimestamp, // Will always be 0 per modifier
      exitFundWallet,
      insuranceFundWallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Reduces a single position held by an exited wallet by deleveraging a counterparty position at the exit
   * price of the liquidating wallet
   */
  function deleverageExitAcquisition(
    AcquisitionDeleverageArguments memory deleverageArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    if (!_walletExits[deleverageArguments.liquidatingWallet].exists) {
      revert WalletMustBeExited();
    }

    WalletExitAcquisitionDeleveraging.deleverage_delegatecall(
      deleverageArguments,
      exitFundWallet,
      insuranceFundWallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      _walletExits
    );
  }

  /**
   * @notice Reduces a single position held by the Exit Fund by deleveraging a counterparty position at the index
   * price or the Exit Fund's bankruptcy price if the Exit Fund account value is positive or negative, respectively
   */
  function deleverageExitFundClosure(
    ClosureDeleverageArguments memory deleverageArguments
  ) public onlyDispatcherWhenExitFundHasOpenPositions {
    exitFundPositionOpenedAtBlockTimestamp = ClosureDeleveraging.deleverage_delegatecall(
      deleverageArguments,
      DeleverageType.ExitFundClosure,
      exitFundPositionOpenedAtBlockTimestamp,
      exitFundWallet,
      insuranceFundWallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  // Transfers //

  function transfer(Transfer memory transfer_) public onlyDispatcherWhenExitFundHasNoPositions {
    Transferring.transfer_delegatecall(
      transfer_,
      _domainSeparatorV4(),
      exitFundWallet,
      insuranceFundWallet,
      feeWallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      _completedTransferHashes,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      _walletExits
    );
  }

  // Withdrawing //

  /**
   * @notice Settles a user withdrawal submitted off-chain. Calls restricted to currently
   * whitelisted Dispatcher wallet
   *
   * @param withdrawal A `Withdrawal` struct encoding the parameters of the withdrawal
   */
  function withdraw(Withdrawal memory withdrawal) public onlyDispatcherWhenExitFundHasNoPositions {
    Withdrawing.withdraw_delegatecall(
      withdrawal,
      _domainSeparatorV4(),
      custodian,
      exitFundPositionOpenedAtBlockTimestamp,
      exitFundWallet,
      feeWallet,
      quoteTokenAddress,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      _completedWithdrawalHashes,
      _bridgeAdapters,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      _walletExits
    );
  }

  // Market management //

  /**
   * @notice Create a new market that will initially be deactivated. Funding multipliers will be backfilled with zero
   * values for the current day UTC. Note this may block publishing new funding multipliers for up to half the funding
   * period interval following market creation
   */
  function addMarket(Market memory newMarket) public onlyAdmin {
    MarketAdmin.addMarket_delegatecall(
      newMarket,
      oraclePriceAdapter,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      _marketBaseAssetSymbols,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Activate a market, which allows positions to be opened and funding payments made
   */
  function activateMarket(string memory baseAssetSymbol) public onlyDispatcherWhenExitFundHasNoPositions {
    MarketAdmin.activateMarket_delegatecall(baseAssetSymbol, _marketsByBaseAssetSymbol);
  }

  /**
   * @notice Deactivate a market
   */
  function deactivateMarket(string memory baseAssetSymbol) public onlyDispatcherWhenExitFundHasNoPositions {
    MarketAdmin.deactivateMarket_delegatecall(baseAssetSymbol, _marketsByBaseAssetSymbol);
  }

  /**
   * @notice Publish updated index prices for markets
   *
   * @dev Access must be `onlyDispatcher` rather than `onlyDispatcherWhenExitFundHasNoPositions` to facilitate EF
   * closure deleveraging during system recovery
   */
  function publishIndexPrices(IndexPricePayload[] calldata encodedIndexPrices) public onlyDispatcher {
    MarketAdmin.publishIndexPrices_delegatecall(encodedIndexPrices, _indexPriceAdapters, _marketsByBaseAssetSymbol);
  }

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
  ) public onlyGovernance {
    if (!_marketsByBaseAssetSymbol[baseAssetSymbol].exists) {
      revert UnknownBaseAssetSymbol();
    }

    if (wallet == address(0x0)) {
      _marketsByBaseAssetSymbol[baseAssetSymbol].overridableFields = overridableFields;
    } else {
      marketOverridesByBaseAssetSymbolAndWallet[baseAssetSymbol][wallet] = MarketOverrides({
        exists: true,
        overridableFields: overridableFields
      });
    }
  }

  /**
   * @notice Unset overridable market parameters for a specific wallet
   *
   * @param baseAssetSymbol The base asset symbol for the market
   * @param wallet The wallet to unset overrides for
   */
  function unsetMarketOverridesForWallet(string memory baseAssetSymbol, address wallet) public onlyAdminOrDispatcher {
    if (!_marketsByBaseAssetSymbol[baseAssetSymbol].exists) {
      revert UnknownBaseAssetSymbol();
    }
    if (wallet == address(0x0)) {
      revert InvalidWalletAddress();
    }
    if (!marketOverridesByBaseAssetSymbolAndWallet[baseAssetSymbol][wallet].exists) {
      revert WalletHasNoOverridesForMarket();
    }

    delete marketOverridesByBaseAssetSymbolAndWallet[baseAssetSymbol][wallet];

    emit MarketOverridesUnset(baseAssetSymbol, wallet);
  }

  /**
   * @notice Sends tokens mistakenly sent directly to the `Exchange` to the fee wallet (the absence of a `receive`
   * function rejects incoming native asset transfers)
   */
  function skim(address tokenAddress) public onlyAdmin {
    Withdrawing.skim_delegatecall(tokenAddress, feeWallet);
  }

  // Perps //

  /**
   * @notice Pushes fundingRate × indexPrice to fundingMultipliersByBaseAssetSymbol mapping for market. Uses timestamp
   * component of index price to determine if funding rate is too recent after previously publish funding rate, and to
   * backfill empty values if a funding period was missed
   */
  function publishFundingMultiplier(
    string memory baseAssetSymbol,
    int64 fundingRate
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    Funding.publishFundingMultiplier_delegatecall(
      baseAssetSymbol,
      fundingRate,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Updates quote balance with historical funding payments for a market by walking funding multipliers
   * published since last position update up to max allowable by gas constraints
   */
  function applyOutstandingWalletFundingForMarket(address wallet, string memory baseAssetSymbol) public {
    Funding.applyOutstandingWalletFundingForMarket_delegatecall(
      baseAssetSymbol,
      wallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Calculate total outstanding funding payments
   */
  function loadOutstandingWalletFunding(address wallet) public view returns (int64) {
    return
      Funding.loadOutstandingWalletFunding_delegatecall(
        wallet,
        _balanceTracking,
        _baseAssetSymbolsWithOpenPositionsByWallet,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        _marketsByBaseAssetSymbol
      );
  }

  /**
   * @notice Calculate total account value for a wallet by summing its quote asset balance and each open position's
   * notional values as computed by latest published index price. Result may be negative. Since index prices are
   * published lazily, the result may be out of date for a market with little activity
   *
   * @param wallet The wallet address to calculate total account value for
   */
  function loadTotalAccountValueFromIndexPrices(address wallet) public view returns (int64) {
    return
      IndexPriceMargin.loadTotalAccountValueIncludingOutstandingWalletFunding_delegatecall(
        wallet,
        _balanceTracking,
        _baseAssetSymbolsWithOpenPositionsByWallet,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        _marketsByBaseAssetSymbol,
        pendingDepositQuantityByWallet
      );
  }

  /**
   * @notice Calculate total account value for a wallet by summing its quote asset balance and each open position's
   * notional values as computed by on-chain feed price. Result may be negative
   *
   * @param wallet The wallet address to calculate total account value for
   */
  function loadTotalAccountValueFromOraclePrices(address wallet) public view returns (int64) {
    return
      OraclePriceMargin.loadTotalAccountValueIncludingOutstandingWalletFunding_delegatecall(
        oraclePriceAdapter,
        wallet,
        _balanceTracking,
        _baseAssetSymbolsWithOpenPositionsByWallet,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        _marketsByBaseAssetSymbol,
        pendingDepositQuantityByWallet
      );
  }

  /**
   * @notice Calculate total initial margin requirement for a wallet by summing each open position's initial margin
   * requirement as computed by latest published index price. Since index prices are published lazily, the result may be
   * out of date for a market with little activity
   *
   * @param wallet The wallet address to calculate total initial margin requirement for
   */
  function loadTotalInitialMarginRequirementFromIndexPrices(address wallet) public view returns (uint64) {
    return
      IndexPriceMargin.loadTotalInitialMarginRequirement_delegatecall(
        wallet,
        _balanceTracking,
        _baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        _marketsByBaseAssetSymbol
      );
  }

  /**
   * @notice Calculate total initial margin requirement for a wallet by summing each open position's initial margin
   * requirement as computed by on-chain feed price
   *
   * @param wallet The wallet address to calculate total initial margin requirement for
   */
  function loadTotalInitialMarginRequirementFromOraclePrices(address wallet) public view returns (uint64) {
    return
      OraclePriceMargin.loadTotalInitialMarginRequirement_delegatecall(
        oraclePriceAdapter,
        wallet,
        _balanceTracking,
        _baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        _marketsByBaseAssetSymbol
      );
  }

  /**
   * @notice Calculate total maintenence margin requirement for a wallet by summing each open position's maintanence
   * margin requirement as computed by latest published index price. Since index prices are published lazily, the result
   * may be out of date for a market with little activity
   *
   * @param wallet The wallet address to calculate total maintanence margin requirement for
   */
  function loadTotalMaintenanceMarginRequirementFromIndexPrices(address wallet) public view returns (uint64) {
    return
      IndexPriceMargin.loadTotalMaintenanceMarginRequirement_delegatecall(
        wallet,
        _balanceTracking,
        _baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        _marketsByBaseAssetSymbol
      );
  }

  /**
   * @notice Calculate total maintenence margin requirement for a wallet by summing each open position's maintanence
   * margin requirement as computed by on-chain feed price
   *
   * @param wallet The wallet address to calculate total maintanence margin requirement for
   */
  function loadTotalMaintenanceMarginRequirementFromOraclePrices(address wallet) public view returns (uint64) {
    return
      OraclePriceMargin.loadTotalMaintenanceMarginRequirement_delegatecall(
        oraclePriceAdapter,
        wallet,
        _balanceTracking,
        _baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        _marketsByBaseAssetSymbol
      );
  }

  // Wallet exits //

  /**
   * @notice Flags a wallet as exited, immediately disabling deposits upon mining. After the Chain Propagation Period
   * passes trades and withdrawals are also disabled for the wallet, and quote asset may then be withdrawn via
   * `withdrawExit`
   *
   * @param wallet The wallet to exit. If the wallet is associated with a Managed Account, then the sender must be the
   * Managed Account Provider contract. Otherwise, the sender must be the same as the wallet to be flagged as exited
   */
  function exitWallet(address wallet) public {
    Withdrawing.exitWallet_delegatecall(
      chainPropagationPeriodInS,
      exitFundWallet,
      insuranceFundWallet,
      wallet,
      _balanceTracking,
      _walletExits
    );
  }

  /**
   * @notice Close all open positions and withdraw the net quote balance for an exited wallet. The Chain Propagation
   * Period must have already passed since calling `exitWallet`
   *
   * @param wallet Address of exited wallet
   */
  function withdrawExit(address wallet) public {
    uint256 exitFundPositionOpenedAtBlockTimestamp_ = Withdrawing.withdrawExit_delegatecall(
      wallet,
      custodian,
      exitFundWallet,
      oraclePriceAdapter,
      quoteTokenAddress,
      exitFundPositionOpenedAtBlockTimestamp,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      pendingDepositQuantityByWallet,
      _walletExits
    );

    exitFundPositionOpenedAtBlockTimestamp = exitFundPositionOpenedAtBlockTimestamp_;
  }

  /**
   * @notice Close all open positions and withdraw the net quote balance for an exited wallet during system recovery,
   * regardless of Chain Propagation Period elapsing
   *
   * @param wallet Address of exited wallet
   */
  function withdrawExitAdmin(address wallet) public onlyAdminOrDispatcher onlyWhenExitFundHasOpenPositions {
    uint256 exitFundPositionOpenedAtBlockTimestamp_ = Withdrawing.withdrawExitAdmin_delegatecall(
      wallet,
      custodian,
      exitFundWallet,
      oraclePriceAdapter,
      quoteTokenAddress,
      exitFundPositionOpenedAtBlockTimestamp,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      pendingDepositQuantityByWallet,
      _walletExits
    );
    exitFundPositionOpenedAtBlockTimestamp = exitFundPositionOpenedAtBlockTimestamp_;
  }

  /**
   * @notice Clears exited status of sending wallet. Upon mining immediately enables deposits, trades, and withdrawals
   * by sending wallet
   */
  function clearWalletExit() public {
    Withdrawing.clearWalletExit_delegatecall(
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      _walletExits
    );
  }

  // Invalidation //

  /**
   * @notice Invalidate all order nonces with a timestampInMs lower than the one provided
   *
   * @param nonce A Version 1 UUID. After calling and once the Chain Propagation Period has elapsed,
   * `executeTrade` will reject order nonces from this wallet with a timestampInMs component lower than the one
   * provided
   */
  function invalidateNonce(uint128 nonce) public {
    (uint64 timestampInMs, uint256 effectiveBlockTimestamp) = _nonceInvalidationsByWallet.invalidateNonce_delegatecall(
      nonce,
      chainPropagationPeriodInS
    );

    emit OrderNonceInvalidated(msg.sender, nonce, timestampInMs, effectiveBlockTimestamp);
  }

  function _onlyDispatcher() private view {
    if (msg.sender != dispatcherWallet) {
      revert SenderMustBeDispatcher();
    }
  }

  function _onlyWhenExitFundHasOpenPositions() private view {
    if (_baseAssetSymbolsWithOpenPositionsByWallet[exitFundWallet].length == 0) {
      revert ExitFundHasNoPositions();
    }
  }

  // Managed Accounts //

  /**
   * @notice Associate a wallet with a Managed Account Provider contract. The sender must be a
   * whitelisted Managed Account Provider and will be used as the contract to associate the wallet
   * with
   *
   * @param managerWallet The wallet which will be associated with the Managed Account
   */
  function associateManagerWalletWithManagedAccount(address managerWallet) public {
    ManagedAccounts.associateManagerWalletWithManagedAccount_delegatecall(
      managerWallet,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      _managedAccountProviders,
      pendingDepositQuantityByWallet,
      _walletExits
    );
  }

  /**
   * @notice Deposit quote token to Managed Account
   *
   * @param quantityInAssetUnits The quantity to deposit. The sending wallet must first call the `approve` method on
   * the token contract for at least this quantity
   * @param depositorWallet The wallet which will be credited for the deposit
   * @param managedAccountProvider Address of Managed Account Provider contract
   * @param managedAccountProviderPayload ABI-encoded parameters to supply specific Managed Account Provider contract
   * @param managerWallet Address of wallet associated with Managed Account Provider that will be credited for the new
   * balance
   */
  function depositToManagedAccount(
    uint256 quantityInAssetUnits,
    address depositorWallet,
    IManagedAccountProvider managedAccountProvider,
    bytes calldata managedAccountProviderPayload,
    address managerWallet
  ) public {
    ManagedAccounts.depositToManagedAccount_delegatecall(
      quantityInAssetUnits,
      depositorWallet,
      managedAccountProvider,
      managedAccountProviderPayload,
      managerWallet,
      msg.sender,
      _bridgeAdapters,
      custodian,
      depositIndex,
      exitFundWallet,
      isDepositEnabled,
      quoteTokenAddress,
      _balanceTracking,
      _managedAccountProviders,
      pendingDepositQuantityByWallet,
      _walletExits
    );

    depositIndex++;
  }

  /**
   * @notice Apply a pending deposit to a manager wallet associated with a Managed Account
   *
   * @param depositIndex_ The unique index identifying the deposit
   * @param quantity The quantity to apply. Must be less than or equal to the total amount pending for the wallet
   * @param managerWallet The manager wallet for which to apply the pending deposit
   */
  function applyPendingDepositToManagedAccount(
    uint64 depositIndex_,
    uint64 quantity,
    address managerWallet
  ) public onlyDispatcher {
    ManagedAccounts.applyPendingDepositToManagedAccount_delegatecall(
      depositIndex_,
      quantity,
      managerWallet,
      _balanceTracking,
      pendingDepositQuantityByWallet,
      _walletExits
    );
  }

  /**
   * @notice Settles a user withdrawal submitted to a Managed Account provider. Calls restricted to
   * currently whitelisted Dispatcher wallet
   *
   * @param withdrawal A `WithdrawalFromManagedAccount` struct encoding the parameters of the withdrawal
   */
  function applyPendingWithdrawalFromManagedAccount(
    WithdrawalFromManagedAccount memory withdrawal
  ) public onlyDispatcher {
    ManagedAccounts.applyPendingWithdrawalFromManagedAccount_delegatecall(
      // External arguments
      withdrawal,
      // Exchange state values
      _domainSeparatorV4(),
      // Exchange state storage refs
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      _completedWithdrawalFromManagedAccountHashes,
      _bridgeAdapters,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      _managedAccountProviders,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      _walletExits
    );
  }

  /**
   * @notice Cancels a user withdrawal submitted to a Managed Account provider. Calls restricted to
   * currently whitelisted Dispatcher wallet
   *
   * @param withdrawal A `WithdrawalFromManagedAccount` struct encoding the parameters of the withdrawal
   */
  function cancelPendingWithdrawalFromManagedAccount(
    WithdrawalFromManagedAccount memory withdrawal
  ) public onlyDispatcher {
    ManagedAccounts.cancelPendingWithdrawalFromManagedAccount_delegatecall(
      // External arguments
      withdrawal,
      // Exchange state values
      _domainSeparatorV4(),
      // Exchange state storage refs
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      _completedWithdrawalFromManagedAccountHashes,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      _managedAccountProviders,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      _walletExits
    );
  }

  /**
   * @notice Withdraw quote token from an exited manager wallet
   *
   * @param depositorWallet The depositor wallet which will receive the withdrawn quantity
   * @param managerWallet The exited manager wallet that will be withdrawn from
   * @param quantity The quantity to withdraw
   */
  function withdrawExitFromManagedAccount(address depositorWallet, address managerWallet, uint64 quantity) public {
    uint256 exitFundPositionOpenedAtBlockTimestamp_ = ManagedAccounts.withdrawExitFromManagedAccount_delegatecall(
      depositorWallet,
      managerWallet,
      quantity,
      exitFundPositionOpenedAtBlockTimestamp,
      _balanceTracking,
      _baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      _managedAccountProviders,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      pendingDepositQuantityByWallet,
      _walletExits
    );

    exitFundPositionOpenedAtBlockTimestamp = exitFundPositionOpenedAtBlockTimestamp_;
  }
}
