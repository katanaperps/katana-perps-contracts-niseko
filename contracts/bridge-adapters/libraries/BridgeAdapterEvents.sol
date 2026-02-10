// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

contract BridgeAdapterEvents {
  event ComposeFailed(address depositorWallet, uint256 quantity, bytes errorData);
  event ComposeSucceeded(uint32 sourceEndpointId, address destinationWallet, uint256 quantity);
  event WithdrawQuoteAssetFailed(address depositorWallet, uint256 quantity, bytes payload, bytes errorData);
}
