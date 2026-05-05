import { ethers } from 'ethers';

import { ExchangeLayerZeroAdapter_v1__factory } from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type { ExchangeLayerZeroAdapter_v1 } from '../../typechain-types';

export default class ExchangeLayerZeroAdapterV1Contract extends BaseContract<ExchangeLayerZeroAdapter_v1> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      ExchangeLayerZeroAdapter_v1__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<ExchangeLayerZeroAdapter_v1__factory['deploy']>,
    libraryAddresses: {
      exchangeAdapterComposing: string;
    },
    ownerWalletPrivateKey: string,
  ): Promise<ExchangeLayerZeroAdapterV1Contract> {
    const linkLibraryAddresses: ConstructorParameters<
      typeof ExchangeLayerZeroAdapter_v1__factory
    >[0] = {
      'contracts/bridge-adapters/libraries/ExchangeAdapterComposing_v1.sol:ExchangeAdapterComposing_v1':
        libraryAddresses.exchangeAdapterComposing,
    };
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract = await new ExchangeLayerZeroAdapter_v1__factory(
      linkLibraryAddresses,
      owner,
    ).deploy(...args);

    return new this(
      await (await utils.waitForDeployment(contract)).getAddress(),
    );
  }

  public getEthersContract(): ExchangeLayerZeroAdapter_v1 {
    return this.contract;
  }
}
