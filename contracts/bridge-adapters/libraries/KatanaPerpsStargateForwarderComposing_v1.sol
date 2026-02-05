// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
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
  using OptionsBuilder for bytes;

  struct ComposeArguments {
    // External arguments
    uint256 amountLD;
    address from;
    // State values
    uint32 ethereumEndpointId;
    address exchangeLayerZeroAdapter;
    uint128 katanaComposeGasLimit;
    uint32 katanaEndpointId;
    uint64 minimumDepositNativeDropQuantityMultiplier;
    uint64 minimumForwardQuantityMultiplier;
    IOFT stargate;
    IERC20 usdc;
    IERC4626 vbUSDC;
    IOFT vbUSDCOFTAdapter;
  }

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

  function compose(ComposeArguments memory arguments, bytes calldata message) public {
    // Parse out composed message
    bytes memory composeMessage = OFTComposeMsgCodec.composeMsg(message);
    // The first field in the compose message indicates the type of payload that follows it
    ComposeMessageType composeMessageType = abi.decode(composeMessage, (ComposeMessageType));

    if (composeMessageType == ComposeMessageType.DepositToKatana) {
      // Depositing from EOA to Katana Bridge Adapter
      require(arguments.from == address(arguments.stargate), "OApp must be Stargate");
      return _forwardDeposit(arguments, composeMessage);
    }

    // If the composeMessageType value is not included in the enum then abi.decode will revert
    // without a reason string, so we can safely assume the final enum value below

    // Withdrawing from Katana Bridge Adapter to EOA
    require(arguments.from == address(arguments.vbUSDCOFTAdapter), "OApp must be vbUSDC OFTAdapter");
    address composeFrom = OFTComposeMsgCodec.bytes32ToAddress(OFTComposeMsgCodec.composeFrom(message));
    _forwardWithdrawal(arguments, composeFrom, composeMessage);
  }

  function _forwardDeposit(ComposeArguments memory arguments, bytes memory composeMessage) private {
    (, DepositToKatana memory depositToKatana) = abi.decode(composeMessage, (ComposeMessageType, DepositToKatana));
    address destinationWallet = depositToKatana.destinationWallet;

    // Total slippage is validated below by setting minAmountLD in SendParam
    uint256 minVbUsdcAmount = (arguments.amountLD * arguments.minimumForwardQuantityMultiplier) /
      Constants.PIP_PRICE_MULTIPLIER;
    // Deposit USDC to the vault and receive vbUSDC
    uint256 vbUSDCAmount = arguments.vbUSDC.deposit(arguments.amountLD, address(this));

    // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
    SendParam memory sendParam = SendParam({
      dstEid: arguments.katanaEndpointId,
      to: OFTComposeMsgCodec.addressToBytes32(arguments.exchangeLayerZeroAdapter),
      amountLD: vbUSDCAmount,
      minAmountLD: minVbUsdcAmount,
      extraOptions: OptionsBuilder.newOptions().addExecutorLzComposeOption(0, arguments.katanaComposeGasLimit, 0),
      composeMsg: depositToKatana.exchangeLayerZeroAdapterPayload,
      oftCmd: bytes("") // Not used
    });
    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = arguments.vbUSDCOFTAdapter.quoteSend(sendParam, false);
    uint256 minimumNativeDrop = (messagingFee.nativeFee * arguments.minimumDepositNativeDropQuantityMultiplier) /
      Constants.PIP_PRICE_MULTIPLIER;
    if (msg.value < minimumNativeDrop) {
      // If the depositor did not include enough native asset, transfer the converted vbUSDC amount
      // to the destination wallet address on the local chain
      arguments.vbUSDC.transfer(destinationWallet, vbUSDCAmount);
      emit ForwardFailed(destinationWallet, vbUSDCAmount, composeMessage, "Insufficient native drop");

      return;
    }

    try
      // solhint-disable-next-line check-send-result
      arguments.vbUSDCOFTAdapter.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this)))
    {} catch (bytes memory errorData) {
      // If the send fails, transfer the converted vbUSDC amount to the destination wallet address on
      // the local chain
      arguments.vbUSDC.transfer(destinationWallet, vbUSDCAmount);
      emit ForwardFailed(destinationWallet, vbUSDCAmount, composeMessage, errorData);
    }
  }

  function _forwardWithdrawal(
    ComposeArguments memory arguments,
    address composeFrom,
    bytes memory composeMessage
  ) private {
    (, WithdrawFromKatana memory withdrawFromKatana) = abi.decode(
      composeMessage,
      (ComposeMessageType, WithdrawFromKatana)
    );
    address destinationWallet = withdrawFromKatana.destinationWallet;

    if (composeFrom != arguments.exchangeLayerZeroAdapter) {
      // Only the remote Bridge Adapter on Katana is allowed to compose withdrawals since this
      // contract will pay all the native fees needed to bridge them to the destination chain
      arguments.vbUSDC.transfer(destinationWallet, arguments.amountLD);
      emit ForwardFailed(destinationWallet, arguments.amountLD, composeMessage, "Invalid compose from");

      return;
    }

    // If the destination endpoint ID is Ethereum then total slippage will not be asserted Stargate,
    // preview and assert slippage from conversion to USDC here first
    uint256 minUsdcAmount = (arguments.amountLD * arguments.minimumForwardQuantityMultiplier) /
      Constants.PIP_PRICE_MULTIPLIER;
    uint256 usdcAmount = arguments.vbUSDC.previewRedeem(arguments.amountLD);
    if (usdcAmount < minUsdcAmount) {
      // If slippage check fails then transfer the vbUSDC amount forwarded from Katana to the
      // destination wallet address on the local chain
      arguments.vbUSDC.transfer(destinationWallet, arguments.amountLD);
      emit ForwardFailed(destinationWallet, arguments.amountLD, composeMessage, "Slippage exceeded");
      return;
    }

    // Redeem vbUSDC from vault and receive USDC
    arguments.vbUSDC.redeem(arguments.amountLD, address(this), address(this));

    // If the destination endpoint ID is Ethereum then a second hop is not required, transfer USDC
    // directly to destination wallet
    if (withdrawFromKatana.destinationEndpointId == arguments.ethereumEndpointId) {
      arguments.usdc.transfer(destinationWallet, usdcAmount);
      return;
    }

    // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
    SendParam memory sendParam = SendParam({
      dstEid: withdrawFromKatana.destinationEndpointId,
      to: OFTComposeMsgCodec.addressToBytes32(destinationWallet),
      amountLD: usdcAmount,
      // Assert total slippage including conversion to USDC
      minAmountLD: minUsdcAmount,
      extraOptions: bytes(""),
      composeMsg: bytes(""), // Compose not supported on withdrawal
      oftCmd: bytes("") // Not used
    });
    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = arguments.stargate.quoteSend(sendParam, false);

    try
      // solhint-disable-next-line check-send-result
      arguments.stargate.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this)))
    {} catch (bytes memory errorData) {
      // If the send fails, transfer the converted USDC amount to the destination wallet address on
      // the local chain
      arguments.usdc.transfer(destinationWallet, usdcAmount);
      emit ForwardFailed(destinationWallet, usdcAmount, composeMessage, errorData);
    }
  }
}
