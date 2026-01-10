// SPDX-License-Identifier: MIT

import { BalanceTracking } from "./BalanceTracking.sol";
import { Constants } from "./Constants.sol";
import { ExchangeEvents } from "./ExchangeEvents.sol";

pragma solidity 0.8.25;

library ExitFund {
  using BalanceTracking for BalanceTracking.Storage;

  // solhint-disable-next-line func-name-mixedcase
  function validateExitFundWallet_delegatecall(
    address currentExitFundWallet,
    address newExitFundWallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet
  ) public {
    require(newExitFundWallet != address(0x0), "Invalid wallet address");
    require(newExitFundWallet != currentExitFundWallet, "Must be different from current Exit Fund");

    require(
      !ExitFund.doesWalletHaveOpenPositionsOrQuoteBalance(
        currentExitFundWallet,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet
      ),
      "Current Exit Fund cannot have open balance"
    );

    require(
      !ExitFund.doesWalletHaveOpenPositionsOrQuoteBalance(
        newExitFundWallet,
        balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet
      ),
      "New Exit Fund cannot have open balance"
    );

    require(
      address(
        balanceTracking
          .loadBalanceStructAndMigrateIfNeeded(newExitFundWallet, Constants.QUOTE_ASSET_SYMBOL)
          .managedAccountProvider
      ) == address(0x0),
      "New Exit Fund cannot be associated with MA"
    );

    emit ExchangeEvents.ExitFundWalletChanged(currentExitFundWallet, newExitFundWallet);
  }

  // Returns the block timestamp at which an EF position initially opened; zero if EF has no open positions or quote
  // balance
  function getExitFundPositionOpenedAtBlockTimestamp(
    uint256 currentExitFundBalanceOpenedAtBlockTimestamp,
    address exitFundWallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet
  ) internal view returns (uint256) {
    bool isPositionOpen = baseAssetSymbolsWithOpenPositionsByWallet[exitFundWallet].length > 0;
    bool isQuoteOpen = balanceTracking.loadBalanceFromMigrationSourceIfNeeded(
      exitFundWallet,
      Constants.QUOTE_ASSET_SYMBOL
    ) > 0;

    // Position opened when none was before, return current block timestamp
    if (currentExitFundBalanceOpenedAtBlockTimestamp == 0 && isPositionOpen) {
      return block.timestamp;
    }

    // Position or quote was open before but both are now closed, reset block timestamp. Note that quote must be
    // drawn down to zero before resetting since EF quote withdrawals are not possible after reset
    if (currentExitFundBalanceOpenedAtBlockTimestamp > 0 && !(isPositionOpen || isQuoteOpen)) {
      return 0;
    }

    // No change in balance or quote opened block timestamp
    return currentExitFundBalanceOpenedAtBlockTimestamp;
  }

  function doesWalletHaveOpenPositionsOrQuoteBalance(
    address exitFundWallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet
  ) internal view returns (bool) {
    return
      baseAssetSymbolsWithOpenPositionsByWallet[exitFundWallet].length > 0 ||
      balanceTracking.loadBalanceFromMigrationSourceIfNeeded(exitFundWallet, Constants.QUOTE_ASSET_SYMBOL) > 0;
  }
}
