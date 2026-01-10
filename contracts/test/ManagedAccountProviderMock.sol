// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IExchange, IManagedAccountProvider } from "../libraries/Interfaces.sol";

contract ManagedAccountProviderMock {
  IExchange public immutable exchange;
  mapping(address => bool) private _isDepositEnabled;
  mapping(address => bool) private _isApplyDepositEnabled;

  constructor(IExchange exchange_) {
    exchange = exchange_;
    IERC20(exchange.quoteTokenAddress()).approve(address(exchange), type(uint256).max);
  }

  function addManagedAccount(address managerWallet, bytes calldata /* payload */) public {
    exchange.associateManagerWalletWithManagedAccount(managerWallet);
  }

  function deposit(
    uint64 depositIndex,
    uint64 quantity,
    address sourceWallet,
    address depositorWallet,
    address managerWallet,
    bytes memory managedAccountProviderPayload
  ) public {
    // solhint-disable-next-line no-empty-blocks
    // No-op
  }

  function applyPendingDeposit(uint64 depositIndex, address managerWallet, uint64 quantity) public {
    // solhint-disable-next-line no-empty-blocks
    // No-op
  }

  function setDepositEnabled(address managerWallet, bool isEnabled) public {
    _isDepositEnabled[managerWallet] = isEnabled;
  }

  function setApplyDepositEnabled(address managerWallet, bool isEnabled) public {
    _isApplyDepositEnabled[managerWallet] = isEnabled;
  }

  function applyPendingWithdrawal(
    uint64 gasFee,
    uint64 grossQuantity,
    address managerWallet,
    bytes32 withdrawalHash
  ) public {
    // solhint-disable-next-line no-empty-blocks
    // No-op
  }

  function cancelPendingWithdrawal(uint64 gasFee, address managerWallet, bytes32 withdrawalHash) public {
    // solhint-disable-next-line no-empty-blocks
    // No-op
  }

  function liquidateManagerWallet(address managerWallet) public {
    // solhint-disable-next-line no-empty-blocks
    // No-op
  }

  function depositToManagedAccount(
    uint256 quantityInAssetUnits,
    address depositorWallet,
    IManagedAccountProvider managedAccountProvider,
    bytes calldata managedAccountProviderPayload,
    address managerWallet
  ) public {
    exchange.depositToManagedAccount(
      quantityInAssetUnits,
      depositorWallet,
      managedAccountProvider,
      managedAccountProviderPayload,
      managerWallet
    );
  }

  function exitWallet(address managerWallet) public {
    exchange.exitWallet(managerWallet);
  }

  function withdrawExit(address managerWallet, address depositorWallet, uint64 exitWithdrawalQuantity) public {
    exchange.withdrawExitFromManagedAccount(depositorWallet, managerWallet, exitWithdrawalQuantity);
  }
}
