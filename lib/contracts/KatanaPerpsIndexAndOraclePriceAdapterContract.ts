import { ethers } from 'ethers';

import { KatanaPerpsIndexAndOraclePriceAdapter__factory } from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type { KatanaPerpsIndexAndOraclePriceAdapter } from '../../typechain-types';

export default class KatanaPerpsIndexAndOraclePriceAdapterContract extends BaseContract<KatanaPerpsIndexAndOraclePriceAdapter> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      KatanaPerpsIndexAndOraclePriceAdapter__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<KatanaPerpsIndexAndOraclePriceAdapter__factory['deploy']>,
    ownerWalletPrivateKey: string,
  ): Promise<KatanaPerpsIndexAndOraclePriceAdapterContract> {
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract = await new KatanaPerpsIndexAndOraclePriceAdapter__factory(
      owner,
    ).deploy(...args);

    return new this(await (await contract.waitForDeployment()).getAddress());
  }

  public getEthersContract(): KatanaPerpsIndexAndOraclePriceAdapter {
    return this.contract;
  }
}
