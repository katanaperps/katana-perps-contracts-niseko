import { ethers } from 'ethers';

import { ChainlinkDataStreamsIndexPriceAdapter__factory } from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type { ChainlinkDataStreamsIndexPriceAdapter } from '../../typechain-types';

export default class ChainlinkDataStreamsIndexPriceAdapterContract extends BaseContract<ChainlinkDataStreamsIndexPriceAdapter> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      ChainlinkDataStreamsIndexPriceAdapter__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<ChainlinkDataStreamsIndexPriceAdapter__factory['deploy']>,
    ownerWalletPrivateKey: string,
  ): Promise<ChainlinkDataStreamsIndexPriceAdapterContract> {
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract = await new ChainlinkDataStreamsIndexPriceAdapter__factory(
      owner,
    ).deploy(...args);

    return new this(
      await (await utils.waitForDeployment(contract)).getAddress(),
    );
  }

  public getEthersContract(): ChainlinkDataStreamsIndexPriceAdapter {
    return this.contract;
  }
}
