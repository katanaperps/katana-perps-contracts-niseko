// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { IOFT, MessagingFee, SendParam } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";

/**
 * @dev External library that implements forwarding logic of deposits from remote chains into
 * Katana as well as withdrawals out of Katana to remote chains. The motivation to keep this logic
 * in an external library is primarily to allow wrapping it in a try/catch block so that funds can
 * be safely returned in the case of an unexpected reversion, and secondarily to keep the calling
 * contract's bytecode size within limits
 */
// solhint-disable-next-line contract-name-capwords
library KatanaPerpsStargateForwarderComposing_v1 {
  enum ComposeMessageType {
    DepositToKatana,
    WithdrawFromKatana
  }

  struct DepositToKatana {
    address destinationWallet;
    bytes exchangeLayerZeroAdapterPayload;
  }

  struct WithdrawFromKatana {
    uint32 destinationEndpointId;
    address destinationWallet;
  }

  event ForwardFailed(address destinationWallet, uint256 quantity, bytes payload, bytes errorData);

  // To convert integer pips to a fractional price shift decimal left by the pip precision of 8
  // decimals places
  uint64 public constant PIP_PRICE_MULTIPLIER = 10 ** 8;

  function compose(
    // External arguments
    uint256 amountLD,
    address from,
    bytes calldata message,
    // State values
    address exchangeLayerZeroAdapter,
    uint64 minimumDepositNativeDropQuantityMultiplier,
    uint64 minimumForwardQuantityMultiplier,
    IERC20 usdc,
    IOFT stargate,
    uint32 katanaEndpointId,
    IOFT katanaOFT
  ) public {
    // Parse out composed message
    bytes memory composeMessage = OFTComposeMsgCodec.composeMsg(message);
    // The first field in the compose message indicates the type of payload that follows it
    ComposeMessageType composeMessageType = abi.decode(composeMessage, (ComposeMessageType));

    if (composeMessageType == ComposeMessageType.DepositToKatana) {
      // Depositing from EOA to Katana Bridge Adapter
      require(from == address(stargate), "OApp must be Stargate");
      return
        _forwardDeposit(
          amountLD,
          composeMessage,
          exchangeLayerZeroAdapter,
          minimumDepositNativeDropQuantityMultiplier,
          minimumForwardQuantityMultiplier,
          usdc,
          katanaEndpointId,
          katanaOFT
        );
    }

    // If the composeMessageType value is not included in the enum then abi.decode will revert
    // without a reason string, so we can safely assume the final enum value below

    // Withdrawing from Katana Bridge Adapter to EOA
    require(from == address(katanaOFT), "OApp must be vbUSDC OFTAdapter");
    address composeFrom = OFTComposeMsgCodec.bytes32ToAddress(OFTComposeMsgCodec.composeFrom(message));
    _forwardWithdrawal(
      amountLD,
      composeFrom,
      composeMessage,
      exchangeLayerZeroAdapter,
      minimumForwardQuantityMultiplier,
      stargate,
      usdc
    );
  }

  function _forwardDeposit(
    // External arguments
    uint256 amountLD,
    bytes memory composeMessage,
    // State values
    address exchangeLayerZeroAdapter,
    uint64 minimumDepositNativeDropQuantityMultiplier,
    uint64 minimumForwardQuantityMultiplier,
    IERC20 usdc,
    uint32 katanaEndpointId,
    IOFT katanaOFT
  ) private {
    (, DepositToKatana memory depositToKatana) = abi.decode(composeMessage, (ComposeMessageType, DepositToKatana));
    address destinationWallet = depositToKatana.destinationWallet;

    // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
    SendParam memory sendParam = SendParam({
      dstEid: katanaEndpointId,
      to: OFTComposeMsgCodec.addressToBytes32(exchangeLayerZeroAdapter),
      amountLD: amountLD,
      minAmountLD: (amountLD * minimumForwardQuantityMultiplier) / PIP_PRICE_MULTIPLIER,
      extraOptions: bytes(""),
      composeMsg: depositToKatana.exchangeLayerZeroAdapterPayload,
      oftCmd: bytes("") // Not used
    });
    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = katanaOFT.quoteSend(sendParam, false);
    uint256 minimumNativeDrop = (messagingFee.nativeFee * minimumDepositNativeDropQuantityMultiplier) /
      PIP_PRICE_MULTIPLIER;
    if (msg.value < minimumNativeDrop) {
      // If the depositor did not include enough native asset, transfer the token amount forwarded from the remote
      // source chain to the destination wallet address on the local chain
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, "Insufficient native drop");

      return;
    }

    try katanaOFT.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this))) {} catch (
      bytes memory errorData
    ) {
      // If the send fails, transfer the token amount forwarded from the remote source chain to the destination
      // wallet address on the local chain
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, errorData);
    }
  }

  function _forwardWithdrawal(
    // External arguments
    uint256 amountLD,
    address composeFrom,
    bytes memory composeMessage,
    // State values
    address exchangeLayerZeroAdapter,
    uint64 minimumForwardQuantityMultiplier,
    IOFT stargate,
    IERC20 usdc
  ) private {
    (, WithdrawFromKatana memory withdrawFromKatana) = abi.decode(
      composeMessage,
      (ComposeMessageType, WithdrawFromKatana)
    );
    address destinationWallet = withdrawFromKatana.destinationWallet;

    if (composeFrom != exchangeLayerZeroAdapter) {
      // Only the remote Bridge Adapter on Katana is allowed to compose withdrawals since this
      // contract will pay all the native fees needed to bridge them to the destination chain
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, "Invalid compose from");

      return;
    }

    // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
    SendParam memory sendParam = SendParam({
      dstEid: withdrawFromKatana.destinationEndpointId,
      to: OFTComposeMsgCodec.addressToBytes32(destinationWallet),
      amountLD: amountLD,
      minAmountLD: (amountLD * minimumForwardQuantityMultiplier) / PIP_PRICE_MULTIPLIER,
      extraOptions: bytes(""),
      composeMsg: bytes(""), // Compose not supported on withdrawal
      oftCmd: bytes("") // Not used
    });
    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = stargate.quoteSend(sendParam, false);

    try stargate.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this))) {} catch (
      bytes memory errorData
    ) {
      // If the send fails, transfer the token amount forwarded from the remote source chain to the
      // destination wallet address on the local chain
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, errorData);
    }
  }
}
