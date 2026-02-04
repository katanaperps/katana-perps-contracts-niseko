// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILayerZeroComposer } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroComposer.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {
  MessagingFee,
  MessagingReceipt,
  OFTFeeDetail,
  OFTLimit,
  OFTReceipt,
  SendParam
} from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";

contract StargateV2PoolMock {
  uint256 public nativeFee;
  uint256 public tokenFee;
  address public quoteTokenAddress;
  bool private _sendDisabled;
  uint8 private _sharedDecimals;

  constructor(uint256 nativeFee_, uint256 tokenFee_, address quoteTokenAddress_) {
    nativeFee = nativeFee_;
    tokenFee = tokenFee_;
    quoteTokenAddress = quoteTokenAddress_;
    _sharedDecimals = 6;
  }

  function token() external view returns (address) {
    return quoteTokenAddress;
  }

  function lzCompose(
    ILayerZeroComposer composer,
    address _from,
    bytes32 _guid,
    bytes calldata _message,
    address _executor,
    bytes calldata _extraData
  ) public payable {
    composer.lzCompose(_from, _guid, _message, _executor, _extraData);
  }

  function quoteOFT(
    SendParam calldata _sendParam
  ) public view returns (OFTLimit memory, OFTFeeDetail[] memory oftFeeDetails, OFTReceipt memory) {
    oftFeeDetails = new OFTFeeDetail[](1);
    oftFeeDetails[0] = OFTFeeDetail({ feeAmountLD: SafeCast.toInt256(nativeFee), description: "" });

    return (
      OFTLimit({ minAmountLD: 1, maxAmountLD: 1000000000000000 }),
      oftFeeDetails,
      OFTReceipt({ amountSentLD: _sendParam.amountLD, amountReceivedLD: _sendParam.amountLD - tokenFee })
    );
  }

  function quoteSend(SendParam calldata, bool) public view returns (MessagingFee memory) {
    return MessagingFee({ nativeFee: nativeFee, lzTokenFee: 0 });
  }

  function setSendDisabled(bool sendDisabled) public {
    _sendDisabled = sendDisabled;
  }

  function setSharedDecimals(uint8 newSharedDecimals) public {
    _sharedDecimals = newSharedDecimals;
  }

  function sharedDecimals() public view returns (uint8) {
    return _sharedDecimals;
  }

  function send(
    SendParam calldata _sendParam,
    MessagingFee calldata _fee,
    address
  ) public payable returns (MessagingReceipt memory, OFTReceipt memory) {
    if (_sendDisabled) {
      revert("Send disabled");
    }

    IERC20(quoteTokenAddress).transferFrom(msg.sender, address(this), _sendParam.amountLD);

    return (
      MessagingReceipt({ guid: bytes32(0x0), nonce: 0, fee: _fee }),
      OFTReceipt({ amountSentLD: _sendParam.amountLD, amountReceivedLD: _sendParam.amountLD - tokenFee })
    );
  }

  function setFees(uint256 newNativeFee, uint256 newTokenFee) public {
    nativeFee = newNativeFee;
    tokenFee = newTokenFee;
  }
}
