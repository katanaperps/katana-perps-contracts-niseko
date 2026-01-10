// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { Withdrawing } from "../libraries/Withdrawing.sol";

contract WithdrawExitValidationsMock {
  function validateExitQuoteQuantityAndCoerceIfNeeded(
    bool isExitFundWallet,
    int64 walletQuoteQuantityToWithdraw
  ) public pure returns (uint64) {
    return Withdrawing.validateExitQuoteQuantityAndCoerceIfNeeded(isExitFundWallet, walletQuoteQuantityToWithdraw);
  }
}
