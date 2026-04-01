import { ethers } from 'ethers';

import { ChainlinkDataStreamsIndexAndOraclePriceAdapter__factory } from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type { ChainlinkDataStreamsIndexAndOraclePriceAdapter } from '../../typechain-types';

export default class ChainlinkDataStreamsIndexAndOraclePriceAdapterContract extends BaseContract<ChainlinkDataStreamsIndexAndOraclePriceAdapter> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      ChainlinkDataStreamsIndexAndOraclePriceAdapter__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<ChainlinkDataStreamsIndexAndOraclePriceAdapter__factory['deploy']>,
    ownerWalletPrivateKey: string,
  ): Promise<ChainlinkDataStreamsIndexAndOraclePriceAdapterContract> {
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract =
      await new ChainlinkDataStreamsIndexAndOraclePriceAdapter__factory(
        owner,
      ).deploy(...args);

    return new this(
      await (await utils.waitForDeployment(contract)).getAddress(),
    );
  }

  public getEthersContract(): ChainlinkDataStreamsIndexAndOraclePriceAdapter {
    return this.contract;
  }
}
