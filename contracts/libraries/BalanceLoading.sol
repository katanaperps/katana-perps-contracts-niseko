// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { BalanceTracking } from "./BalanceTracking.sol";
import { Constants } from "./Constants.sol";
import { Funding } from "./Funding.sol";
import { Math } from "./Math.sol";
import { String } from "./String.sol";
import { Balance, FundingMultiplierQuartet, Market } from "./Structs.sol";

library BalanceLoading {
  using BalanceTracking for BalanceTracking.Storage;

  function loadBalanceBySymbol_delegatecall(
    address wallet,
    string memory assetSymbol,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => Market) storage marketsByBaseAssetSymbol,
    mapping(address => uint64) storage pendingDepositQuantityByWallet
  ) public view returns (int64 balance) {
    balance = balanceTracking.loadBalanceFromMigrationSourceIfNeeded(wallet, assetSymbol);

    if (String.isEqual(assetSymbol, Constants.QUOTE_ASSET_SYMBOL)) {
      balance +=
        Funding.loadOutstandingWalletFunding(
          wallet,
          balanceTracking,
          baseAssetSymbolsWithOpenPositionsByWallet,
          fundingMultipliersByBaseAssetSymbol,
          lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
          marketsByBaseAssetSymbol
        ) +
        Math.toInt64(pendingDepositQuantityByWallet[wallet]);
    }
  }

  function loadBalanceStructBySymbol_delegatecall(
    address wallet,
    string memory assetSymbol,
    BalanceTracking.Storage storage balanceTracking
  ) public view returns (Balance memory) {
    return balanceTracking.loadBalanceStructFromMigrationSourceIfNeeded(wallet, assetSymbol);
  }
}
