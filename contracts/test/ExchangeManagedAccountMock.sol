// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IManagedAccountProvider } from "../libraries/Interfaces.sol";
import { WalletExit } from "../libraries/Structs.sol";

contract ExchangeManagedAccountMock {
  IManagedAccountProvider private _managedAccountProvider;
  address private _bridgeAdapter;
  bytes32 public domainSeparatorV4;
  address public exitFundWallet;
  address public insuranceFundWallet;
  address public quoteTokenAddress;
  WalletExit private _walletExit;

  constructor(
    bytes32 domainSeparatorV4_,
    address exitFundWallet_,
    address insuranceFundWallet_,
    address quoteTokenAddress_
  ) {
    domainSeparatorV4 = domainSeparatorV4_;
    exitFundWallet = exitFundWallet_;
    insuranceFundWallet = insuranceFundWallet_;
    quoteTokenAddress = quoteTokenAddress_;
  }

  function associateManagerWalletWithManagedAccount(address managerWallet) public {}

  function deposit(uint256 /* quantityInAssetUnits */, address /* depositorWallet */) public pure {
    revert("Deposits disabled");
  }

  function depositToManagedAccount(
    uint64 depositIndex,
    uint64 quantity,
    address sourceWallet,
    address depositorWallet,
    address managerWallet,
    bytes memory managedAccountProviderPayload
  ) public {
    _managedAccountProvider.deposit(
      depositIndex,
      quantity,
      sourceWallet,
      depositorWallet,
      managerWallet,
      managedAccountProviderPayload
    );
  }

  function applyPendingDeposit(uint64 depositIndex, address managerWallet, uint64 quantity) public {
    _managedAccountProvider.applyPendingDeposit(depositIndex, managerWallet, quantity);
  }

  function applyPendingWithdrawal(
    uint64 gasFee,
    uint64 grossQuantity,
    address managerWallet,
    bytes32 withdrawalHash
  ) public {
    _managedAccountProvider.applyPendingWithdrawal(gasFee, grossQuantity, managerWallet, withdrawalHash);
  }

  function exitWallet(address wallet) public pure {
    // No-op
  }

  function liquidateManagerWallet(address managerWallet) public {
    _managedAccountProvider.liquidateManagerWallet(managerWallet);
  }

  function loadBridgeAdaptersLength() public pure returns (uint256) {
    return 1;
  }

  function loadBridgeAdapter(uint8) public view returns (address) {
    return _bridgeAdapter;
  }

  function loadQuoteQuantityAvailableForExitWithdrawal(address /* wallet */) public pure returns (int64) {
    return -1;
  }

  function loadWalletExitStatus(address /* wallet */) public view returns (WalletExit memory) {
    return _walletExit;
  }

  function setWalletExitStatus(WalletExit memory walletExit) public {
    _walletExit = walletExit;
  }

  function setBridgeAdapter(address newBridgeAdapter) public {
    _bridgeAdapter = newBridgeAdapter;
  }

  function setManagedAccountProvider(IManagedAccountProvider newManagedAccountProvider) public {
    _managedAccountProvider = newManagedAccountProvider;
  }

  function withdrawExitFromManagedAccount(address depositorWallet, address managerWallet, uint64 quantity) public {
    // No-op
  }
}
