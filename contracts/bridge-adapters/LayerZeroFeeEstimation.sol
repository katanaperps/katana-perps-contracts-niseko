// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {
  IOFT,
  OFTReceipt,
  MessagingFee,
  SendParam
} from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";

import { AssetUnitConversions } from "../libraries/AssetUnitConversions.sol";
import { Constants } from "../libraries/Constants.sol";

library LayerZeroFeeEstimation {
  using OptionsBuilder for bytes;

  /**
   * @notice Estimate actual quantity of USDC that will be delivered on target chain after pool fees
   *
   * @dev quantity is in pips since this function is used in conjunction with the off-chain SDK and REST API
   */
  function loadEstimatedDeliveredQuantityInAssetUnits(
    uint32 destinationEndpointId,
    uint64 minimumQuantityMultiplier,
    IOFT oft,
    uint64 quantity
  )
    internal
    view
    returns (uint256 estimatedDeliveredQuantityInAssetUnits, uint256 minimumDeliveredInAssetUnits, uint8 poolDecimals)
  {
    poolDecimals = oft.sharedDecimals();

    uint256 quantityInAssetUnits = AssetUnitConversions.pipsToAssetUnits(quantity, poolDecimals);
    SendParam memory sendParam = _getSendParamForEstimation(
      destinationEndpointId,
      minimumQuantityMultiplier,
      quantityInAssetUnits
    );
    (, , OFTReceipt memory receipt) = oft.quoteOFT(sendParam);

    estimatedDeliveredQuantityInAssetUnits = receipt.amountReceivedLD;
    minimumDeliveredInAssetUnits = (quantityInAssetUnits * minimumQuantityMultiplier) / Constants.PIP_PRICE_MULTIPLIER;
  }

  /**
   * @notice Load current gas fee for send to each target endpoint ID specified in argument array
   *
   * @param destinationEndpointIds An array of LayerZero Endpoint IDs
   */
  function loadSendGasFeesInAssetUnits(
    uint32[] memory destinationEndpointIds,
    uint64 minimumQuantityMultiplier,
    IOFT oft
  ) internal view returns (uint256[] memory gasFeesInAssetUnits) {
    gasFeesInAssetUnits = new uint256[](destinationEndpointIds.length);

    for (uint256 i = 0; i < destinationEndpointIds.length; i++) {
      SendParam memory sendParam = _getSendParamForEstimation(
        destinationEndpointIds[i],
        minimumQuantityMultiplier,
        100000000 // The actual quantity does not affect the gas fee
      );

      MessagingFee memory messagingFee = oft.quoteSend(sendParam, false);
      gasFeesInAssetUnits[i] = messagingFee.nativeFee;
    }
  }

  /**
   * @notice Load current gas fee for send and compose to target endpoint ID
   *
   * @param destinationEndpointId A LayerZero Endpoint ID
   */
  function loadSendAndComposeGasFeeInAssetUnits(
    uint128 composeGasLimit,
    bytes memory composeMsg,
    uint32 destinationEndpointId,
    uint64 minimumQuantityMultiplier,
    IOFT oft
  ) internal view returns (uint256) {
    SendParam memory sendParam = _getSendParamForEstimation(
      composeGasLimit,
      composeMsg,
      destinationEndpointId,
      minimumQuantityMultiplier,
      100000000 // The actual quantity does not affect the gas fee
    );

    MessagingFee memory messagingFee = oft.quoteSend(sendParam, false);
    return messagingFee.nativeFee;
  }

  function _getSendParamForEstimation(
    uint32 destinationEndpointId,
    uint64 minimumQuantityMultiplier,
    uint256 quantityInAssetUnits
  ) private view returns (SendParam memory) {
    return
      // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
      SendParam({
        dstEid: destinationEndpointId,
        to: OFTComposeMsgCodec.addressToBytes32(address(this)), // The actual to address does not affect the result
        amountLD: quantityInAssetUnits,
        minAmountLD: (quantityInAssetUnits * minimumQuantityMultiplier) / Constants.PIP_PRICE_MULTIPLIER,
        extraOptions: bytes(""),
        composeMsg: bytes(""), // No compose
        oftCmd: bytes("") // Taxi mode
      });
  }

  function _getSendParamForEstimation(
    uint128 composeGasLimit,
    bytes memory composeMsg,
    uint32 destinationEndpointId,
    uint64 minimumQuantityMultiplier,
    uint256 quantityInAssetUnits
  ) private view returns (SendParam memory) {
    return
      // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
      SendParam({
        dstEid: destinationEndpointId,
        to: OFTComposeMsgCodec.addressToBytes32(address(this)), // The actual to address does not affect the result
        amountLD: quantityInAssetUnits,
        minAmountLD: (quantityInAssetUnits * minimumQuantityMultiplier) / Constants.PIP_PRICE_MULTIPLIER,
        extraOptions: OptionsBuilder.newOptions().addExecutorLzComposeOption(0, composeGasLimit, 0),
        composeMsg: composeMsg,
        oftCmd: bytes("") // Taxi mode
      });
  }
}
