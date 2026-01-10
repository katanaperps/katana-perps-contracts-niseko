import { ethers } from 'ethers';

import { RedStoneIndexPriceAdapter__factory } from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type { RedStoneIndexPriceAdapter } from '../../typechain-types';

export default class RedStoneIndexPriceAdapterContract extends BaseContract<RedStoneIndexPriceAdapter> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      RedStoneIndexPriceAdapter__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<RedStoneIndexPriceAdapter__factory['deploy']>,
    ownerWalletPrivateKey: string,
  ): Promise<RedStoneIndexPriceAdapterContract> {
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract = await new RedStoneIndexPriceAdapter__factory(owner).deploy(
      ...args,
    );

    return new this(await (await contract.waitForDeployment()).getAddress());
  }

  public getEthersContract(): RedStoneIndexPriceAdapter {
    return this.contract;
  }
}
