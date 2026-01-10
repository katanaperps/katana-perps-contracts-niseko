import fs from 'fs';
import path from 'path';

import { ethers } from 'ethers';

import ChainlinkAggregator from './ChainlinkAggregator';
import ChainlinkDataStreamsIndexPriceAdapterContract from './ChainlinkDataStreamsIndexPriceAdapterContract';
import CustodianContract from './CustodianContract';
import EarningsEscrowContract from './EarningsEscrow';
import ExchangeV1Contract from './ExchangeV1Contract';
import ExchangeWalletStateAggregatorContract from './ExchangeWalletStateAggregatorContract';
import GovernanceContract from './GovernanceContract';
import KatanaPerpsIndexAndOraclePriceAdapterContract from './KatanaPerpsIndexAndOraclePriceAdapterContract';
import RedStoneIndexPriceAdapterContract from './RedStoneIndexPriceAdapterContract';
import USDCContract from './USDCContract';
import { initRpcApi, loadProvider } from './utils';

export {
  initRpcApi,
  loadProvider,
  ChainlinkAggregator,
  ChainlinkDataStreamsIndexPriceAdapterContract,
  CustodianContract,
  EarningsEscrowContract,
  ExchangeV1Contract,
  ExchangeWalletStateAggregatorContract,
  GovernanceContract,
  KatanaPerpsIndexAndOraclePriceAdapterContract,
  RedStoneIndexPriceAdapterContract,
  USDCContract,
};

export type LibraryName =
  | 'BalanceLoading'
  | 'ClosureDeleveraging'
  | 'Depositing'
  | 'ExitFund'
  | 'Funding'
  | 'IndexPriceMargin'
  | 'ManagedAccounts'
  | 'MarketAdmin'
  | 'NonceInvalidations'
  | 'OraclePriceMargin'
  | 'PositionBelowMinimumLiquidation'
  | 'PositionInDeactivatedMarketLiquidation'
  | 'Trading'
  | 'Transferring'
  | 'WalletExitAcquisitionDeleveraging'
  | 'WalletExitLiquidation'
  | 'WalletInMaintenanceAcquisitionDeleveraging'
  | 'WalletInMaintenanceLiquidation'
  | 'Withdrawing';

export async function deployLibrary(
  name: LibraryName,
  ownerWalletPrivateKey: string,
): Promise<string> {
  const bytecode = loadLibraryBytecode(name);
  const owner = new ethers.Wallet(ownerWalletPrivateKey, loadProvider());
  const library = await new ethers.ContractFactory(
    [],
    bytecode,
    owner,
  ).deploy();

  return (await library.waitForDeployment()).getAddress();
}

const libraryNameToBytecodeMap = new Map<LibraryName, string>();

function loadLibraryBytecode(name: LibraryName): string {
  if (!libraryNameToBytecodeMap.has(name)) {
    const pathSegments = [
      __dirname,
      '..',
      '..',
      '..',
      'artifacts',
      'contracts',
      'libraries',
      `${name}.sol`,
      `${name}.json`,
    ];

    const { bytecode } = JSON.parse(
      fs.readFileSync(path.join(...pathSegments)).toString('utf8'),
    );
    libraryNameToBytecodeMap.set(name, bytecode);
  }
  return libraryNameToBytecodeMap.get(name) as string; // Will never be undefined as it gets set above
}
