// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { IOFT, MessagingFee, SendParam } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";

import { Constants } from "../../libraries/Constants.sol";

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

  function compose(
    // External arguments
    uint256 amountLD,
    address from,
    bytes calldata message,
    // State values
    uint32 ethereumEndpointId,
    address exchangeLayerZeroAdapter,
    uint32 katanaEndpointId,
    uint64 minimumDepositNativeDropQuantityMultiplier,
    uint64 minimumForwardQuantityMultiplier,
    IOFT stargate,
    IERC20 usdc,
    IERC4626 vbUSDC,
    IOFT vbUSDCOFTAdapter
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
          katanaEndpointId,
          minimumDepositNativeDropQuantityMultiplier,
          minimumForwardQuantityMultiplier,
          vbUSDC,
          vbUSDCOFTAdapter
        );
    }

    // If the composeMessageType value is not included in the enum then abi.decode will revert
    // without a reason string, so we can safely assume the final enum value below

    // Withdrawing from Katana Bridge Adapter to EOA
    require(from == address(vbUSDCOFTAdapter), "OApp must be vbUSDC OFTAdapter");
    address composeFrom = OFTComposeMsgCodec.bytes32ToAddress(OFTComposeMsgCodec.composeFrom(message));
    _forwardWithdrawal(
      amountLD,
      composeFrom,
      composeMessage,
      ethereumEndpointId,
      exchangeLayerZeroAdapter,
      minimumForwardQuantityMultiplier,
      stargate,
      usdc,
      vbUSDC
    );
  }

  function _forwardDeposit(
    // External arguments
    uint256 amountLD,
    bytes memory composeMessage,
    // State values
    address exchangeLayerZeroAdapter,
    uint32 katanaEndpointId,
    uint64 minimumDepositNativeDropQuantityMultiplier,
    uint64 minimumForwardQuantityMultiplier,
    IERC4626 vbUSDC,
    IOFT vbUSDCOFTAdapter
  ) private {
    (, DepositToKatana memory depositToKatana) = abi.decode(composeMessage, (ComposeMessageType, DepositToKatana));
    address destinationWallet = depositToKatana.destinationWallet;

    // Deposit USDC to the vault and receive vbUSDC
    uint256 balanceBefore = vbUSDC.balanceOf(address(this));
    vbUSDC.deposit(amountLD, address(this));
    uint256 balanceAfter = vbUSDC.balanceOf(address(this));
    // Slippage is validated below by setting minAmountLD in SendParam
    uint256 vbUSDCAmountToSend = balanceAfter - balanceBefore;

    // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
    SendParam memory sendParam = SendParam({
      dstEid: katanaEndpointId,
      to: OFTComposeMsgCodec.addressToBytes32(exchangeLayerZeroAdapter),
      amountLD: vbUSDCAmountToSend,
      minAmountLD: (vbUSDCAmountToSend * minimumForwardQuantityMultiplier) / Constants.PIP_PRICE_MULTIPLIER,
      extraOptions: bytes(""),
      composeMsg: depositToKatana.exchangeLayerZeroAdapterPayload,
      oftCmd: bytes("") // Not used
    });
    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = vbUSDCOFTAdapter.quoteSend(sendParam, false);
    uint256 minimumNativeDrop = (messagingFee.nativeFee * minimumDepositNativeDropQuantityMultiplier) /
      Constants.PIP_PRICE_MULTIPLIER;
    if (msg.value < minimumNativeDrop) {
      // If the depositor did not include enough native asset, transfer the token amount forwarded from the remote
      // source chain to the destination wallet address on the local chain
      vbUSDC.transfer(destinationWallet, vbUSDCAmountToSend);
      emit ForwardFailed(destinationWallet, vbUSDCAmountToSend, composeMessage, "Insufficient native drop");

      return;
    }

    try
      // solhint-disable-next-line check-send-result
      vbUSDCOFTAdapter.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this)))
    {} catch (bytes memory errorData) {
      // If the send fails, transfer the token amount forwarded from the remote source chain to the destination
      // wallet address on the local chain
      vbUSDC.transfer(destinationWallet, vbUSDCAmountToSend);
      emit ForwardFailed(destinationWallet, vbUSDCAmountToSend, composeMessage, errorData);
    }
  }

  function _forwardWithdrawal(
    // External arguments
    uint256 amountLD,
    address composeFrom,
    bytes memory composeMessage,
    // State values
    uint32 ethereumEndpointId,
    address exchangeLayerZeroAdapter,
    uint64 minimumForwardQuantityMultiplier,
    IOFT stargate,
    IERC20 usdc,
    IERC4626 vbUSDC
  ) private {
    (, WithdrawFromKatana memory withdrawFromKatana) = abi.decode(
      composeMessage,
      (ComposeMessageType, WithdrawFromKatana)
    );
    address destinationWallet = withdrawFromKatana.destinationWallet;

    if (composeFrom != exchangeLayerZeroAdapter) {
      // Only the remote Bridge Adapter on Katana is allowed to compose withdrawals since this
      // contract will pay all the native fees needed to bridge them to the destination chain
      vbUSDC.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, "Invalid compose from");

      return;
    }

    // Redeem vbUSDC from vault and receive USDC
    uint256 balanceBefore = usdc.balanceOf(address(this));
    vbUSDC.redeem(amountLD, address(this), address(this));
    uint256 balanceAfter = usdc.balanceOf(address(this));
    // Slippage is validated below by setting minAmountLD in SendParam
    uint256 usdcAmountToSend = balanceAfter - balanceBefore;

    // If the destination endpoint ID is Ethereum then a second hop is not required, transfer USDC
    // directly to destination wallet
    if (withdrawFromKatana.destinationEndpointId == ethereumEndpointId) {
      usdc.transfer(destinationWallet, usdcAmountToSend);
      return;
    }

    // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
    SendParam memory sendParam = SendParam({
      dstEid: withdrawFromKatana.destinationEndpointId,
      to: OFTComposeMsgCodec.addressToBytes32(destinationWallet),
      amountLD: usdcAmountToSend,
      minAmountLD: (usdcAmountToSend * minimumForwardQuantityMultiplier) / Constants.PIP_PRICE_MULTIPLIER,
      extraOptions: bytes(""),
      composeMsg: bytes(""), // Compose not supported on withdrawal
      oftCmd: bytes("") // Not used
    });
    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = stargate.quoteSend(sendParam, false);

    // solhint-disable-next-line check-send-result
    try stargate.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this))) {} catch (
      bytes memory errorData
    ) {
      // If the send fails, transfer the token amount forwarded from the remote source chain to the
      // destination wallet address on the local chain
      usdc.transfer(destinationWallet, usdcAmountToSend);
      emit ForwardFailed(destinationWallet, usdcAmountToSend, composeMessage, errorData);
    }
  }
}
