// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IVerifierProxy } from "../index-price-adapters/ChainlinkDataStreamsIndexPriceAdapter.sol";

contract ChainlinkDataStreamsVerifierMock is IVerifierProxy {
  address private _feeManager;

  function verify(
    bytes calldata payload,
    bytes calldata /* parameterPayload */
  ) external payable returns (bytes memory) {
    (, bytes memory reportData) = abi.decode(payload, (bytes32[3], bytes));
    return reportData;
  }

  function setFeeManager(address newFeeManager) external {
    _feeManager = newFeeManager;
  }

  // solhint-disable-next-line func-name-mixedcase
  function s_feeManager() external view returns (address) {
    return _feeManager;
  }
}
