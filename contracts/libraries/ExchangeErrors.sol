// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

abstract contract ExchangeErrors {
  error ExitFundHasNoPositions();
  error ExitFundCannotHaveOpenPosition();
  error InvalidContractAddress();
  error InvalidWalletAddress();
  error NewInsuranceFundWalletCannotBeExited();
  error NewValueExceedsMaximum();
  error NewValueMustBeDifferentFromCurrent();
  error SenderMustBeAdminOrDispatcher();
  error SenderMustBeAdmin();
  error SenderMustBeDispatcher();
  error SenderMustBeGovernance();
  error SenderMustBeOwner();
  error UnknownBaseAssetSymbol();
  error ValueCanOnlyBetSetOnce();
  error WalletCannotBeExited();
  error WalletHasNoOverridesForMarket();
  error WalletMustBeExited();
}
