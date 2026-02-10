// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { BridgeAdapterEvents } from "./BridgeAdapterEvents.sol";
import { IExchange, IManagedAccountProvider } from "../../libraries/Interfaces.sol";

/**
 * @dev External library that implements deposit logic from bridge adapters to the Exchange. The
 * motivation to keep this logic in an external library is primarily to allow wrapping it in a
 * try/catch block so that funds can be safely returned in the case of an unexpected reversion, and
 * secondarily to keep the calling contracts' bytecode size within limits
 */
// solhint-disable-next-line contract-name-capwords
library ExchangeAdapterComposing_v1 {
  enum PayloadType {
    AddManagedAccount,
    DepositToManagedAccount,
    DepositToWallet
  }

  struct AddManagedAccount {
    uint32 sourceEndpointId;
    IManagedAccountProvider managedAccountProvider;
    address managerWallet;
    bytes addManagedAccountPayload;
    bytes depositPayload;
  }

  struct DepositToManagedAccount {
    uint32 sourceEndpointId;
    address depositorWallet;
    IManagedAccountProvider managedAccountProvider;
    address managerWallet;
    bytes depositPayload;
  }

  struct DepositToWallet {
    uint32 sourceEndpointId;
    address depositorWallet;
  }

  // solhint-disable-next-line func-name-mixedcase
  function composeForLoopback_delegatecall(
    // External arguments
    address depositorWallet,
    uint256 quoteAssetQuantityInAssetUnits,
    bytes calldata payload,
    // State values
    uint64 addManagedAccountDepositFeeQuantityInAssetUnits,
    uint64 addManagedAccountManagerWalletNativeDropQuantity,
    uint64 depositToManagedAccountFeeQuantityInAssetUnits,
    IExchange exchange,
    uint64 minimumAddManagedAccountDepositQuantityInAssetUnits,
    uint64 minimumDepositToManagedAccountQuantityInAssetUnits,
    address ownerWallet
  ) public {
    if (_getDepositorWalletFromLoopbackPayload(payload) != depositorWallet) {
      // This function is called during a withdrawal to the Loopback Adapter, so emit a
      // WithdrawQuoteAssetFailed event on errors
      fallbackToDepositAndEmitWithdrawFailedEvent(
        depositorWallet,
        exchange,
        quoteAssetQuantityInAssetUnits,
        payload,
        "Destination wallet does not match payload"
      );

      return;
    }

    compose(
      quoteAssetQuantityInAssetUnits,
      payload,
      addManagedAccountDepositFeeQuantityInAssetUnits,
      addManagedAccountManagerWalletNativeDropQuantity,
      depositToManagedAccountFeeQuantityInAssetUnits,
      exchange,
      true, // Always enabled
      minimumAddManagedAccountDepositQuantityInAssetUnits,
      minimumDepositToManagedAccountQuantityInAssetUnits,
      ownerWallet
    );
  }

  // solhint-disable-next-line func-name-mixedcase
  function compose_delegatecall(
    // External arguments
    uint256 quoteAssetQuantityInAssetUnits,
    bytes calldata payload,
    // State values
    uint64 addManagedAccountDepositFeeQuantityInAssetUnits,
    uint64 addManagedAccountManagerWalletNativeDropQuantity,
    uint64 depositToManagedAccountFeeQuantityInAssetUnits,
    IExchange exchange,
    bool isDepositEnabled,
    uint64 minimumAddManagedAccountDepositQuantityInAssetUnits,
    uint64 minimumDepositToManagedAccountQuantityInAssetUnits,
    address ownerWallet
  ) public {
    compose(
      quoteAssetQuantityInAssetUnits,
      payload,
      addManagedAccountDepositFeeQuantityInAssetUnits,
      addManagedAccountManagerWalletNativeDropQuantity,
      depositToManagedAccountFeeQuantityInAssetUnits,
      exchange,
      isDepositEnabled,
      minimumAddManagedAccountDepositQuantityInAssetUnits,
      minimumDepositToManagedAccountQuantityInAssetUnits,
      ownerWallet
    );
  }

  function compose(
    // External arguments
    uint256 quoteAssetQuantityInAssetUnits,
    bytes calldata payload,
    // State values
    uint64 addManagedAccountDepositFeeQuantityInAssetUnits,
    uint64 addManagedAccountManagerWalletNativeDropQuantity,
    uint64 depositToManagedAccountFeeQuantityInAssetUnits,
    IExchange exchange,
    bool isDepositEnabled,
    uint64 minimumAddManagedAccountDepositQuantityInAssetUnits,
    uint64 minimumDepositToManagedAccountQuantityInAssetUnits,
    address ownerWallet
  ) public {
    // The first field in the compose message indicates the type of payload that follows it
    PayloadType payloadType = abi.decode(payload, (PayloadType));

    if (payloadType == PayloadType.AddManagedAccount) {
      return
        _addManagedAccount(
          quoteAssetQuantityInAssetUnits,
          payload,
          addManagedAccountDepositFeeQuantityInAssetUnits,
          addManagedAccountManagerWalletNativeDropQuantity,
          exchange,
          isDepositEnabled,
          minimumAddManagedAccountDepositQuantityInAssetUnits,
          ownerWallet
        );
    } else if (payloadType == PayloadType.DepositToManagedAccount) {
      return
        _depositToManagedAccount(
          quoteAssetQuantityInAssetUnits,
          payload,
          depositToManagedAccountFeeQuantityInAssetUnits,
          exchange,
          isDepositEnabled,
          minimumDepositToManagedAccountQuantityInAssetUnits,
          ownerWallet
        );
    }

    // If the payloadType value is not included in the enum then abi.decode will revert without a
    // reason string, so we can safely assume the final enum value below
    _depositToWallet(quoteAssetQuantityInAssetUnits, payload, exchange, isDepositEnabled, ownerWallet);
  }

  /**
   * @dev Attempts to deposit to Exchange. If deposit fails, falls back to IERC20 transfer and emits
   * ComposeFailed event
   *
   * @return true if deposit to Exchange succeeded, false otherwise
   */
  function depositWithTransferFallback(
    address depositorWallet,
    IExchange exchange,
    uint256 quoteAssetQuantityInAssetUnits
  ) internal returns (bool) {
    if (quoteAssetQuantityInAssetUnits == 0) {
      return true;
    }

    try exchange.deposit(quoteAssetQuantityInAssetUnits, depositorWallet) {} catch (bytes memory errorData) {
      IERC20(exchange.quoteTokenAddress()).transfer(depositorWallet, quoteAssetQuantityInAssetUnits);
      emit BridgeAdapterEvents.ComposeFailed(depositorWallet, quoteAssetQuantityInAssetUnits, errorData);

      return false;
    }

    return true;
  }

  /*
   * @dev If the compose fails during withdrawal, re-deposit funds into Exchange so wallet can
   * retry. If deposit fails, falls back to IERC20 transfer. Emits WithdrawQuoteAssetFailed in
   * either case
   */
  function fallbackToDepositAndEmitWithdrawFailedEvent(
    address depositorWallet,
    IExchange exchange,
    uint256 quoteAssetQuantityInAssetUnits,
    bytes memory payload,
    bytes memory errorData
  ) internal {
    try exchange.deposit(quoteAssetQuantityInAssetUnits, depositorWallet) {
      emit BridgeAdapterEvents.WithdrawQuoteAssetFailed(
        depositorWallet,
        quoteAssetQuantityInAssetUnits,
        payload,
        errorData
      );
    } catch (bytes memory depositErrorData) {
      IERC20(exchange.quoteTokenAddress()).transfer(depositorWallet, quoteAssetQuantityInAssetUnits);
      emit BridgeAdapterEvents.WithdrawQuoteAssetFailed(
        depositorWallet,
        quoteAssetQuantityInAssetUnits,
        payload,
        depositErrorData
      );
    }
  }

  /*
   * @dev If the compose fails during MA add account or deposit, deposit funds into Exchange. If
   * deposit fails, falls back to IERC20 transfer. Emits ComposeFailed in either case
   */
  function fallbackToDepositAndEmitComposeFailedEvent(
    address depositorWallet,
    IExchange exchange,
    uint256 quoteAssetQuantityInAssetUnits,
    bytes memory errorData
  ) internal {
    try exchange.deposit(quoteAssetQuantityInAssetUnits, depositorWallet) {
      emit BridgeAdapterEvents.ComposeFailed(depositorWallet, quoteAssetQuantityInAssetUnits, errorData);
    } catch (bytes memory depositErrorData) {
      IERC20(exchange.quoteTokenAddress()).transfer(depositorWallet, quoteAssetQuantityInAssetUnits);
      emit BridgeAdapterEvents.ComposeFailed(depositorWallet, quoteAssetQuantityInAssetUnits, depositErrorData);
    }
  }

  /*
   * @dev If the compose fails during MA add account or deposit and funds cannot be deposited into
   * the exchange, fall back to IERC20 transfer and emit ComposeFailed
   */
  function fallbackToTransferAndEmitComposeFailedEvent(
    address depositorWallet,
    IExchange exchange,
    uint256 quoteAssetQuantityInAssetUnits,
    bytes memory errorData
  ) internal {
    IERC20(exchange.quoteTokenAddress()).transfer(depositorWallet, quoteAssetQuantityInAssetUnits);
    emit BridgeAdapterEvents.ComposeFailed(depositorWallet, quoteAssetQuantityInAssetUnits, errorData);
  }

  function _addManagedAccount(
    // External arguments
    uint256 quoteAssetQuantityInAssetUnits,
    bytes memory payload,
    // State values
    uint64 addManagedAccountDepositFeeQuantityInAssetUnits,
    uint64 addManagedAccountManagerWalletNativeDropQuantity,
    IExchange exchange,
    bool isDepositEnabled,
    uint64 minimumAddManagedAccountDepositQuantityInAssetUnits,
    address ownerWallet
  ) private {
    // Decode payload
    (, AddManagedAccount memory addManagedAccount) = abi.decode(payload, (PayloadType, AddManagedAccount));

    // To avoid loss of funds, transfer tokens to owner wallet if manager wallet is invalid
    if (addManagedAccount.managerWallet == address(0x0)) {
      return
        fallbackToTransferAndEmitComposeFailedEvent(
          ownerWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          "Invalid manager wallet"
        );
    }
    // Transfer tokens directly to depositor if deposits are disabled in bridge adapter
    if (!isDepositEnabled) {
      return
        fallbackToTransferAndEmitComposeFailedEvent(
          addManagedAccount.managerWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          "Deposits disabled"
        );
    }
    // EF can not manage an MA nor receive deposits, transfer tokens to EF in this case
    if (addManagedAccount.managerWallet == exchange.exitFundWallet()) {
      return
        fallbackToTransferAndEmitComposeFailedEvent(
          addManagedAccount.managerWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          "Manager wallet cannot be EF"
        );
    }
    // Deposit tokens to manager wallet on Exchange if initial deposit quantity is below minimum
    if (quoteAssetQuantityInAssetUnits < minimumAddManagedAccountDepositQuantityInAssetUnits) {
      return
        fallbackToDepositAndEmitComposeFailedEvent(
          addManagedAccount.managerWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          "Initial deposit below minimum"
        );
    }

    // Create Managed Account
    try
      addManagedAccount.managedAccountProvider.addManagedAccount(
        addManagedAccount.managerWallet,
        addManagedAccount.addManagedAccountPayload
      )
    {} catch (bytes memory errorData) {
      return
        fallbackToDepositAndEmitComposeFailedEvent(
          addManagedAccount.managerWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          errorData
        );
    }

    // Deposit initial deposit quantity minus fee to Managed Account provider
    uint256 initialDepositQuantityInAssetUnits = quoteAssetQuantityInAssetUnits -
      addManagedAccountDepositFeeQuantityInAssetUnits;
    if (initialDepositQuantityInAssetUnits > 0) {
      try
        exchange.depositToManagedAccount(
          initialDepositQuantityInAssetUnits,
          addManagedAccount.managerWallet,
          addManagedAccount.managedAccountProvider,
          addManagedAccount.depositPayload,
          addManagedAccount.managerWallet
        )
      {
        // Emit success event
        emit BridgeAdapterEvents.ComposeSucceeded(
          addManagedAccount.sourceEndpointId,
          addManagedAccount.managerWallet,
          initialDepositQuantityInAssetUnits
        );
      } catch (bytes memory errorData) {
        // Since the vault has already been created, the initial deposit cannot be deposited directly to the manager
        // wallet. Instead, transfer funds to manager wallet
        return
          fallbackToTransferAndEmitComposeFailedEvent(
            addManagedAccount.managerWallet,
            exchange,
            quoteAssetQuantityInAssetUnits,
            errorData
          );
      }
    }

    // Deposit fee quantity to fee wallet on Exchange
    depositWithTransferFallback(exchange.feeWallet(), exchange, addManagedAccountDepositFeeQuantityInAssetUnits);

    // Drop native asset to manager wallet
    if (addManagedAccountManagerWalletNativeDropQuantity > 0) {
      (bool success, ) = addManagedAccount.managerWallet.call{
        value: addManagedAccountManagerWalletNativeDropQuantity
      }("");
      if (!success) {
        emit BridgeAdapterEvents.ComposeFailed(
          addManagedAccount.managerWallet,
          quoteAssetQuantityInAssetUnits,
          "Native asset transfer failed"
        );
      }
    }
  }

  function _depositToManagedAccount(
    // External arguments
    uint256 quoteAssetQuantityInAssetUnits,
    bytes memory payload,
    // State values
    uint64 depositToManagedAccountFeeQuantityInAssetUnits,
    IExchange exchange,
    bool isDepositEnabled,
    uint64 minimumDepositToManagedAccountQuantityInAssetUnits,
    address ownerWallet
  ) private {
    (, DepositToManagedAccount memory depositToManagedAccount) = abi.decode(
      payload,
      (PayloadType, DepositToManagedAccount)
    );

    // To avoid loss of funds, transfer tokens to owner wallet if depositor wallet is invalid
    if (depositToManagedAccount.depositorWallet == address(0x0)) {
      return
        fallbackToTransferAndEmitComposeFailedEvent(
          ownerWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          "Invalid depositor wallet"
        );
    }
    // Transfer tokens directly to depositor if deposits are disabled in bridge adapter
    if (!isDepositEnabled) {
      return
        fallbackToTransferAndEmitComposeFailedEvent(
          depositToManagedAccount.depositorWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          "Deposits disabled"
        );
    }
    // EF can not deposit to MA, transfer tokens to EF in this case
    if (depositToManagedAccount.depositorWallet == exchange.exitFundWallet()) {
      return
        fallbackToTransferAndEmitComposeFailedEvent(
          depositToManagedAccount.depositorWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          "Depositor cannot be EF"
        );
    }
    // Deposit tokens to depositor on Exchange if deposit quantity is below minimum
    if (quoteAssetQuantityInAssetUnits < minimumDepositToManagedAccountQuantityInAssetUnits) {
      return
        fallbackToDepositAndEmitComposeFailedEvent(
          depositToManagedAccount.depositorWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          "Deposit quantity below minimum"
        );
    }

    // Deposit total quantity minus fee to Managed Account Provider. The calling Bridge Adapter
    // contract validates that the fee is less than the minimum, so the below will not underflow
    uint256 netDepositQuantityInAssetUnits = quoteAssetQuantityInAssetUnits -
      depositToManagedAccountFeeQuantityInAssetUnits;
    try
      exchange.depositToManagedAccount(
        netDepositQuantityInAssetUnits,
        depositToManagedAccount.depositorWallet,
        depositToManagedAccount.managedAccountProvider,
        depositToManagedAccount.depositPayload,
        depositToManagedAccount.managerWallet
      )
    {
      // Emit success event
      emit BridgeAdapterEvents.ComposeSucceeded(
        depositToManagedAccount.sourceEndpointId,
        depositToManagedAccount.depositorWallet,
        netDepositQuantityInAssetUnits
      );
    } catch (bytes memory errorData) {
      return
        fallbackToDepositAndEmitComposeFailedEvent(
          depositToManagedAccount.depositorWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          errorData
        );
    }

    // Deposit fee quantity to fee wallet on Exchange
    depositWithTransferFallback(exchange.feeWallet(), exchange, depositToManagedAccountFeeQuantityInAssetUnits);
  }

  function _depositToWallet(
    // External arguments
    uint256 quoteAssetQuantityInAssetUnits,
    bytes memory payload,
    // State values
    IExchange exchange,
    bool isDepositEnabled,
    address ownerWallet
  ) private {
    (, DepositToWallet memory depositToWallet) = abi.decode(payload, (PayloadType, DepositToWallet));

    // To avoid loss of funds, transfer tokens to owner wallet if depositor wallet is invalid
    if (depositToWallet.depositorWallet == address(0x0)) {
      return
        fallbackToTransferAndEmitComposeFailedEvent(
          ownerWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          "Invalid depositor wallet"
        );
    }
    // Transfer tokens directly to depositor if deposits are disabled in bridge adapter
    if (!isDepositEnabled) {
      return
        fallbackToTransferAndEmitComposeFailedEvent(
          depositToWallet.depositorWallet,
          exchange,
          quoteAssetQuantityInAssetUnits,
          "Deposits disabled"
        );
    }

    if (depositWithTransferFallback(depositToWallet.depositorWallet, exchange, quoteAssetQuantityInAssetUnits)) {
      // Emit success event
      emit BridgeAdapterEvents.ComposeSucceeded(
        depositToWallet.sourceEndpointId,
        depositToWallet.depositorWallet,
        quoteAssetQuantityInAssetUnits
      );
    }
  }

  function _getDepositorWalletFromLoopbackPayload(bytes memory payload) private pure returns (address depositorWallet) {
    depositorWallet = address(0x0);
    // The first field in the compose message indicates the type of payload that follows it
    PayloadType payloadType = abi.decode(payload, (PayloadType));

    if (payloadType == PayloadType.DepositToManagedAccount) {
      (, DepositToManagedAccount memory depositToManagedAccount) = abi.decode(
        payload,
        (PayloadType, DepositToManagedAccount)
      );
      depositorWallet = depositToManagedAccount.depositorWallet;
    } else if (payloadType == PayloadType.DepositToWallet) {
      (, DepositToWallet memory depositToWallet) = abi.decode(payload, (PayloadType, DepositToWallet));
      depositorWallet = depositToWallet.depositorWallet;
    }
    // Add to managed account payloads are not supported by the loopback adapter
  }
}
