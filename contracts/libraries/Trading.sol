// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { BalanceTracking } from "./BalanceTracking.sol";
import { Constants } from "./Constants.sol";
import { ExchangeEvents } from "./ExchangeEvents.sol";
import { Funding } from "./Funding.sol";
import { IndexPriceMargin } from "./IndexPriceMargin.sol";
import { TradeValidations } from "./TradeValidations.sol";
import { WalletExits } from "./WalletExits.sol";
import {
  FundingMultiplierQuartet,
  Market,
  MarketOverrides,
  Order,
  NonceInvalidation,
  Trade,
  WalletExit
} from "./Structs.sol";

library Trading {
  using BalanceTracking for BalanceTracking.Storage;

  // Placing arguments in calldata avoids a stack too deep error from the Yul optimizer
  // solhint-disable-next-line func-name-mixedcase
  function executeTrade_delegatecall(
    Trade memory trade,
    Order memory buy,
    Order memory sell,
    // Exchange state
    uint64 delegateKeyExpirationPeriodInMs,
    bytes32 domainSeparator,
    address exitFundWallet,
    address feeWallet,
    address insuranceFundWallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(bytes32 => bool) storage completedOrderHashes,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => NonceInvalidation[]) storage nonceInvalidationsByWallet,
    mapping(bytes32 => uint64) storage partiallyFilledOrderQuantities,
    mapping(address => WalletExit) storage walletExits
  ) public {
    require(!WalletExits.isWalletExitFinalized(buy.wallet, walletExits), "Buy wallet exit finalized");
    require(!WalletExits.isWalletExitFinalized(sell.wallet, walletExits), "Sell wallet exit finalized");

    // Funding payments must be made prior to updating any position to ensure that the funding is calculated
    // against the position size at the time of each historic multiplier
    Funding.applyOutstandingWalletFunding(
      buy.wallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketsByBaseAssetSymbol
    );
    Funding.applyOutstandingWalletFunding(
      sell.wallet,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketsByBaseAssetSymbol
    );

    (bytes32 buyHash, bytes32 sellHash, Market memory market) = TradeValidations.validateTrade(
      trade,
      buy,
      sell,
      delegateKeyExpirationPeriodInMs,
      domainSeparator,
      exitFundWallet,
      insuranceFundWallet,
      marketsByBaseAssetSymbol,
      nonceInvalidationsByWallet
    );

    // Buy side
    _updateOrderFilledQuantity(buy, buyHash, trade.baseQuantity, completedOrderHashes, partiallyFilledOrderQuantities);
    // Sell side
    _updateOrderFilledQuantity(
      sell,
      sellHash,
      trade.baseQuantity,
      completedOrderHashes,
      partiallyFilledOrderQuantities
    );

    // Update balances
    (bool wasBuyPositionReduced, bool wasSellPositionReduced) = balanceTracking.updateForTrade(
      trade,
      buy,
      sell,
      feeWallet,
      market,
      baseAssetSymbolsWithOpenPositionsByWallet,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet
    );

    // Both wallets must still meet initial margin requirements
    _validateMarginRequirements(
      buy,
      sell,
      wasBuyPositionReduced,
      wasSellPositionReduced,
      balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      marketOverridesByBaseAssetSymbolAndWallet,
      marketsByBaseAssetSymbol
    );

    // Either both or none of the orders will have `isLiquidationAcquisitionOnly` asserted as validated by
    // `TradeValidations.validateTrade`
    if (buy.isLiquidationAcquisitionOnly) {
      emit ExchangeEvents.LiquidationAcquisitionExecuted(
        buy.wallet,
        sell.wallet,
        trade.baseAssetSymbol,
        Constants.QUOTE_ASSET_SYMBOL,
        trade.baseQuantity,
        trade.quoteQuantity,
        trade.makerSide,
        trade.makerFeeQuantity,
        trade.takerFeeQuantity
      );
    } else {
      emit ExchangeEvents.TradeExecuted(
        buy.wallet,
        sell.wallet,
        trade.baseAssetSymbol,
        Constants.QUOTE_ASSET_SYMBOL,
        trade.baseQuantity,
        trade.quoteQuantity,
        trade.makerSide,
        trade.makerFeeQuantity,
        trade.takerFeeQuantity
      );
    }
  }

  // Update filled quantities tracking for order to prevent over- or double-filling orders
  function _updateOrderFilledQuantity(
    Order memory order,
    bytes32 orderHash,
    uint64 grossBaseQuantity,
    mapping(bytes32 => bool) storage completedOrderHashes,
    mapping(bytes32 => uint64) storage partiallyFilledOrderQuantities
  ) private {
    require(!completedOrderHashes[orderHash], "Order double filled");

    // Total quantity of above filled as a result of all trade executions, including this one
    uint64 newFilledQuantity;

    // Track partially filled quantities in base terms
    newFilledQuantity = grossBaseQuantity + partiallyFilledOrderQuantities[orderHash];

    uint64 quantity = order.quantity;
    require(newFilledQuantity <= quantity, "Order overfilled");
    if (newFilledQuantity < quantity) {
      // If the order was partially filled, track the new filled quantity
      partiallyFilledOrderQuantities[orderHash] = newFilledQuantity;
    } else {
      // If the order was completed, delete any partial fill tracking and instead track its completion
      // to prevent future double fills
      delete partiallyFilledOrderQuantities[orderHash];
      completedOrderHashes[orderHash] = true;
    }
  }

  function _validateMarginRequirements(
    Order memory buy,
    Order memory sell,
    bool wasBuyPositionReduced,
    bool wasSellPositionReduced,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet,
    mapping(string => Market) storage marketsByBaseAssetSymbol
  ) private view {
    if (wasBuyPositionReduced) {
      IndexPriceMargin.validateMaintenanceMarginRequirement(
        buy.wallet,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        marketsByBaseAssetSymbol
      );
    } else {
      IndexPriceMargin.validateInitialMarginRequirement(
        buy.wallet,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        marketsByBaseAssetSymbol
      );
    }

    if (wasSellPositionReduced) {
      IndexPriceMargin.validateMaintenanceMarginRequirement(
        sell.wallet,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        marketsByBaseAssetSymbol
      );
    } else {
      IndexPriceMargin.validateInitialMarginRequirement(
        sell.wallet,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        marketsByBaseAssetSymbol
      );
    }
  }
}
