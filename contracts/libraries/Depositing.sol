// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AssetUnitConversions } from "./AssetUnitConversions.sol";
import { BalanceTracking } from "./BalanceTracking.sol";
import { Constants } from "./Constants.sol";
import { ExchangeEvents } from "./ExchangeEvents.sol";
import { Balance, WalletExit } from "./Structs.sol";
import { ICustodian, IManagedAccountProvider } from "./Interfaces.sol";

library Depositing {
  using BalanceTracking for BalanceTracking.Storage;

  // solhint-disable-next-line func-name-mixedcase
  function deposit_delegatecall(
    // External arguments
    address depositorWallet,
    address sourceWallet,
    uint256 quantityInAssetUnits,
    // Exchange state values
    ICustodian custodian,
    uint64 depositIndex,
    address exitFundWallet,
    bool isDepositEnabled,
    address quoteTokenAddress,
    // Exchange state storage refs
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => uint64) storage pendingDepositQuantityByWallet,
    mapping(address => WalletExit) storage walletExits
  ) public {
    Balance storage balanceStruct = balanceTracking.loadBalanceStructAndMigrateIfNeeded(
      depositorWallet,
      Constants.QUOTE_ASSET_SYMBOL
    );
    require(
      balanceStruct.managedAccountProvider == IManagedAccountProvider(address(0x0)),
      "Wallet is associated with MA"
    );

    uint64 depositedQuantity = deposit(
      custodian,
      depositIndex,
      depositorWallet,
      exitFundWallet,
      isDepositEnabled,
      quantityInAssetUnits,
      quoteTokenAddress,
      sourceWallet,
      pendingDepositQuantityByWallet,
      walletExits
    );

    emit ExchangeEvents.Deposited(
      // The Exchange will update the stored deposit index after this function returns
      depositIndex + 1,
      sourceWallet,
      depositorWallet,
      depositedQuantity,
      false
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function applyPendingDepositsForWallet_delegatecall(
    uint64 quantity,
    address wallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => uint64) storage pendingDepositQuantityByWallet
  ) public {
    uint64 pendingDepositQuantity = pendingDepositQuantityByWallet[wallet];
    require(quantity <= pendingDepositQuantity, "Quantity to apply exceeds pending");

    pendingDepositQuantityByWallet[wallet] = pendingDepositQuantity - quantity;

    // Update balance with argument quantity
    (int64 newExchangeBalance, IManagedAccountProvider managedAccount) = balanceTracking.updateForDeposit(
      wallet,
      quantity
    );
    require(managedAccount == IManagedAccountProvider(address(0x0)), "Wallet is associated with MA");

    emit ExchangeEvents.PendingDepositApplied(wallet, quantity, newExchangeBalance, false);
  }

  function deposit(
    ICustodian custodian,
    uint64 depositIndex,
    address depositorWallet,
    address exitFundWallet,
    bool isDepositEnabled,
    uint256 quantityInAssetUnits,
    address quoteTokenAddress,
    address sourceWallet,
    mapping(address => uint64) storage pendingDepositQuantityByWallet,
    mapping(address => WalletExit) storage walletExits
  ) internal returns (uint64 depositedQuantity) {
    // Deposits are disabled until `setDepositIndex` is called successfully
    require(depositIndex != Constants.DEPOSIT_INDEX_NOT_SET && isDepositEnabled, "Deposits disabled");
    require(depositorWallet != exitFundWallet, "Cannot deposit to EF");

    // Calling exitWallet disables deposits immediately on mining, in contrast to withdrawals and trades which respect
    // the Chain Propagation Period given by `effectiveBlockTimestamp` via `_isWalletExitFinalized`
    require(!walletExits[sourceWallet].exists, "Source wallet exited");
    require(!walletExits[depositorWallet].exists, "Depositor wallet exited");

    uint64 quantity = AssetUnitConversions.assetUnitsToPips(quantityInAssetUnits, Constants.QUOTE_TOKEN_DECIMALS);

    require(quantity > 0, "Quantity is too low");
    require(quantity < uint64(type(int64).max), "Quantity is too large");

    // Convert from pips back into asset units to remove any fractional amount that is too small
    // to express in pips. The `Exchange` will call `transferFrom` without this fractional amount
    // and there will be no dust
    uint256 quantityInAssetUnitsWithoutFractionalPips = AssetUnitConversions.pipsToAssetUnits(
      quantity,
      Constants.QUOTE_TOKEN_DECIMALS
    );

    uint256 balanceBefore = IERC20(quoteTokenAddress).balanceOf(address(custodian));

    // Forward the funds to the `Custodian`
    IERC20(quoteTokenAddress).transferFrom(sourceWallet, address(custodian), quantityInAssetUnitsWithoutFractionalPips);

    uint256 balanceAfter = IERC20(quoteTokenAddress).balanceOf(address(custodian));

    // Support fee-on-transfer by only crediting actual token balance difference. If fee causes
    // transferred amount to have a fractional pip component, it will accumulate as dust in the
    // Custodian
    depositedQuantity = AssetUnitConversions.assetUnitsToPips(
      balanceAfter - balanceBefore,
      Constants.QUOTE_TOKEN_DECIMALS
    );

    // Increment pending deposit quantity by actual transferred quantity
    pendingDepositQuantityByWallet[depositorWallet] += depositedQuantity;
  }
}
