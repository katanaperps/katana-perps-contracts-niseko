import fs from 'fs';
import path from 'path';

import { ethers } from 'ethers';

import ChainlinkAggregator from './ChainlinkAggregator';
import ChainlinkDataStreamsIndexAndOraclePriceAdapterContract from './ChainlinkDataStreamsIndexAndOraclePriceAdapterContract';
import ChainlinkDataStreamsIndexPriceAdapterContract from './ChainlinkDataStreamsIndexPriceAdapterContract';
import ChainlinkDataStreamsVerifierMockContract from './ChainlinkDataStreamsVerifierMockContract';
import CustodianContract from './CustodianContract';
import EarningsEscrowContract from './EarningsEscrow';
import ExchangeLayerZeroAdapterV1Contract from './ExchangeLayerZeroAdapterV1Contract';
import ExchangeV1Contract from './ExchangeV1Contract';
import ExchangeWalletStateAggregatorContract from './ExchangeWalletStateAggregatorContract';
import GovernanceContract from './GovernanceContract';
import KatanaPerpsIndexAndOraclePriceAdapterContract from './KatanaPerpsIndexAndOraclePriceAdapterContract';
import KatanaPerpsStargateForwarderV1Contract from './KatanaPerpsStargateForwarderV1Contract';
import RedStoneIndexPriceAdapterContract from './RedStoneIndexPriceAdapterContract';
import USDCContract from './USDCContract';
import { initRpcApi, loadProvider, waitForDeployment } from './utils';

export {
  initRpcApi,
  loadProvider,
  waitForDeployment,
  ChainlinkAggregator,
  ChainlinkDataStreamsIndexAndOraclePriceAdapterContract,
  ChainlinkDataStreamsIndexPriceAdapterContract,
  ChainlinkDataStreamsVerifierMockContract,
  CustodianContract,
  EarningsEscrowContract,
  ExchangeLayerZeroAdapterV1Contract,
  ExchangeV1Contract,
  ExchangeWalletStateAggregatorContract,
  GovernanceContract,
  KatanaPerpsIndexAndOraclePriceAdapterContract,
  KatanaPerpsStargateForwarderV1Contract,
  RedStoneIndexPriceAdapterContract,
  USDCContract,
};

export type BridgeAdapterLibraryName =
  | 'ExchangeAdapterComposing_v1'
  | 'KatanaPerpsStargateForwarderComposing_v1';

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
  name: BridgeAdapterLibraryName | LibraryName,
  ownerWalletPrivateKey: string,
): Promise<string> {
  const bytecode = loadLibraryBytecode(name);
  const owner = new ethers.Wallet(ownerWalletPrivateKey, loadProvider());
  const library = await new ethers.ContractFactory(
    [],
    bytecode,
    owner,
  ).deploy();

  return (await waitForDeployment(library)).getAddress();
}

const libraryNameToBytecodeMap = new Map<
  BridgeAdapterLibraryName | LibraryName,
  string
>();

function loadLibraryBytecode(
  name: LibraryName | BridgeAdapterLibraryName,
): string {
  if (!libraryNameToBytecodeMap.has(name)) {
    let pathSegments = [__dirname, '..', '..', '..', 'artifacts', 'contracts'];

    if (isBridgeAdapterLibraryName(name)) {
      pathSegments = pathSegments.concat(['bridge-adapters', 'libraries']);
    } else {
      pathSegments = pathSegments.concat(['libraries']);
    }

    pathSegments = pathSegments.concat([`${name}.sol`, `${name}.json`]);
    const { bytecode } = JSON.parse(
      fs.readFileSync(path.join(...pathSegments)).toString('utf8'),
    );
    libraryNameToBytecodeMap.set(name, bytecode);
  }
  return libraryNameToBytecodeMap.get(name) as string; // Will never be undefined as it gets set above
}

function isBridgeAdapterLibraryName(
  libraryName: unknown,
): libraryName is BridgeAdapterLibraryName {
  return (
    !!libraryName &&
    (libraryName === 'ExchangeAdapterComposing_v1' ||
      libraryName === 'KatanaPerpsStargateForwarderComposing_v1')
  );
}
