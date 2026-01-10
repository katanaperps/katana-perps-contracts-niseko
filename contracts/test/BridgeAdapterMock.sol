// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IExchange, IManagedAccountProvider } from "../libraries/Interfaces.sol";
import { WithdrawalFromManagedAccount } from "../libraries/Structs.sol";

interface IExchangeExtended is IExchange {
  function applyPendingDepositToManagedAccount(uint64 depositIndex, uint64 quantity, address managerWallet) external;

  function applyPendingWithdrawalFromManagedAccount(WithdrawalFromManagedAccount memory withdrawal) external;

  function cancelPendingWithdrawalFromManagedAccount(WithdrawalFromManagedAccount memory withdrawal) external;
}

contract BridgeAdapterMock {
  IExchangeExtended private _exchange;
  IManagedAccountProvider private _managedAccountProvider;

  function setExchange(IExchangeExtended newExchange) external {
    _exchange = newExchange;
    IERC20(_exchange.quoteTokenAddress()).approve(address(_exchange), type(uint256).max);
  }

  function setManagedAccountProvider(IManagedAccountProvider newManagedAccountProvider) external {
    _managedAccountProvider = newManagedAccountProvider;
  }

  // Exchange stubs //

  function depositToManagedAccount(
    uint256 quantityInAssetUnits,
    address depositorWallet,
    IManagedAccountProvider managedAccountProvider,
    bytes memory managedAccountProviderPayload,
    address managerWallet
  ) external {
    IERC20(_exchange.quoteTokenAddress()).transferFrom(msg.sender, address(this), quantityInAssetUnits);
    _exchange.depositToManagedAccount(
      quantityInAssetUnits,
      depositorWallet,
      managedAccountProvider,
      managedAccountProviderPayload,
      managerWallet
    );
  }

  function applyPendingDepositToManagedAccount(uint64 depositIndex, uint64 quantity, address managerWallet) public {
    _exchange.applyPendingDepositToManagedAccount(depositIndex, quantity, managerWallet);
  }

  function applyPendingWithdrawalFromManagedAccount(WithdrawalFromManagedAccount memory withdrawal) public {
    _exchange.applyPendingWithdrawalFromManagedAccount(withdrawal);
  }

  function cancelPendingWithdrawalFromManagedAccount(WithdrawalFromManagedAccount memory withdrawal) public {
    _exchange.cancelPendingWithdrawalFromManagedAccount(withdrawal);
  }

  // MA provider stubs //

  function addManagedAccount(address managerWallet, bytes calldata payload) external {
    _managedAccountProvider.addManagedAccount(managerWallet, payload);
  }

  // Withdrawal stub //

  function withdrawQuoteAsset(
    address /* depositorWallet */,
    uint256 /* quantity */,
    bytes memory /* payload */
  ) public {}
}
