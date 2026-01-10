// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { OrderSide } from "./Enums.sol";

contract ExchangeEvents {
  /**
   * @notice Emitted when an admin changes the Chain Propagation Period tunable parameter with
   * `setChainPropagationPeriod`
   */
  event ChainPropagationPeriodChanged(uint256 previousValue, uint256 newValue);
  /**
   * @notice Emitted when an admin changes the Delegated Key Expiration Period tunable parameter with
   * `setDelegatedKeyExpirationPeriod`
   */
  event DelegateKeyExpirationPeriodChanged(uint256 previousValue, uint256 newValue);
  /**
   * @notice Emitted when the Dispatcher Wallet submits an exited wallet position deleverage with
   * `deleverageExitAcquisition`
   */
  event DeleveragedExitAcquisition(
    string baseAssetSymbol,
    address counterpartyWallet,
    address liquidatingWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits an Exit Fund closure deleverage with `deleverageExitFundClosure`
   */
  event DeleveragedExitFundClosure(
    string baseAssetSymbol,
    address counterpartyWallet,
    address exitFundWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits a wallet in maintenance deleverage with
   * `deleverageInMaintenanceAcquisition`
   */
  event DeleveragedInMaintenanceAcquisition(
    string baseAssetSymbol,
    address counterpartyWallet,
    address liquidatingWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits an Insurance Fund closure deleverage with
   * `deleverageInsuranceFundClosure`
   */
  event DeleveragedInsuranceFundClosure(
    string baseAssetSymbol,
    address counterpartyWallet,
    address insuranceFundWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when a user deposits quote tokens with `deposit` or `depositToManagedAccount`
   */
  event Deposited(
    uint64 index,
    address sourceWallet,
    address depositorWallet,
    uint64 quantity,
    bool isAssociatedWithManagedAccount
  );
  /**
   * @notice Emitted when an admin disables deposits with `setDepositEnabled`
   */
  event DepositsDisabled();
  /**
   * @notice Emitted when an admin enables deposits with `setDepositEnabled`
   */
  event DepositsEnabled();
  /**
   * @notice Emitted when an admin changes the Dispatcher Wallet tunable parameter with `setDispatcher` or clears it
   * with `removeDispatcher`
   */
  event DispatcherChanged(address previousValue, address newValue);
  /**
   * @notice Emitted when an admin changes the Exit Fund Wallet tunable parameter with `setExitFundWallet`
   */
  event ExitFundWalletChanged(address previousValue, address newValue);
  /**
   * @notice Emitted when an admin changes the Fee Wallet tunable parameter with `setFeeWallet`
   */
  event FeeWalletChanged(address previousValue, address newValue);
  /**
   * @notice Emitted when the Dispatcher Wallet publishes a new funding rate with `publishFundingMutiplier`
   */
  event FundingRatePublished(string baseAssetSymbol, int64 fundingRate);
  /**
   * @notice Emitted when the Dispatcher Wallet publishes a new index price with `publishIndexPrices`
   */
  event IndexPricePublished(string baseAssetSymbol, uint64 timestampInMs, uint64 price);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a position below minimum liquidation with
   * `liquidatePositionBelowMinimum`
   */
  event LiquidatedPositionBelowMinimum(
    string baseAssetSymbol,
    address liquidatingWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits a position in deactivated market liquidation with
   * `liquidatePositionInDeactivatedMarket`
   */
  event LiquidatedPositionInDeactivatedMarket(
    string baseAssetSymbol,
    address liquidatingWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits an exited wallet liquidation with `liquidateWalletExit`
   */
  event LiquidatedWalletExit(address liquidatingWallet);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a wallet in maintenance liquidation with
   * `liquidateWalletInMaintenance`
   */
  event LiquidatedWalletInMaintenance(address liquidatingWallet);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a wallet in maintenance liquidation during system recovery with
   * `liquidateWalletInMaintenanceDuringSystemRecovery`
   */
  event LiquidatedWalletInMaintenanceDuringSystemRecovery(address liquidatingWallet);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a trade for execution with `executeTrade` and one of the orders
   * has the `isLiquidationAcquisitionOnly` asserted
   */
  event LiquidationAcquisitionExecuted(
    address buyWallet,
    address sellWallet,
    string baseAssetSymbol,
    string quoteAssetSymbol,
    uint64 baseQuantity,
    uint64 quoteQuantity,
    OrderSide makerSide,
    int64 makerFeeQuantity,
    uint64 takerFeeQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet activates a previously added market with `activateMarket`
   */
  event MarketActivated(string baseAssetSymbol);
  /**
   * @notice Emitted when admin adds a new market with `addMarket`
   */
  event MarketAdded(string baseAssetSymbol);
  /**
   * @notice Emitted when the Dispatcher Wallet deactivates a previously activated market with `deactivateMarket`
   */
  event MarketDeactivated(string baseAssetSymbol);
  /**
   * @notice Emitted when an admin or the Dispatcher Wallet unsets market overrides with `unsetMarketOverridesForWallet`
   */
  event MarketOverridesUnset(string baseAssetSymbol, address wallet);
  /**
   * @notice Emitted when a user invalidates an order nonce with `invalidateNonce`
   */
  event OrderNonceInvalidated(address wallet, uint128 nonce, uint128 timestampInMs, uint256 effectiveBlockTimestamp);
  /**
   * @notice Emitted when pending deposit quantity is applied via `applyPendingDepositsForWallet`
   */
  event PendingDepositApplied(
    address wallet,
    uint64 quantity,
    int64 newExchangeBalance,
    bool isAssociatedWithManagedAccount
  );
  /**
   * @notice Emitted when an admin changes the position below minimum liquidation price tolerance tunable parameter
   * with `setPositionBelowMinimumLiquidationPriceToleranceMultiplier`
   */
  event PositionBelowMinimumLiquidationPriceToleranceMultiplierChanged(uint256 previousValue, uint256 newValue);
  /**
   * @notice Emitted when an admin changes the quote token address with `setQuoteTokenAddress`
   */
  event QuoteTokenAddressChanged(address previousValue, address newValue);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a trade for execution with `executeTrade`
   */
  event TradeExecuted(
    address buyWallet,
    address sellWallet,
    string baseAssetSymbol,
    string quoteAssetSymbol,
    uint64 baseQuantity,
    uint64 quoteQuantity,
    OrderSide makerSide,
    int64 makerFeeQuantity,
    uint64 takerFeeQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits a transfer with `transfer`
   */
  event Transferred(
    address destinationWallet,
    address sourceWallet,
    uint64 quantity,
    int64 newDestinationWalletExchangeBalance,
    int64 newSourceWalletExchangeBalance
  );
  /**
   * @notice Emitted when a user clears the exited status of a wallet previously exited with
   * `clearWalletExit`
   */
  event WalletExitCleared(address wallet);
  /**
   * @notice Emitted when a user invokes the Exit Wallet mechanism with `exitWallet`
   */
  event WalletExited(address wallet, uint256 effectiveBlockTimestamp, bool isAssociatedWithManagedAccount);
  /**
   * @notice Emitted when a user withdraws available quote token balance through the Exit Wallet mechanism with
   * `withdrawExitFromManagedAccount`
   */
  event WalletExitFromManagedAccountWithdrawn(address managerWallet, address depositorWallet, uint64 quantity);
  /**
   * @notice Emitted when a user withdraws available quote token balance through the Exit Wallet mechanism with
   * `withdrawExit`
   */
  event WalletExitWithdrawn(address wallet, uint64 quantity);
  /**
   * @notice Emitted when the Dispatcher Wallet cancels a withdrawal with `cancelPendingWithdrawalFromManagedAccount`
   */
  event WithdrawalFromManagedAccountCanceled(address wallet, uint64 quantity, int64 newExchangeBalance);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a withdrawal with `withdraw` or `applyPendingWithdrawalFromManagedAccount`
   */
  event Withdrawn(address wallet, uint64 quantity, int64 newExchangeBalance, bool isAssociatedWithManagedAccount);
}
