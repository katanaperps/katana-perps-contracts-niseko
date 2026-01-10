// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { AssetUnitConversions } from "./AssetUnitConversions.sol";
import { BalanceTracking } from "./BalanceTracking.sol";
import { Constants } from "./Constants.sol";
import { Depositing } from "./Depositing.sol";
import { ExchangeEvents } from "./ExchangeEvents.sol";
import { ExitFund } from "./ExitFund.sol";
import { Funding } from "./Funding.sol";
import { Hashing } from "./Hashing.sol";
import { IndexPriceMargin } from "./IndexPriceMargin.sol";
import { ManagedAccountWithdrawalType } from "./Enums.sol";
import { Math } from "./Math.sol";
import { WalletExits } from "./WalletExits.sol";
import { Withdrawing } from "./Withdrawing.sol";
import {
  Balance,
  FundingMultiplierQuartet,
  Market,
  MarketOverrides,
  WalletExit,
  WithdrawalFromManagedAccount,
  WithdrawalFromManagedAccountByQuantity,
  WithdrawalFromManagedAccountByShares
} from "./Structs.sol";
import { IBridgeAdapter, ICustodian, IExchange, IManagedAccountProvider } from "./Interfaces.sol";

library ManagedAccounts {
  using BalanceTracking for BalanceTracking.Storage;

  // solhint-disable-next-line func-name-mixedcase
  function associateManagerWalletWithManagedAccount_delegatecall(
    // External argument
    address managerWallet,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    IManagedAccountProvider[] memory managedAccountProviders,
    mapping(address => uint64) storage pendingDepositQuantityByWallet,
    mapping(address => WalletExit) storage walletExits
  ) public {
    require(!walletExits[managerWallet].exists, "Wallet exited");
    require(baseAssetSymbolsWithOpenPositionsByWallet[managerWallet].length == 0, "Wallet cannot have open positions");
    require(pendingDepositQuantityByWallet[managerWallet] == 0, "Wallet has pending deposits");

    _validateManagedAccountProviderIsWhitelisted(IManagedAccountProvider(msg.sender), managedAccountProviders);

    Balance storage balanceStruct = balanceTracking.loadBalanceStructAndMigrateIfNeeded(
      managerWallet,
      Constants.QUOTE_ASSET_SYMBOL
    );
    require(balanceStruct.balance == 0, "Wallet cannot have open balance");
    require(
      balanceStruct.managedAccountProvider == IManagedAccountProvider(address(0x0)),
      "Wallet already associated with MA"
    );

    balanceStruct.managedAccountProvider = IManagedAccountProvider(msg.sender);
  }

  // solhint-disable-next-line func-name-mixedcase
  function depositToManagedAccount_delegatecall(
    // External arguments
    uint256 quantityInAssetUnits,
    address depositorWallet,
    IManagedAccountProvider managedAccountProvider,
    bytes memory managedAccountProviderPayload,
    address managerWallet,
    address sourceWallet,
    // Exchange state values
    IBridgeAdapter[] memory bridgeAdapters,
    ICustodian custodian,
    uint64 depositIndex,
    address exitFundWallet,
    bool isDepositEnabled,
    address quoteTokenAddress,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    IManagedAccountProvider[] storage managedAccountProviders,
    mapping(address => uint64) storage pendingDepositQuantityByWallet,
    mapping(address => WalletExit) storage walletExits
  ) public {
    require(managerWallet != address(0x0), "Invalid manager wallet");
    require(depositorWallet != address(0x0), "Invalid depositor wallet");
    require(
      IManagedAccountProvider(msg.sender) == managedAccountProvider ||
        _isBridgeAdapterWhitelisted(IBridgeAdapter(msg.sender), bridgeAdapters),
      "Caller must be MA provider or bridge adapter"
    );
    _validateManagedAccountProviderIsWhitelisted(managedAccountProvider, managedAccountProviders);

    Balance storage balanceStruct = balanceTracking.loadBalanceStructAndMigrateIfNeeded(
      managerWallet,
      Constants.QUOTE_ASSET_SYMBOL
    );
    require(balanceStruct.managedAccountProvider == managedAccountProvider, "Manager wallet not associated with MA");

    balanceStruct = balanceTracking.loadBalanceStructAndMigrateIfNeeded(depositorWallet, Constants.QUOTE_ASSET_SYMBOL);
    if (balanceStruct.managedAccountProvider != IManagedAccountProvider(address(0x0))) {
      require(
        balanceStruct.managedAccountProvider == managedAccountProvider && managerWallet == depositorWallet,
        "Manager wallet can only deposit to its own MA"
      );
    }

    uint64 depositedQuantity = Depositing.deposit(
      custodian,
      depositIndex,
      managerWallet,
      exitFundWallet,
      isDepositEnabled,
      quantityInAssetUnits,
      quoteTokenAddress,
      sourceWallet,
      pendingDepositQuantityByWallet,
      walletExits
    );

    // The Exchange will update the stored deposit index after this function returns
    uint64 newDepositIndex = depositIndex + 1;

    managedAccountProvider.deposit(
      newDepositIndex,
      depositedQuantity,
      sourceWallet,
      depositorWallet,
      managerWallet,
      managedAccountProviderPayload
    );

    emit ExchangeEvents.Deposited(newDepositIndex, sourceWallet, managerWallet, depositedQuantity, true);
  }

  // solhint-disable-next-line func-name-mixedcase
  function applyPendingDepositToManagedAccount_delegatecall(
    uint64 depositIndex,
    uint64 quantity,
    address managerWallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => uint64) storage pendingDepositQuantityByWallet,
    mapping(address => WalletExit) storage walletExits
  ) public {
    require(!WalletExits.isWalletExitFinalized(managerWallet, walletExits), "Manager wallet is exited");

    uint64 pendingDepositQuantity = pendingDepositQuantityByWallet[managerWallet];
    require(quantity <= pendingDepositQuantity, "Quantity to apply exceeds pending");

    pendingDepositQuantityByWallet[managerWallet] = pendingDepositQuantity - quantity;

    // Update balance with argument quantity
    (int64 newExchangeBalance, IManagedAccountProvider managedAccountProvider) = balanceTracking.updateForDeposit(
      managerWallet,
      quantity
    );
    require(address(managedAccountProvider) != address(0x0), "Manager wallet not associated with MA");

    managedAccountProvider.applyPendingDeposit(depositIndex, managerWallet, quantity);

    emit ExchangeEvents.PendingDepositApplied(managerWallet, quantity, newExchangeBalance, true);
  }

  // solhint-disable-next-line func-name-mixedcase
  function applyPendingWithdrawalFromManagedAccount_delegatecall(
    // External arguments
    WithdrawalFromManagedAccount memory withdrawal,
    // Exchange state values
    bytes32 domainSeparator,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(bytes32 => bool) storage completedWithdrawalFromManagedAccountHashes,
    IBridgeAdapter[] storage bridgeAdapters,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    IManagedAccountProvider[] memory managedAccountProviders,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => WalletExit) storage walletExits
  ) public {
    if (withdrawal.withdrawalType == ManagedAccountWithdrawalType.ByQuantity) {
      return
        applyPendingWithdrawalFromManagedAccountByQuantity(
          withdrawal.withdrawalByQuantity,
          domainSeparator,
          balanceTracking,
          baseAssetSymbolsWithOpenPositionsByWallet,
          completedWithdrawalFromManagedAccountHashes,
          bridgeAdapters,
          fundingMultipliersByBaseAssetSymbol,
          lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
          managedAccountProviders,
          marketOverridesByBaseAssetSymbolAndWallet,
          marketsByBaseAssetSymbol,
          walletExits
        );
    }

    // If the withdrawalType value is not included in the enum then abi.decode will revert without a
    // reason string, so we can safely assume the final enum value below

    applyPendingWithdrawalFromManagedAccountByShares(
      withdrawal.withdrawalByShares,
      domainSeparator,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      completedWithdrawalFromManagedAccountHashes,
      bridgeAdapters,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      managedAccountProviders,
      marketOverridesByBaseAssetSymbolAndWallet,
      marketsByBaseAssetSymbol,
      walletExits
    );
  }

  function applyPendingWithdrawalFromManagedAccountByQuantity(
    // External arguments
    WithdrawalFromManagedAccountByQuantity memory withdrawal,
    // Exchange state values
    bytes32 domainSeparator,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(bytes32 => bool) storage completedWithdrawalFromManagedAccountHashes,
    IBridgeAdapter[] storage bridgeAdapters,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    IManagedAccountProvider[] memory managedAccountProviders,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => WalletExit) storage walletExits
  ) private {
    // Validate preconditions
    require(!WalletExits.isWalletExitFinalized(withdrawal.depositorWallet, walletExits), "Depositor wallet is exited");
    require(!WalletExits.isWalletExitFinalized(withdrawal.managerWallet, walletExits), "Manager wallet is exited");
    require(withdrawal.depositorWallet != IExchange(address(this)).exitFundWallet(), "EF cannot withdraw from MA");
    require(
      withdrawal.gasFee <= withdrawal.maximumGasFee && withdrawal.maximumGasFee <= withdrawal.grossQuantity,
      "Excessive withdrawal fee"
    );
    // We do not perform any validation on maxShares here and instead leave it to the specific MA
    // provider contract

    _validateManagedAccountProviderIsWhitelisted(withdrawal.managedAccountProvider, managedAccountProviders);

    bytes32 withdrawalHash = _validateWithdrawalSignature(domainSeparator, withdrawal);
    require(!completedWithdrawalFromManagedAccountHashes[withdrawalHash], "Duplicate withdrawal");

    Funding.applyOutstandingWalletFunding(
      withdrawal.managerWallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketsByBaseAssetSymbol
    );

    // Update wallet balances
    int64 newExchangeBalance = balanceTracking.updateForWithdrawalFromManagedAccountByQuantity(
      withdrawal,
      IExchange(address(this)).feeWallet()
    );

    // Wallet must still maintain initial margin requirement after withdrawal
    IndexPriceMargin.validateInitialMarginRequirement(
      withdrawal.managerWallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      marketOverridesByBaseAssetSymbolAndWallet,
      marketsByBaseAssetSymbol
    );

    _transferWithdrawnQuoteAsset(
      withdrawal.bridgeAdapter,
      IExchange(address(this)).custodian(),
      withdrawal.gasFee,
      withdrawal.grossQuantity,
      withdrawal.managedAccountProvider,
      IExchange(address(this)).quoteTokenAddress(),
      bridgeAdapters
    );
    withdrawal.managedAccountProvider.applyPendingWithdrawal(
      withdrawal.gasFee,
      withdrawal.grossQuantity,
      withdrawal.managerWallet,
      withdrawalHash
    );

    // Replay prevention
    completedWithdrawalFromManagedAccountHashes[withdrawalHash] = true;

    emit ExchangeEvents.Withdrawn(withdrawal.managerWallet, withdrawal.grossQuantity, newExchangeBalance, true);
  }

  function applyPendingWithdrawalFromManagedAccountByShares(
    // External arguments
    WithdrawalFromManagedAccountByShares memory withdrawal,
    // Exchange state values
    bytes32 domainSeparator,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(bytes32 => bool) storage completedWithdrawalFromManagedAccountHashes,
    IBridgeAdapter[] storage bridgeAdapters,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    IManagedAccountProvider[] memory managedAccountProviders,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => WalletExit) storage walletExits
  ) private {
    // Validate preconditions
    require(!WalletExits.isWalletExitFinalized(withdrawal.depositorWallet, walletExits), "Depositor wallet is exited");
    require(!WalletExits.isWalletExitFinalized(withdrawal.managerWallet, walletExits), "Manager wallet is exited");
    require(withdrawal.depositorWallet != IExchange(address(this)).exitFundWallet(), "EF cannot withdraw from MA");
    require(
      withdrawal.gasFee <= withdrawal.maximumGasFee && withdrawal.maximumGasFee <= withdrawal.grossQuantity,
      "Excessive withdrawal fee"
    );
    require(withdrawal.grossQuantity >= withdrawal.minimumQuantity, "Minimum quantity not met");

    _validateManagedAccountProviderIsWhitelisted(withdrawal.managedAccountProvider, managedAccountProviders);

    bytes32 withdrawalHash = _validateWithdrawalSignature(domainSeparator, withdrawal);
    require(!completedWithdrawalFromManagedAccountHashes[withdrawalHash], "Duplicate withdrawal");

    Funding.applyOutstandingWalletFunding(
      withdrawal.managerWallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketsByBaseAssetSymbol
    );

    // Update wallet balances
    int64 newExchangeBalance = balanceTracking.updateForWithdrawalFromManagedAccountByShares(
      withdrawal,
      IExchange(address(this)).feeWallet()
    );

    // Wallet must still maintain initial margin requirement after withdrawal
    IndexPriceMargin.validateInitialMarginRequirement(
      withdrawal.managerWallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      marketOverridesByBaseAssetSymbolAndWallet,
      marketsByBaseAssetSymbol
    );

    _transferWithdrawnQuoteAsset(
      withdrawal.bridgeAdapter,
      IExchange(address(this)).custodian(),
      withdrawal.gasFee,
      withdrawal.grossQuantity,
      withdrawal.managedAccountProvider,
      IExchange(address(this)).quoteTokenAddress(),
      bridgeAdapters
    );
    withdrawal.managedAccountProvider.applyPendingWithdrawal(
      withdrawal.gasFee,
      withdrawal.grossQuantity,
      withdrawal.managerWallet,
      withdrawalHash
    );

    // Replay prevention
    completedWithdrawalFromManagedAccountHashes[withdrawalHash] = true;

    emit ExchangeEvents.Withdrawn(withdrawal.managerWallet, withdrawal.grossQuantity, newExchangeBalance, true);
  }

  // solhint-disable-next-line func-name-mixedcase
  function cancelPendingWithdrawalFromManagedAccount_delegatecall(
    // External arguments
    WithdrawalFromManagedAccount memory withdrawal,
    // Exchange state values
    bytes32 domainSeparator,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(bytes32 => bool) storage completedWithdrawalFromManagedAccountHashes,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    IManagedAccountProvider[] memory managedAccountProviders,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => WalletExit) storage walletExits
  ) public {
    if (withdrawal.withdrawalType == ManagedAccountWithdrawalType.ByQuantity) {
      return
        cancelPendingWithdrawalFromManagedAccountByQuantity(
          withdrawal.withdrawalByQuantity,
          domainSeparator,
          IExchange(address(this)).exitFundWallet(),
          IExchange(address(this)).feeWallet(),
          // Exchange state storage refs
          balanceTracking,
          baseAssetSymbolsWithOpenPositionsByWallet,
          completedWithdrawalFromManagedAccountHashes,
          fundingMultipliersByBaseAssetSymbol,
          lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
          managedAccountProviders,
          marketOverridesByBaseAssetSymbolAndWallet,
          marketsByBaseAssetSymbol,
          walletExits
        );
    }

    // If the withdrawalType value is not included in the enum then abi.decode will revert without
    // a reason string, so we can safely assume the final enum value below
    cancelPendingWithdrawalFromManagedAccountByShares(
      withdrawal.withdrawalByShares,
      domainSeparator,
      IExchange(address(this)).exitFundWallet(),
      IExchange(address(this)).feeWallet(),
      // Exchange state storage refs
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      completedWithdrawalFromManagedAccountHashes,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      managedAccountProviders,
      marketOverridesByBaseAssetSymbolAndWallet,
      marketsByBaseAssetSymbol,
      walletExits
    );
  }

  function cancelPendingWithdrawalFromManagedAccountByQuantity(
    // External arguments
    WithdrawalFromManagedAccountByQuantity memory withdrawal,
    // Exchange state values
    bytes32 domainSeparator,
    address exitFundWallet,
    address feeWallet,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(bytes32 => bool) storage completedWithdrawalFromManagedAccountHashes,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    IManagedAccountProvider[] memory managedAccountProviders,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => WalletExit) storage walletExits
  ) private {
    // Validate preconditions
    require(!WalletExits.isWalletExitFinalized(withdrawal.depositorWallet, walletExits), "Depositor wallet is exited");
    require(!WalletExits.isWalletExitFinalized(withdrawal.managerWallet, walletExits), "Manager wallet is exited");
    require(withdrawal.depositorWallet != exitFundWallet, "EF cannot withdraw from MA");
    require(withdrawal.gasFee <= withdrawal.maximumGasFee, "Excessive withdrawal fee");

    _validateManagedAccountProviderIsWhitelisted(withdrawal.managedAccountProvider, managedAccountProviders);

    bytes32 withdrawalHash = _validateWithdrawalSignature(domainSeparator, withdrawal);
    require(!completedWithdrawalFromManagedAccountHashes[withdrawalHash], "Duplicate withdrawal");

    Funding.applyOutstandingWalletFunding(
      withdrawal.managerWallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketsByBaseAssetSymbol
    );

    // Update wallet balances
    int64 newExchangeBalance = balanceTracking.updateForCancelWithdrawalFromManagedAccountByQuantity(
      withdrawal,
      feeWallet
    );

    // Wallet must still maintain initial margin requirement after paying gas fee
    IndexPriceMargin.validateInitialMarginRequirement(
      withdrawal.managerWallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      marketOverridesByBaseAssetSymbolAndWallet,
      marketsByBaseAssetSymbol
    );

    withdrawal.managedAccountProvider.cancelPendingWithdrawal(
      withdrawal.gasFee,
      withdrawal.managerWallet,
      withdrawalHash
    );

    // Replay prevention
    completedWithdrawalFromManagedAccountHashes[withdrawalHash] = true;

    emit ExchangeEvents.WithdrawalFromManagedAccountCanceled(
      withdrawal.managerWallet,
      withdrawal.grossQuantity,
      newExchangeBalance
    );
  }

  function cancelPendingWithdrawalFromManagedAccountByShares(
    // External arguments
    WithdrawalFromManagedAccountByShares memory withdrawal,
    // Exchange state values
    bytes32 domainSeparator,
    address exitFundWallet,
    address feeWallet,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(bytes32 => bool) storage completedWithdrawalFromManagedAccountHashes,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    IManagedAccountProvider[] memory managedAccountProviders,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => WalletExit) storage walletExits
  ) private {
    // Validate preconditions
    require(!WalletExits.isWalletExitFinalized(withdrawal.depositorWallet, walletExits), "Depositor wallet is exited");
    require(!WalletExits.isWalletExitFinalized(withdrawal.managerWallet, walletExits), "Manager wallet is exited");
    require(withdrawal.depositorWallet != exitFundWallet, "EF cannot withdraw from MA");
    require(withdrawal.gasFee <= withdrawal.maximumGasFee, "Excessive withdrawal fee");
    // The wallet specifies an exact number of shares but the gross quantity is variable based on
    // share price. Since no shares are withdrawn on cancellation, the gross quantity should
    // consist only of the gas fee
    require(withdrawal.grossQuantity == withdrawal.gasFee, "Quantity must equal fee");

    _validateManagedAccountProviderIsWhitelisted(withdrawal.managedAccountProvider, managedAccountProviders);

    bytes32 withdrawalHash = _validateWithdrawalSignature(domainSeparator, withdrawal);
    require(!completedWithdrawalFromManagedAccountHashes[withdrawalHash], "Duplicate withdrawal");

    Funding.applyOutstandingWalletFunding(
      withdrawal.managerWallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketsByBaseAssetSymbol
    );

    // Update wallet balances
    int64 newExchangeBalance = balanceTracking.updateForCancelWithdrawalFromManagedAccountByShares(
      withdrawal,
      feeWallet
    );

    // Wallet must still maintain initial margin requirement after paying gas fee
    IndexPriceMargin.validateInitialMarginRequirement(
      withdrawal.managerWallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      marketOverridesByBaseAssetSymbolAndWallet,
      marketsByBaseAssetSymbol
    );

    withdrawal.managedAccountProvider.cancelPendingWithdrawal(
      withdrawal.gasFee,
      withdrawal.managerWallet,
      withdrawalHash
    );

    // Replay prevention
    completedWithdrawalFromManagedAccountHashes[withdrawalHash] = true;

    emit ExchangeEvents.WithdrawalFromManagedAccountCanceled(
      withdrawal.managerWallet,
      withdrawal.grossQuantity,
      newExchangeBalance
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function withdrawExitFromManagedAccount_delegatecall(
    // External arguments
    address depositorWallet,
    address managerWallet,
    uint64 quantity,
    // Exchange state values
    uint256 exitFundPositionOpenedAtBlockTimestamp,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    IManagedAccountProvider[] storage managedAccountProviders,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => uint64) storage pendingDepositQuantityByWallet,
    mapping(address => WalletExit) storage walletExits
  ) public returns (uint256 exitFundPositionOpenedAtBlockTimestamp_) {
    _validateManagedAccountProviderIsWhitelisted(IManagedAccountProvider(msg.sender), managedAccountProviders);

    Balance storage balanceStruct = balanceTracking.loadBalanceStructAndMigrateIfNeeded(
      managerWallet,
      Constants.QUOTE_ASSET_SYMBOL
    );
    require(
      balanceStruct.managedAccountProvider == IManagedAccountProvider(msg.sender),
      "Manager wallet not associated with MA"
    );

    Funding.applyOutstandingWalletFunding(
      managerWallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketsByBaseAssetSymbol
    );

    require(WalletExits.isWalletExitFinalized(managerWallet, walletExits), "Wallet exit not finalized");

    (Balance storage quoteBalanceStruct, uint64 walletQuoteQuantityAvailableToWithdraw) = Withdrawing
      .updatePositionsForWalletExit(
        managerWallet,
        IExchange(address(this)).exitFundWallet(),
        IExchange(address(this)).oraclePriceAdapter(),
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        marketOverridesByBaseAssetSymbolAndWallet,
        marketsByBaseAssetSymbol,
        pendingDepositQuantityByWallet
      );
    require(walletQuoteQuantityAvailableToWithdraw >= quantity, "Quantity exceeds available quote balance");
    quoteBalanceStruct.balance -= Math.toInt64(quantity);

    IExchange(address(this)).custodian().withdraw(
      depositorWallet,
      IExchange(address(this)).quoteTokenAddress(),
      AssetUnitConversions.pipsToAssetUnits(quantity, Constants.QUOTE_TOKEN_DECIMALS)
    );

    emit ExchangeEvents.WalletExitFromManagedAccountWithdrawn(managerWallet, depositorWallet, quantity);

    return
      ExitFund.getExitFundPositionOpenedAtBlockTimestamp(
        exitFundPositionOpenedAtBlockTimestamp,
        IExchange(address(this)).exitFundWallet(),
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet
      );
  }

  function _isBridgeAdapterWhitelisted(
    IBridgeAdapter bridgeAdapter,
    IBridgeAdapter[] memory bridgeAdapters
  ) private pure returns (bool) {
    for (uint8 i = 0; i < bridgeAdapters.length; i++) {
      if (bridgeAdapter == bridgeAdapters[i]) {
        return true;
      }
    }

    return false;
  }

  function _transferWithdrawnQuoteAsset(
    address bridgeAdapter,
    ICustodian custodian,
    uint64 gasFee,
    uint64 grossQuantity,
    IManagedAccountProvider managedAccountProvider,
    address quoteTokenAddress,
    IBridgeAdapter[] storage bridgeAdapters
  ) private {
    if (bridgeAdapter != address(0x0)) {
      require(_isBridgeAdapterWhitelisted(IBridgeAdapter(bridgeAdapter), bridgeAdapters), "Invalid bridge adapter");
    }

    // Transfer funds from Custodian to MA contract
    uint256 netAssetQuantityInAssetUnits = AssetUnitConversions.pipsToAssetUnits(
      grossQuantity - gasFee,
      Constants.QUOTE_TOKEN_DECIMALS
    );
    if (netAssetQuantityInAssetUnits > 0) {
      custodian.withdraw(address(managedAccountProvider), quoteTokenAddress, netAssetQuantityInAssetUnits);
    }
  }

  function _validateManagedAccountProviderIsWhitelisted(
    IManagedAccountProvider managedAccountProvider,
    IManagedAccountProvider[] memory managedAccountProviders
  ) private pure {
    bool managedAccountIsWhitelisted = false;
    for (uint8 i = 0; i < managedAccountProviders.length; i++) {
      if (managedAccountProvider == managedAccountProviders[i]) {
        managedAccountIsWhitelisted = true;
        break;
      }
    }
    require(managedAccountIsWhitelisted, "Invalid Managed Account Provider contract");
  }

  function _validateWithdrawalSignature(
    bytes32 domainSeparator,
    WithdrawalFromManagedAccountByQuantity memory withdrawal
  ) private pure returns (bytes32 withdrawalHash) {
    withdrawalHash = Hashing.getWithdrawalFromManagedAccountByQuantityHash(withdrawal);

    require(
      Hashing.isSignatureValid(domainSeparator, withdrawalHash, withdrawal.walletSignature, withdrawal.depositorWallet),
      "Invalid wallet signature"
    );
  }

  function _validateWithdrawalSignature(
    bytes32 domainSeparator,
    WithdrawalFromManagedAccountByShares memory withdrawal
  ) private pure returns (bytes32 withdrawalHash) {
    withdrawalHash = Hashing.getWithdrawalFromManagedAccountBySharesHash(withdrawal);

    require(
      Hashing.isSignatureValid(domainSeparator, withdrawalHash, withdrawal.walletSignature, withdrawal.depositorWallet),
      "Invalid wallet signature"
    );
  }
}
