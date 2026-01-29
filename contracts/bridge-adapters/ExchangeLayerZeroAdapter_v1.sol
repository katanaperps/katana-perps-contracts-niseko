// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILayerZeroComposer } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroComposer.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IOFT, MessagingFee, SendParam } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";

import { Address } from "../libraries/Address.sol";
import { BridgeAdapterEvents } from "./libraries/BridgeAdapterEvents.sol";
import { Constants } from "../libraries/Constants.sol";
import { ExchangeAdapterComposing_v1 } from "./libraries/ExchangeAdapterComposing_v1.sol";
import { IExchange } from "../libraries/Interfaces.sol";
import { KatanaPerpsStargateForwarderComposing_v1 } from "./libraries/KatanaPerpsStargateForwarderComposing_v1.sol";
import { LayerZeroFeeEstimation } from "./LayerZeroFeeEstimation.sol";

// solhint-disable-next-line contract-name-capwords
contract ExchangeLayerZeroAdapter_v1 is BridgeAdapterEvents, ILayerZeroComposer, Ownable2Step {
  // Quote asset quantity paid to Fee Wallet when creating a Managed Account
  uint64 public addManagedAccountDepositFeeQuantityInAssetUnits;
  // Native asset quantity to air drop Manager Wallet when creating a Managed Account
  uint64 public addManagedAccountManagerWalletNativeDropQuantity;
  // Quote asset quantity paid to Fee Wallet when depositing to a Managed Account
  uint64 public depositToManagedAccountFeeQuantityInAssetUnits;
  // Must be true or `lzCompose` will revert
  bool public isDepositEnabled;
  // Must be true or `withdrawQuoteAsset` will revert
  bool public isWithdrawEnabled;
  // Minimum quantity of quote asset required as initial deposit in order to create a Managed Account
  uint64 public minimumAddManagedAccountDepositQuantityInAssetUnits;
  // Minimum quantity of quote asset required to deposit to a Managed Account
  uint64 public minimumDepositToManagedAccountQuantityInAssetUnits;
  // Multiplier in pips used to calculate minimum withdraw quantity after slippage
  uint64 public minimumWithdrawQuantityMultiplier;
  // Address of the Stargate Forwarder contract on Ethereum
  address public stargateForwarder;

  // Immutable constants //

  // LayerZero endpoint ID for Ethereum
  uint32 public immutable ethereumEndpointId;
  // Address of Exchange contract
  IExchange public immutable exchange;
  // Address of LayerZero endpoint contract that will call `lzCompose` when triggered by off-chain executor
  address public immutable lzEndpoint;
  // Local OFT contract used to send tokens by `withdrawQuoteAsset`
  IOFT public immutable oft;
  // Address of ERC-20 contract used as collateral and quote for all markets
  IERC20 public immutable quoteAsset;

  uint64 public constant MAX_MINIMUM_WITHDRAW_QUANTITY_MULTIPLIER = 100_000_000; // 100%
  uint64 public constant MIN_MINIMUM_WITHDRAW_QUANTITY_MULTIPLIER = 90_000_000; // 90%

  modifier onlyExchangeOrManagedAccountProvider() {
    bool senderIsExchangeOrManagedAccountProvider = msg.sender == address(exchange);

    if (!senderIsExchangeOrManagedAccountProvider) {
      for (uint8 i = 0; i < exchange.loadManagedAccountProvidersLength(); i++) {
        if (msg.sender == address(exchange.loadManagedAccountProvider(i))) {
          senderIsExchangeOrManagedAccountProvider = true;
          break;
        }
      }
    }

    require(senderIsExchangeOrManagedAccountProvider, "Caller must be Exchange or Managed Account provider contract");
    _;
  }

  /**
   * @notice Instantiate a new `ExchangeLayerZeroAdapter_v3` contract
   */
  constructor(
    uint64 addManagedAccountDepositFeeQuantityInAssetUnits_,
    uint64 addManagedAccountManagerWalletNativeDropQuantity_,
    uint32 ethereumEndpointId_,
    uint64 depositToManagedAccountFeeQuantityInAssetUnits_,
    address exchange_,
    address lzEndpoint_,
    uint64 minimumAddManagedAccountDepositQuantityInAssetUnits_,
    uint64 minimumDepositToManagedAccountQuantityInAssetUnits_,
    uint64 minimumWithdrawQuantityMultiplier_,
    address oft_
  ) Ownable(msg.sender) {
    ethereumEndpointId = ethereumEndpointId_;

    require(Address.isContract(exchange_), "Invalid Exchange address");
    exchange = IExchange(exchange_);

    require(Address.isContract(lzEndpoint_), "Invalid LZ Endpoint address");
    lzEndpoint = lzEndpoint_;

    require(Address.isContract(oft_), "Invalid OFT address");
    oft = IOFT(oft_);

    require(oft.token() == exchange.quoteTokenAddress(), "Quote asset address does not match OFT");
    quoteAsset = IERC20(exchange.quoteTokenAddress());

    setComposeParameters(
      addManagedAccountDepositFeeQuantityInAssetUnits_,
      addManagedAccountManagerWalletNativeDropQuantity_,
      depositToManagedAccountFeeQuantityInAssetUnits_,
      minimumAddManagedAccountDepositQuantityInAssetUnits_,
      minimumDepositToManagedAccountQuantityInAssetUnits_,
      minimumWithdrawQuantityMultiplier_
    );

    IERC20(quoteAsset).approve(exchange_, type(uint256).max);
    IERC20(quoteAsset).approve(oft_, type(uint256).max);
  }

  /**
   * @notice Allow incoming native asset to fund contract for gas fees, as well as incoming gas fee refunds
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
    require(_from == address(oft), "OApp must be OFT");

    // Parse out composed message
    bytes memory composeMessage = OFTComposeMsgCodec.composeMsg(_message);
    // Parse out quote quantity delivered
    uint256 amountLD = OFTComposeMsgCodec.amountLD(_message);

    try
      ExchangeAdapterComposing_v1.compose_delegatecall(
        amountLD,
        composeMessage,
        addManagedAccountDepositFeeQuantityInAssetUnits,
        addManagedAccountManagerWalletNativeDropQuantity,
        depositToManagedAccountFeeQuantityInAssetUnits,
        exchange,
        isDepositEnabled,
        minimumAddManagedAccountDepositQuantityInAssetUnits,
        minimumDepositToManagedAccountQuantityInAssetUnits,
        owner()
      )
    {} catch (bytes memory errorData) {
      ExchangeAdapterComposing_v1.fallbackToTransferAndEmitComposeFailedEvent(owner(), exchange, amountLD, errorData);
    }
  }

  /*
   * @notice Set tunable compose parameters
   */
  function setComposeParameters(
    uint64 addManagedAccountDepositFeeQuantityInAssetUnits_,
    uint64 addManagedAccountManagerWalletNativeDropQuantity_,
    uint64 depositToManagedAccountFeeQuantityInAssetUnits_,
    uint64 minimumAddManagedAccountDepositQuantityInAssetUnits_,
    uint64 minimumDepositToManagedAccountQuantityInAssetUnits_,
    uint64 minimumWithdrawQuantityMultiplier_
  ) public onlyOwner {
    // MA creation deposit fee should not exceed the deposit minimum as this may cause an underflow
    // when computing the net deposit. The fee can equal the minimum, in which case the MA creation
    // can still succeed albeit without an initial deposit quantity
    require(
      addManagedAccountDepositFeeQuantityInAssetUnits_ <= minimumAddManagedAccountDepositQuantityInAssetUnits_,
      "Add MA deposit fee exceeds minimum"
    );
    // MA deposit fee should be strictly less than the deposit minimum. Unlike MA creation deposits
    // a zero net MA deposit quantity is not a valid use case as it is a no-op
    require(
      depositToManagedAccountFeeQuantityInAssetUnits_ < minimumDepositToManagedAccountQuantityInAssetUnits_,
      "Deposit to MA fee must be less than minimum"
    );

    addManagedAccountDepositFeeQuantityInAssetUnits = addManagedAccountDepositFeeQuantityInAssetUnits_;
    addManagedAccountManagerWalletNativeDropQuantity = addManagedAccountManagerWalletNativeDropQuantity_;
    depositToManagedAccountFeeQuantityInAssetUnits = depositToManagedAccountFeeQuantityInAssetUnits_;
    minimumAddManagedAccountDepositQuantityInAssetUnits = minimumAddManagedAccountDepositQuantityInAssetUnits_;
    minimumDepositToManagedAccountQuantityInAssetUnits = minimumDepositToManagedAccountQuantityInAssetUnits_;
    minimumWithdrawQuantityMultiplier = minimumWithdrawQuantityMultiplier_;
  }

  /**
   * @notice Set the address of the Stargate Forwarder contract. Can only be called once
   */
  function setStargateForwarder(address stargateForwarder_) public onlyOwner {
    require(stargateForwarder == address(0x0), "Stargate Forwarder can only be set once");
    // We cannot check that the address is a contract since it resides on a remote chain

    stargateForwarder = stargateForwarder_;
  }

  /**
   * @notice Allow Owner wallet to withdraw gas fee funding
   */
  function withdrawNativeAsset(address payable destinationContractOrWallet, uint256 quantity) public onlyOwner {
    (bool success, ) = destinationContractOrWallet.call{ value: quantity }("");
    require(success, "Native asset transfer failed");
  }

  /**
   * @dev quantity is in asset units
   */
  function withdrawQuoteAsset(
    address depositorWallet,
    uint256 quantity,
    bytes memory payload
  ) public onlyExchangeOrManagedAccountProvider {
    if (!isWithdrawEnabled) {
      return
        ExchangeAdapterComposing_v1.fallbackToDepositAndEmitWithdrawFailedEvent(
          depositorWallet,
          exchange,
          quantity,
          payload,
          "Withdraw disabled"
        );
    }

    SendParam memory sendParam = _getSendParamForWithdraw(depositorWallet, quantity, payload);

    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = oft.quoteSend(sendParam, false);

    // solhint-disable-next-line check-send-result
    try oft.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this))) {} catch (
      bytes memory errorData
    ) {
      // If the OFT send fails, redeposit funds into Exchange so wallet can retry
      ExchangeAdapterComposing_v1.fallbackToDepositAndEmitWithdrawFailedEvent(
        depositorWallet,
        exchange,
        quantity,
        payload,
        errorData
      );
    }
  }

  /**
   * @notice Enable or disable deposits via `lzCompose`
   */
  function setDepositEnabled(bool isEnabled) public onlyOwner {
    isDepositEnabled = isEnabled;
  }

  /**
   * @notice Sets the tolerance for the minimum token quantity delivered on the remote chain after slippage
   *
   * @param newMinimumWithdrawQuantityMultiplier the tolerance for the minimum token quantity delivered on the
   * remote chain after slippage as a multiplier in pips of the local quantity sent
   */
  function setMinimumWithdrawQuantityMultiplier(uint64 newMinimumWithdrawQuantityMultiplier) public onlyOwner {
    require(
      newMinimumWithdrawQuantityMultiplier <= MAX_MINIMUM_WITHDRAW_QUANTITY_MULTIPLIER &&
        newMinimumWithdrawQuantityMultiplier >= MIN_MINIMUM_WITHDRAW_QUANTITY_MULTIPLIER,
      "New value out of range"
    );
    minimumWithdrawQuantityMultiplier = newMinimumWithdrawQuantityMultiplier;
  }

  /**
   * @notice Enable or disable withdrawals via `withdrawQuoteAsset`
   */
  function setWithdrawEnabled(bool isEnabled) public onlyOwner {
    isWithdrawEnabled = isEnabled;
  }

  /**
   * @notice Estimate actual quantity of quote tokens that will be delivered on target chain after pool fees
   *
   * @dev quantity is in pips since this function is used in conjunction with the off-chain SDK and REST API
   */
  function estimateWithdrawQuantityInAssetUnits(
    uint32 destinationEndpointId,
    uint64 quantity
  )
    public
    view
    returns (
      uint256 estimatedWithdrawQuantityInAssetUnits,
      uint256 minimumWithdrawQuantityInAssetUnits,
      uint8 poolDecimals
    )
  {
    return
      LayerZeroFeeEstimation.loadEstimatedDeliveredQuantityInAssetUnits(
        destinationEndpointId,
        minimumWithdrawQuantityMultiplier,
        oft,
        quantity
      );
  }

  /**
   * @notice Load current gas fees for withdrawing to Ethereum
   */
  function loadEthereumWithdrawalGasFeeInAssetUnits() public view returns (uint256) {
    uint32[] memory destinationEndpointIds = new uint32[](1);
    destinationEndpointIds[0] = ethereumEndpointId;

    return
      LayerZeroFeeEstimation.loadGasFeesInAssetUnits(
        abi.encode(
          KatanaPerpsStargateForwarderComposing_v1.ComposeMessageType.WithdrawFromKatana,
          // The encoded destination endpoint and wallet values do not matter for estimation purposes
          KatanaPerpsStargateForwarderComposing_v1.WithdrawFromKatana(ethereumEndpointId, address(this))
        ),
        destinationEndpointIds,
        minimumWithdrawQuantityMultiplier,
        oft
      )[0];
  }

  function _getSendParamForWithdraw(
    address depositorWallet,
    uint256 quantityInAssetUnits,
    bytes memory payload
  ) private view returns (SendParam memory) {
    uint32 destinationEndpointId = abi.decode(payload, (uint32));

    // Withdrawing to Stargate Forwarder contract on Ethereum
    return
      SendParam({
        dstEid: ethereumEndpointId,
        to: OFTComposeMsgCodec.addressToBytes32(stargateForwarder),
        amountLD: quantityInAssetUnits,
        minAmountLD: (quantityInAssetUnits * minimumWithdrawQuantityMultiplier) / Constants.PIP_PRICE_MULTIPLIER,
        extraOptions: bytes(""), // No extra native asset needed
        composeMsg: abi.encode(
          KatanaPerpsStargateForwarderComposing_v1.ComposeMessageType.WithdrawFromKatana,
          KatanaPerpsStargateForwarderComposing_v1.WithdrawFromKatana(destinationEndpointId, depositorWallet)
        ),
        oftCmd: bytes("") // Taxi mode
      });
  }
}
