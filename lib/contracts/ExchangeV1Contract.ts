import { ethers } from 'ethers';

import { Exchange_v1__factory } from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type { Exchange_v1 } from '../../typechain-types';

export default class ExchangeContract extends BaseContract<Exchange_v1> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      Exchange_v1__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<Exchange_v1__factory['deploy']>,
    libraryAddresses: {
      balanceLoading: string;
      closureDeleveraging: string;
      depositing: string;
      exitFund: string;
      funding: string;
      indexPriceMargin: string;
      managedAccounts: string;
      marketAdmin: string;
      nonceInvalidations: string;
      oraclePriceMargin: string;
      positionBelowMinimumLiquidation: string;
      positionInDeactivatedMarketLiquidation: string;
      trading: string;
      transferring: string;
      walletExitAcquisitionDeleveraging: string;
      walletExitLiquidation: string;
      walletInMaintenanceAcquisitionDeleveraging: string;
      walletInMaintenanceLiquidation: string;
      withdrawing: string;
    },
    ownerWalletPrivateKey: string,
  ): Promise<ExchangeContract> {
    const linkLibraryAddresses: ConstructorParameters<
      typeof Exchange_v1__factory
    >[0] = {
      'contracts/libraries/BalanceLoading.sol:BalanceLoading':
        libraryAddresses.balanceLoading,
      'contracts/libraries/ClosureDeleveraging.sol:ClosureDeleveraging':
        libraryAddresses.closureDeleveraging,
      'contracts/libraries/Depositing.sol:Depositing':
        libraryAddresses.depositing,
      'contracts/libraries/ExitFund.sol:ExitFund': libraryAddresses.exitFund,
      'contracts/libraries/Funding.sol:Funding': libraryAddresses.funding,
      'contracts/libraries/IndexPriceMargin.sol:IndexPriceMargin':
        libraryAddresses.indexPriceMargin,
      'contracts/libraries/ManagedAccounts.sol:ManagedAccounts':
        libraryAddresses.managedAccounts,
      'contracts/libraries/MarketAdmin.sol:MarketAdmin':
        libraryAddresses.marketAdmin,
      'contracts/libraries/NonceInvalidations.sol:NonceInvalidations':
        libraryAddresses.nonceInvalidations,
      'contracts/libraries/OraclePriceMargin.sol:OraclePriceMargin':
        libraryAddresses.oraclePriceMargin,
      'contracts/libraries/PositionBelowMinimumLiquidation.sol:PositionBelowMinimumLiquidation':
        libraryAddresses.positionBelowMinimumLiquidation,
      'contracts/libraries/PositionInDeactivatedMarketLiquidation.sol:PositionInDeactivatedMarketLiquidation':
        libraryAddresses.positionInDeactivatedMarketLiquidation,
      'contracts/libraries/Trading.sol:Trading': libraryAddresses.trading,
      'contracts/libraries/Transferring.sol:Transferring':
        libraryAddresses.transferring,
      'contracts/libraries/WalletExitAcquisitionDeleveraging.sol:WalletExitAcquisitionDeleveraging':
        libraryAddresses.walletExitAcquisitionDeleveraging,
      'contracts/libraries/WalletExitLiquidation.sol:WalletExitLiquidation':
        libraryAddresses.walletExitLiquidation,
      'contracts/libraries/WalletInMaintenanceAcquisitionDeleveraging.sol:WalletInMaintenanceAcquisitionDeleveraging':
        libraryAddresses.walletInMaintenanceAcquisitionDeleveraging,
      'contracts/libraries/WalletInMaintenanceLiquidation.sol:WalletInMaintenanceLiquidation':
        libraryAddresses.walletInMaintenanceLiquidation,
      'contracts/libraries/Withdrawing.sol:Withdrawing':
        libraryAddresses.withdrawing,
    };

    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract = await new Exchange_v1__factory(
      linkLibraryAddresses,
      owner,
    ).deploy(...args);

    return new this(
      await (await utils.waitForDeployment(contract)).getAddress(),
    );
  }

  public getEthersContract(): Exchange_v1 {
    return this.contract;
  }
}
