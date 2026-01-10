// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Address } from "./Address.sol";
import { AssetUnitConversions } from "./AssetUnitConversions.sol";
import { BalanceTracking } from "./BalanceTracking.sol";
import { Constants } from "./Constants.sol";
import { ExchangeEvents } from "./ExchangeEvents.sol";
import { ExitFund } from "./ExitFund.sol";
import { Hashing } from "./Hashing.sol";
import { Funding } from "./Funding.sol";
import { IndexPriceMargin } from "./IndexPriceMargin.sol";
import { MarketHelper } from "./MarketHelper.sol";
import { Math } from "./Math.sol";
import { OraclePriceMargin } from "./OraclePriceMargin.sol";
import { WalletExitAcquisitionDeleveragePriceStrategy } from "./Enums.sol";
import { WalletExits } from "./WalletExits.sol";
import { IBridgeAdapter, ICustodian, IManagedAccountProvider, IOraclePriceAdapter } from "./Interfaces.sol";
import { Balance, FundingMultiplierQuartet, Market, MarketOverrides, WalletExit, Withdrawal } from "./Structs.sol";

library Withdrawing {
  using BalanceTracking for BalanceTracking.Storage;
  using MarketHelper for Market;

  // solhint-disable-next-line func-name-mixedcase
  function clearWalletExit_delegatecall(
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(address => WalletExit) storage walletExits
  ) public {
    require(WalletExits.isWalletExitFinalized(msg.sender, walletExits), "Wallet exit not finalized");
    require(
      baseAssetSymbolsWithOpenPositionsByWallet[msg.sender].length == 0 &&
        balanceTracking.loadBalanceFromMigrationSourceIfNeeded(msg.sender, Constants.QUOTE_ASSET_SYMBOL) == 0,
      "Must withdraw exit before clearing"
    );

    Balance storage balanceStruct = balanceTracking.loadBalanceStructAndMigrateIfNeeded(
      msg.sender,
      Constants.QUOTE_ASSET_SYMBOL
    );
    require(
      balanceStruct.managedAccountProvider == IManagedAccountProvider(address(0x0)),
      "Cannot clear exit for MA manager wallet"
    );

    delete walletExits[msg.sender];

    emit ExchangeEvents.WalletExitCleared(msg.sender);
  }

  // solhint-disable-next-line func-name-mixedcase
  function exitWallet_delegatecall(
    uint256 chainPropagationPeriodInS,
    address exitFundWallet,
    address insuranceFundWallet,
    address wallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => WalletExit) storage walletExits
  ) external {
    Balance storage balanceStruct = balanceTracking.loadBalanceStructAndMigrateIfNeeded(
      wallet,
      Constants.QUOTE_ASSET_SYMBOL
    );
    bool isAssociatedWithManagedAccount = balanceStruct.managedAccountProvider != IManagedAccountProvider(address(0x0));
    if (isAssociatedWithManagedAccount) {
      require(
        IManagedAccountProvider(msg.sender) == balanceStruct.managedAccountProvider,
        "Caller must be MA when exiting manager wallet"
      );
    } else {
      require(msg.sender == wallet, "Caller must be wallet to exit");
    }

    uint256 blockTimestampThreshold = exitWallet(
      chainPropagationPeriodInS,
      exitFundWallet,
      insuranceFundWallet,
      wallet,
      walletExits
    );

    emit ExchangeEvents.WalletExited(wallet, blockTimestampThreshold, isAssociatedWithManagedAccount);
  }

  // solhint-disable-next-line func-name-mixedcase
  function skim_delegatecall(address tokenAddress, address feeWallet) public {
    require(Address.isContract(tokenAddress), "Invalid token address");

    uint256 balance = IERC20(tokenAddress).balanceOf(address(this));

    // Ignore the return value of transfer
    IERC20(tokenAddress).transfer(feeWallet, balance);
  }

  // solhint-disable-next-line func-name-mixedcase
  function withdraw_delegatecall(
    // External arguments
    Withdrawal memory withdrawal,
    // Exchange state values
    bytes32 domainSeparator,
    ICustodian custodian,
    uint256 exitFundPositionOpenedAtBlockTimestamp,
    address exitFundWallet,
    address feeWallet,
    address quoteTokenAddress,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(bytes32 => bool) storage completedWithdrawalHashes,
    IBridgeAdapter[] storage bridgeAdapters,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => WalletExit) storage walletExits
  ) public {
    require(!WalletExits.isWalletExitFinalized(withdrawal.wallet, walletExits), "Wallet is exited");

    // Validate preconditions
    if (withdrawal.wallet == exitFundWallet) {
      _validateExitFundWithdrawDelayElapsed(exitFundPositionOpenedAtBlockTimestamp);
    }
    require(
      withdrawal.gasFee <= withdrawal.maximumGasFee && withdrawal.maximumGasFee <= withdrawal.grossQuantity,
      "Excessive withdrawal fee"
    );
    bytes32 withdrawalHash = _validateWithdrawalSignature(withdrawal, domainSeparator);
    require(!completedWithdrawalHashes[withdrawalHash], "Duplicate withdrawal");

    Funding.applyOutstandingWalletFunding(
      withdrawal.wallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketsByBaseAssetSymbol
    );

    // Update wallet balances
    int64 newExchangeBalance = balanceTracking.updateForWithdrawal(withdrawal, feeWallet);

    // EF has no margin requirements but may not withdraw quote balance below zero
    if (withdrawal.wallet == exitFundWallet) {
      require(newExchangeBalance >= 0, "EF may not withdraw to a negative balance");
    } else {
      // Wallet must still maintain initial margin requirement after withdrawal
      IndexPriceMargin.validateInitialMarginRequirement(
        withdrawal.wallet,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        marketsByBaseAssetSymbol
      );
    }

    _transferWithdrawnQuoteAsset(withdrawal, custodian, quoteTokenAddress, bridgeAdapters);

    // Replay prevention
    completedWithdrawalHashes[withdrawalHash] = true;

    emit ExchangeEvents.Withdrawn(withdrawal.wallet, withdrawal.grossQuantity, newExchangeBalance, false);
  }

  // solhint-disable-next-line func-name-mixedcase
  function withdrawExit_delegatecall(
    // External arguments
    address wallet,
    // Exchange state values
    ICustodian custodian,
    address exitFundWallet,
    IOraclePriceAdapter oraclePriceAdapter,
    address quoteTokenAddress,
    uint256 exitFundPositionOpenedAtBlockTimestamp,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => uint64) storage pendingDepositQuantityByWallet,
    mapping(address => WalletExit) storage walletExits
  ) public returns (uint256 exitFundPositionOpenedAtBlockTimestamp_) {
    Funding.applyOutstandingWalletFunding(
      wallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketsByBaseAssetSymbol
    );

    bool isExitFundWallet = wallet == exitFundWallet;

    uint64 walletQuoteQuantityToWithdraw;
    if (isExitFundWallet) {
      // Do not require prior exit for EF as it is already subject to a specific EF withdrawal delay
      _validateExitFundWithdrawDelayElapsed(exitFundPositionOpenedAtBlockTimestamp);

      // The EF wallet can withdraw its positive quote balance
      walletQuoteQuantityToWithdraw = validateExitQuoteQuantityAndCoerceIfNeeded(
        true,
        balanceTracking.updateExitFundWalletForExit(exitFundWallet)
      );
    } else {
      require(WalletExits.isWalletExitFinalized(wallet, walletExits), "Wallet exit not finalized");

      Balance storage quoteBalanceStruct;
      (quoteBalanceStruct, walletQuoteQuantityToWithdraw) = updatePositionsForWalletExit(
        wallet,
        exitFundWallet,
        oraclePriceAdapter,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        marketOverridesByBaseAssetSymbolAndWallet,
        marketsByBaseAssetSymbol,
        pendingDepositQuantityByWallet
      );

      bool isAssociatedWithManagedAccount = quoteBalanceStruct.managedAccountProvider !=
        IManagedAccountProvider(address(0x0));
      require(!isAssociatedWithManagedAccount, "Cannot withdraw exit from MA manager wallet");

      // Zero out quote balance as entire amount will be withdrawn
      quoteBalanceStruct.balance = 0;
    }

    custodian.withdraw(
      wallet,
      quoteTokenAddress,
      AssetUnitConversions.pipsToAssetUnits(walletQuoteQuantityToWithdraw, Constants.QUOTE_TOKEN_DECIMALS)
    );

    // Quote quantity validated to be non-negative by `validateExitQuoteQuantityAndCoerceIfNeeded`
    emit ExchangeEvents.WalletExitWithdrawn(wallet, walletQuoteQuantityToWithdraw);

    return
      ExitFund.getExitFundPositionOpenedAtBlockTimestamp(
        exitFundPositionOpenedAtBlockTimestamp,
        exitFundWallet,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet
      );
  }

  // solhint-disable-next-line func-name-mixedcase
  function withdrawExitAdmin_delegatecall(
    // External arguments
    address wallet,
    // Exchange state values
    ICustodian custodian,
    address exitFundWallet,
    IOraclePriceAdapter oraclePriceAdapter,
    address quoteTokenAddress,
    uint256 exitFundPositionOpenedAtBlockTimestamp,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => uint64) storage pendingDepositQuantityByWallet,
    mapping(address => WalletExit) storage walletExits
  ) public returns (uint256 exitFundPositionOpenedAtBlockTimestamp_) {
    require(walletExits[wallet].exists, "Wallet not exited");

    Funding.applyOutstandingWalletFunding(
      wallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketsByBaseAssetSymbol
    );

    // Quote quantity validated to be non-negative by `validateExitQuoteQuantityAndCoerceIfNeeded`
    (Balance storage quoteBalanceStruct, uint64 walletQuoteQuantityToWithdraw) = updatePositionsForWalletExit(
      wallet,
      exitFundWallet,
      oraclePriceAdapter,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      marketsByBaseAssetSymbol,
      pendingDepositQuantityByWallet
    );

    bool isAssociatedWithManagedAccount = quoteBalanceStruct.managedAccountProvider !=
      IManagedAccountProvider(address(0x0));
    require(!isAssociatedWithManagedAccount, "Cannot withdraw exit from MA manager wallet");

    // Zero out quote balance as entire amount will be withdrawn
    quoteBalanceStruct.balance = 0;

    custodian.withdraw(
      wallet,
      quoteTokenAddress,
      AssetUnitConversions.pipsToAssetUnits(walletQuoteQuantityToWithdraw, Constants.QUOTE_TOKEN_DECIMALS)
    );

    emit ExchangeEvents.WalletExitWithdrawn(wallet, walletQuoteQuantityToWithdraw);

    return
      ExitFund.getExitFundPositionOpenedAtBlockTimestamp(
        exitFundPositionOpenedAtBlockTimestamp,
        exitFundWallet,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet
      );
  }

  function validateExitQuoteQuantityAndCoerceIfNeeded(
    bool isExitFundWallet,
    int64 walletQuoteQuantityToWithdraw
  ) internal pure returns (uint64) {
    // Rounding errors can lead to a slightly negative result instead of zero - within the tolerance, coerce to zero
    // in these cases to allow wallet positions to be closed out
    if (
      !isExitFundWallet &&
      walletQuoteQuantityToWithdraw < 0 &&
      Math.abs(walletQuoteQuantityToWithdraw) <= Constants.MINIMUM_QUOTE_QUANTITY_VALIDATION_THRESHOLD
    ) {
      return 0;
    }

    // The available quote for exit withdrawal can validly be negative for the EF wallet. For all other wallets, the
    // exit quote calculations are designed such that the result quantity to withdraw is never negative; however we
    // still perform this check in case of unforeseen bugs or rounding errors. In either case we should revert on
    // negative. A zero available quantity would not transfer out any quote but would still close all positions and
    // quote balance, so we do not revert on zero
    require(walletQuoteQuantityToWithdraw >= 0, "Negative quote after exit");

    return uint64(walletQuoteQuantityToWithdraw);
  }

  function exitWallet(
    uint256 chainPropagationPeriodInS,
    address exitFundWallet,
    address insuranceFundWallet,
    address wallet,
    mapping(address => WalletExit) storage walletExits
  ) internal returns (uint256 blockTimestampThreshold) {
    require(!walletExits[wallet].exists, "Wallet already exited");
    require(wallet != exitFundWallet, "Cannot exit EF");
    require(wallet != insuranceFundWallet, "Cannot exit IF");

    blockTimestampThreshold = block.timestamp + chainPropagationPeriodInS;
    walletExits[wallet] = WalletExit(
      true,
      uint64(blockTimestampThreshold),
      WalletExitAcquisitionDeleveragePriceStrategy.None
    );
  }

  function updatePositionsForWalletExit(
    address wallet,
    address exitFundWallet,
    IOraclePriceAdapter oraclePriceAdapter,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => uint64) storage pendingDepositQuantityByWallet
  ) internal returns (Balance storage quoteBalanceStruct, uint64 walletQuoteQuantityAvailableToWithdraw) {
    BalanceTracking.UpdatePositionForExitArguments memory updatePositionForExitArguments;
    updatePositionForExitArguments.exitFundWallet = exitFundWallet;
    updatePositionForExitArguments.oraclePriceAdapter = oraclePriceAdapter;
    (
      updatePositionForExitArguments.exitAccountValue,
      updatePositionForExitArguments.totalAccountValueInDoublePips,
      updatePositionForExitArguments.totalMaintenanceMarginRequirementInTriplePips
    ) = OraclePriceMargin
      .loadTotalExitAccountValueAndAccountValueInDoublePipsAndMaintenanceMarginRequirementInTriplePips(
        oraclePriceAdapter,
        0, // Outstanding funding payments already applied in withdrawExit_delegatecall
        wallet,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        marketsByBaseAssetSymbol
      );
    updatePositionForExitArguments.wallet = wallet;

    int64 exitFundQuoteQuantityChange;

    string[] memory baseAssetSymbols = baseAssetSymbolsWithOpenPositionsByWallet[wallet];
    for (uint8 i = 0; i < baseAssetSymbols.length; i++) {
      updatePositionForExitArguments.market = marketsByBaseAssetSymbol[baseAssetSymbols[i]];
      updatePositionForExitArguments.maintenanceMarginFraction = marketsByBaseAssetSymbol[baseAssetSymbols[i]]
        .loadMarketWithOverridesForWallet(wallet, marketOverridesByBaseAssetSymbolAndWallet)
        .overridableFields
        .maintenanceMarginFraction;

      // Sum EF quote quantity change needed to close each wallet position
      exitFundQuoteQuantityChange += balanceTracking.updatePositionForExit(
        updatePositionForExitArguments,
        baseAssetSymbolsWithOpenPositionsByWallet,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol
      );
    }

    // Update EF quote balance with total quote change calculated above in loop
    quoteBalanceStruct = balanceTracking.loadBalanceStructAndMigrateIfNeeded(
      exitFundWallet,
      Constants.QUOTE_ASSET_SYMBOL
    );
    quoteBalanceStruct.balance += exitFundQuoteQuantityChange;

    // Update exiting wallet's quote balance
    quoteBalanceStruct = balanceTracking.loadBalanceStructAndMigrateIfNeeded(wallet, Constants.QUOTE_ASSET_SYMBOL);

    walletQuoteQuantityAvailableToWithdraw = uint64(
      // Quote quantity validated to be non-negative by `validateExitQuoteQuantityAndCoerceIfNeeded`
      validateExitQuoteQuantityAndCoerceIfNeeded(
        wallet == exitFundWallet,
        // The wallet's change in quote quantity from position closure is inverse to that of the EF to acquire them.
        // Subtract the EF quote change from wallet's existing quote balance to obtain total quote available for withdrawal
        quoteBalanceStruct.balance - exitFundQuoteQuantityChange
      )
    );

    // Apply all pending deposits
    walletQuoteQuantityAvailableToWithdraw += pendingDepositQuantityByWallet[wallet];
    pendingDepositQuantityByWallet[wallet] = 0;

    quoteBalanceStruct.balance = Math.toInt64(walletQuoteQuantityAvailableToWithdraw);
  }

  function _transferWithdrawnQuoteAsset(
    Withdrawal memory withdrawal,
    ICustodian custodian,
    address quoteTokenAddress,
    IBridgeAdapter[] storage bridgeAdapters
  ) private {
    uint256 netAssetQuantityInAssetUnits = AssetUnitConversions.pipsToAssetUnits(
      withdrawal.grossQuantity - withdrawal.gasFee,
      Constants.QUOTE_TOKEN_DECIMALS
    );
    if (netAssetQuantityInAssetUnits == 0) {
      // If net quantity is zero there is nothing further to do, no tokens will be transferred
      return;
    }

    if (withdrawal.bridgeAdapter == address(0x0)) {
      // Transfer funds from Custodian to wallet
      custodian.withdraw(withdrawal.wallet, quoteTokenAddress, netAssetQuantityInAssetUnits);
    } else {
      // Validate bridge adapter is whitelisted
      bool bridgeAdapterIsWhitelisted = false;
      for (uint8 i = 0; i < bridgeAdapters.length; i++) {
        if (withdrawal.bridgeAdapter == address(bridgeAdapters[i])) {
          bridgeAdapterIsWhitelisted = true;
          break;
        }
      }
      require(bridgeAdapterIsWhitelisted, "Invalid bridge adapter");

      // Transfer funds from Custodian to bridge adapter contract
      custodian.withdraw(withdrawal.bridgeAdapter, quoteTokenAddress, netAssetQuantityInAssetUnits);

      // Bridge adapter callback after tokens are transferred
      IBridgeAdapter(withdrawal.bridgeAdapter).withdrawQuoteAsset(
        withdrawal.wallet,
        netAssetQuantityInAssetUnits,
        withdrawal.bridgeAdapterPayload
      );
    }
  }

  function _validateExitFundWithdrawDelayElapsed(uint256 exitFundPositionOpenedAtBlockTimestamp) private view {
    require(
      block.timestamp >= exitFundPositionOpenedAtBlockTimestamp + Constants.EXIT_FUND_WITHDRAW_DELAY_IN_S,
      "EF position opened too recently"
    );
  }

  function _validateWithdrawalSignature(
    Withdrawal memory withdrawal,
    bytes32 domainSeparator
  ) private pure returns (bytes32 withdrawalHash) {
    withdrawalHash = Hashing.getWithdrawalHash(withdrawal);

    require(
      Hashing.isSignatureValid(domainSeparator, withdrawalHash, withdrawal.walletSignature, withdrawal.wallet),
      "Invalid wallet signature"
    );
  }
}
