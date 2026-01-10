// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { ExchangeErrors } from "./libraries/ExchangeErrors.sol";

/**
 * @notice Mixin that provide separate owner and admin roles for RBAC
 */
abstract contract Owned is ExchangeErrors {
  address public ownerWallet;
  address public adminWallet;

  modifier onlyOwner() {
    if (msg.sender != ownerWallet) {
      revert SenderMustBeOwner();
    }
    _;
  }
  modifier onlyAdmin() {
    if (msg.sender != adminWallet) {
      revert SenderMustBeAdmin();
    }
    _;
  }

  /**
   * @notice Sets both the owner and admin roles to the contract creator
   */
  constructor() {
    ownerWallet = msg.sender;
    adminWallet = msg.sender;
  }

  /**
   * @notice Sets a new whitelisted admin wallet
   *
   * @param newAdmin The new whitelisted admin wallet. Must be different from the current one
   */
  function setAdmin(address newAdmin) external onlyOwner {
    if (newAdmin == address(0x0)) {
      revert InvalidWalletAddress();
    }
    if (newAdmin == adminWallet) {
      revert NewValueMustBeDifferentFromCurrent();
    }

    adminWallet = newAdmin;
  }

  /**
   * @notice Sets a new owner wallet
   *
   * @param newOwner The new owner wallet. Must be different from the current one
   */
  function setOwner(address newOwner) external onlyOwner {
    if (newOwner == address(0x0)) {
      revert InvalidWalletAddress();
    }
    if (newOwner == ownerWallet) {
      revert NewValueMustBeDifferentFromCurrent();
    }

    ownerWallet = newOwner;
  }

  /**
   * @notice Clears the currently whitelisted admin wallet, effectively disabling any functions requiring
   * the admin role
   */
  function removeAdmin() external onlyOwner {
    adminWallet = address(0x0);
  }

  /**
   * @notice Permanently clears the owner wallet, effectively disabling any functions requiring the owner role
   */
  function removeOwner() external onlyOwner {
    ownerWallet = address(0x0);
  }
}
