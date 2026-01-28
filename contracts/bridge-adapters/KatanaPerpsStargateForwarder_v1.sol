// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ILayerZeroComposer } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroComposer.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IOFT } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";
import { KatanaPerpsStargateForwarderComposing_v1 } from "./libraries/KatanaPerpsStargateForwarderComposing_v1.sol";

import { Address } from "../libraries/Address.sol";
import { LayerZeroFeeEstimation } from "./LayerZeroFeeEstimation.sol";

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol
// https://github.com/stargate-protocol/stargate-v2/blob/main/packages/stg-evm-v2/src/interfaces/IStargate.sol#L22
// We are not using any Stargate-specific extensions to the IOFT interface, so they are omitted from the
// interface declared below
interface IStargate is IOFT {}

// solhint-disable-next-line contract-name-capwords
contract KatanaPerpsStargateForwarder_v1 is ILayerZeroComposer, Ownable2Step {
  // 99.999999%
  uint64 public constant MAX_MULTIPLIER = 99999999;

  // 0.000001%
  uint64 public constant MIN_MULTIPLIER = 1;

  // Remote address of contract on Katana that will be ultimate recipient of ComposeMessageType.DepositToKatana
  // messages and allowed to compose with ComposeMessageType.WithdrawFromKatana messages
  address public immutable exchangeLayerZeroAdapter;
  // LayerZero endpoint ID for Katana, used to correctly route deposits
  uint32 public immutable katanaEndpointId;
  // Address of LayerZero endpoint contract that will call `lzCompose` when triggered by off-chain executor
  address public immutable lzEndpoint;
  // Multiplier in pips used to calculate minimum forwarded quantity after slippage
  uint64 public minimumForwardQuantityMultiplier;
  // Multiplier in pips used to calculate minimum native drop quantity included in compose compared to actual fee
  uint64 public minimumDepositNativeDropQuantityMultiplier;
  // Stargate pool used to bridge tokens between the local chain and remote destination chains
  IStargate public immutable stargate;
  // Local address of USDC ERC-20 contract that will be forwarded to and from remote chains via Stargate
  IERC20 public immutable usdc;
  // Local address of vbUSDC ERC-4626 contract that will be forwarded to and from Katana via OFT adapter
  IERC4626 public immutable vbUSDC;
  // The local OFT adapter contract used to bridge USDC to and from Katana
  IOFT public immutable vbUSDCOFTAdapter;

  event ForwardFailed(address destinationWallet, uint256 quantity, bytes payload, bytes errorData);

  /**
   * @notice Instantiate a new `KatanaPerpsStargateForwarder_v1` contract
   */
  constructor(
    address exchangeLayerZeroAdapter_,
    uint32 katanaEndpointId_,
    address lzEndpoint_,
    uint64 minimumDepositNativeDropQuantityMultiplier_,
    uint64 minimumForwardQuantityMultiplier_,
    address stargate_,
    address usdc_,
    address vbUSDC_,
    address vbUSDCOFTAdapter_
  ) Ownable(msg.sender) {
    // We cannot use Address.isContract here since exchangeLayerZeroAdapter is on a remote chain
    require(exchangeLayerZeroAdapter_ != address(0x0), "Invalid Bridge Adapter address");
    exchangeLayerZeroAdapter = exchangeLayerZeroAdapter_;

    require(katanaEndpointId_ != 0, "Invalid Katana LZ Endpoint ID");
    katanaEndpointId = katanaEndpointId_;

    require(Address.isContract(lzEndpoint_), "Invalid LZ Endpoint address");
    lzEndpoint = lzEndpoint_;

    setMinimumDepositNativeDropQuantityMultiplier(minimumDepositNativeDropQuantityMultiplier_);
    setMinimumForwardQuantityMultiplier(minimumForwardQuantityMultiplier_);

    require(Address.isContract(stargate_), "Invalid Stargate address");
    stargate = IStargate(stargate_);

    require(Address.isContract(usdc_), "Invalid USDC token address");
    require(IOFT(stargate_).token() == usdc_, "USDC token address does not match Stargate");
    usdc = IERC20(usdc_);

    require(Address.isContract(vbUSDCOFTAdapter_), "Invalid OFT address");
    vbUSDCOFTAdapter = IOFT(vbUSDCOFTAdapter_);

    require(Address.isContract(vbUSDC_), "Invalid vbUSDC token address");
    require(IOFT(vbUSDCOFTAdapter_).token() == vbUSDC_, "vbUSDC token address does not match OFT Adapter");
    vbUSDC = IERC4626(vbUSDC_);

    // Pre-approve Stargate and vbUSDC contracts to allow unlimited USDC transfers
    usdc.approve(address(stargate), type(uint256).max);
    usdc.approve(address(vbUSDC), type(uint256).max);

    // Pre-approve vbUSDC OFT Adapter to allow unlimited vbUSDC transfers
    vbUSDC.approve(address(vbUSDCOFTAdapter_), type(uint256).max);
    // No need to approve vbUSDC to itself for redeem calls, since both the owner and sender will
    // be this contract
  }

  /**
   * @notice Allow incoming native asset to fund contract for send fees
   */
  receive() external payable {}

  /**
   * @notice Composes a LayerZero message from an OApp.
   * @param _from The address initiating the composition, typically the OApp where the lzReceive was called.
   * param _guid The unique identifier for the corresponding LayerZero src/dst tx.
   * @param _message The composed message payload in bytes. NOT necessarily the same payload passed via lzReceive.
   * param _executor The address of the executor for the composed message.
   * param _extraData Additional arbitrary data in bytes passed by the entity who executes the lzCompose.
   */
  function lzCompose(
    address _from,
    bytes32 /* _guid */,
    bytes calldata _message,
    address /* _executor */,
    bytes calldata /* _extraData */
  ) public payable override {
    require(msg.sender == lzEndpoint, "Caller must be LZ Endpoint");
    uint256 amountLD = OFTComposeMsgCodec.amountLD(_message);

    try
      KatanaPerpsStargateForwarderComposing_v1.compose(
        amountLD,
        _from,
        _message,
        exchangeLayerZeroAdapter,
        katanaEndpointId,
        minimumDepositNativeDropQuantityMultiplier,
        minimumForwardQuantityMultiplier,
        stargate,
        usdc,
        vbUSDC,
        vbUSDCOFTAdapter
      )
    {} catch (bytes memory errorData) {
      if (OFTComposeMsgCodec.srcEid(_message) == katanaEndpointId) {
        // Withdrawals from Katana will always be vbUSDC
        vbUSDC.transfer(owner(), amountLD);
      } else {
        // Deposits to Katana will always be USDC via Stargate
        usdc.transfer(owner(), amountLD);
      }
      emit ForwardFailed(address(0x0), amountLD, _message, errorData);
    }
  }

  /**
   * @notice Sets the tolerance for an insufficient native drop to cover gas fees when forwarding deposits to Katana
   *
   * @param newMinimumDepositNativeDropQuantityMultiplier The tolerance for an insufficient native drop as a multiplier
   * in pips of the required quantity
   */
  function setMinimumDepositNativeDropQuantityMultiplier(
    uint64 newMinimumDepositNativeDropQuantityMultiplier
  ) public onlyOwner {
    require(
      newMinimumDepositNativeDropQuantityMultiplier >= MIN_MULTIPLIER &&
        newMinimumDepositNativeDropQuantityMultiplier <= MAX_MULTIPLIER,
      "Value out of bounds"
    );

    minimumDepositNativeDropQuantityMultiplier = newMinimumDepositNativeDropQuantityMultiplier;
  }

  /**
   * @notice Sets the tolerance for the minimum token quantity delivered on the remote chain after slippage
   *
   * @param newMinimumForwardQuantityMultiplier the tolerance for the minimum token quantity delivered on the remote
   * chain after slippage as a multiplier in pips of the local quantity sent
   */
  function setMinimumForwardQuantityMultiplier(uint64 newMinimumForwardQuantityMultiplier) public onlyOwner {
    require(
      newMinimumForwardQuantityMultiplier >= MIN_MULTIPLIER && newMinimumForwardQuantityMultiplier <= MAX_MULTIPLIER,
      "Value out of bounds"
    );

    minimumForwardQuantityMultiplier = newMinimumForwardQuantityMultiplier;
  }

  /**
   * @notice Allow Owner wallet to withdraw send fee funding
   */
  function withdrawNativeAsset(address payable destinationWallet, uint256 quantity) public onlyOwner {
    destinationWallet.transfer(quantity);
  }

  /**
   * @notice Estimate actual quantity of USDC that will be delivered on target chain after pool fees
   *
   * @dev quantity is in pips since this function is used in conjunction with the off-chain SDK and REST API
   */
  function loadEstimatedForwardedQuantityInAssetUnits(
    uint32 destinationEndpointId,
    uint64 quantity
  )
    public
    view
    returns (
      uint256 estimatedForwardedQuantityInAssetUnits,
      uint256 minimumForwardedQuantityInAssetUnits,
      uint8 poolDecimals
    )
  {
    IOFT oft = destinationEndpointId == katanaEndpointId ? vbUSDCOFTAdapter : stargate;

    return
      LayerZeroFeeEstimation.loadEstimatedDeliveredQuantityInAssetUnits(
        destinationEndpointId,
        minimumForwardQuantityMultiplier,
        oft,
        quantity
      );
  }

  /**
   * @notice Load current gas fee for depositing to Katana
   */
  function loadDepositGasFeeInAssetUnits() public view returns (uint256 gasFeeInAssetUnits) {
    uint32[] memory destinationEndpointIds = new uint32[](1);
    destinationEndpointIds[0] = katanaEndpointId;

    return
      LayerZeroFeeEstimation.loadGasFeesInAssetUnits(
        // Deposits include an enforced gas fee for composing on the Katana bridge adapter
        abi.encode(katanaEndpointId, address(this)),
        destinationEndpointIds,
        minimumForwardQuantityMultiplier,
        vbUSDCOFTAdapter
      )[0];
  }

  /**
   * @notice Load current gas fee for each target endpoint ID specified in argument array
   *
   * @param destinationEndpointIds An array of LayerZero Endpoint IDs
   */
  function loadWithdrawalGasFeesInAssetUnits(
    uint32[] calldata destinationEndpointIds
  ) public view returns (uint256[] memory gasFeesInAssetUnits) {
    return
      LayerZeroFeeEstimation.loadGasFeesInAssetUnits(
        bytes(""), // Compose not supported for withdrawals
        destinationEndpointIds,
        minimumForwardQuantityMultiplier,
        stargate
      );
  }
}
