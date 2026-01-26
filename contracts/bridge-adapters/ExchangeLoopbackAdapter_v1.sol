// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { Address } from "../libraries/Address.sol";
import { BridgeAdapterEvents } from "./libraries/BridgeAdapterEvents.sol";
import { ExchangeAdapterComposing_v1 } from "./libraries/ExchangeAdapterComposing_v1.sol";
import { IExchange } from "../libraries/Interfaces.sol";

// solhint-disable-next-line contract-name-capwords
interface IExchangeLayerZeroAdapter_v3 {
  function addManagedAccountDepositFeeQuantityInAssetUnits() external returns (uint64);
  function addManagedAccountManagerWalletNativeDropQuantity() external returns (uint64);
  function minimumAddManagedAccountDepositQuantityInAssetUnits() external returns (uint64);
  function minimumDepositToManagedAccountQuantityInAssetUnits() external returns (uint64);
}

// solhint-disable-next-line contract-name-capwords
contract ExchangeLoopbackAdapter_v1 is BridgeAdapterEvents, Ownable2Step {
  // Must be true or `withdrawQuoteAsset` will revert
  bool public isWithdrawEnabled;

  // Immutable constants //

  // Address of Exchange contract
  IExchange public immutable exchange;
  // Address of ExchangeLayerZeroAdapter_v3 contract
  IExchangeLayerZeroAdapter_v3 public immutable exchangeLayerZeroAdapter;
  // Address of ERC-20 contract used as collateral and quote for all markets
  IERC20 public immutable quoteAsset;

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
   * @notice Instantiate a new `ExchangeLoopbackAdapter_v1` contract
   */
  constructor(address exchange_, address exchangeLayerZeroAdapter_) Ownable(msg.sender) {
    require(Address.isContract(exchange_), "Invalid Exchange address");
    exchange = IExchange(exchange_);

    require(Address.isContract(exchangeLayerZeroAdapter_), "Invalid ExchangeLayerZeroAdapter_v3 address");
    exchangeLayerZeroAdapter = IExchangeLayerZeroAdapter_v3(exchangeLayerZeroAdapter_);

    quoteAsset = IERC20(exchange.quoteTokenAddress());

    IERC20(quoteAsset).approve(exchange_, type(uint256).max);
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
      ExchangeAdapterComposing_v1.fallbackToDepositAndEmitWithdrawFailedEvent(
        depositorWallet,
        exchange,
        quantity,
        payload,
        "Withdraw disabled"
      );

      return;
    }

    try
      ExchangeAdapterComposing_v1.composeForLoopback_delegatecall(
        depositorWallet,
        quantity,
        payload,
        exchangeLayerZeroAdapter.addManagedAccountDepositFeeQuantityInAssetUnits(),
        exchangeLayerZeroAdapter.addManagedAccountManagerWalletNativeDropQuantity(),
        // To avoid double-charging fees for both withdrawal and subsequent deposit, coerce the
        // deposit fee to zero
        0,
        exchange,
        exchangeLayerZeroAdapter.minimumAddManagedAccountDepositQuantityInAssetUnits(),
        exchangeLayerZeroAdapter.minimumDepositToManagedAccountQuantityInAssetUnits(),
        owner()
      )
    {} catch (bytes memory errorData) {
      ExchangeAdapterComposing_v1.fallbackToDepositAndEmitWithdrawFailedEvent(
        // The depositor wallet is explicitly provided by the Exchange so funds can safely be
        // returned to this wallet upon unexpected reversion
        depositorWallet,
        exchange,
        quantity,
        payload,
        errorData
      );
    }
  }

  /**
   * @notice Enable or disable withdrawals via `withdrawQuoteAsset`
   */
  function setWithdrawEnabled(bool isEnabled) public onlyOwner {
    isWithdrawEnabled = isEnabled;
  }
}
