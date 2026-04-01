import { ethers } from 'ethers';

import { ChainlinkDataStreamsVerifierMock__factory } from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type { ChainlinkDataStreamsVerifierMock } from '../../typechain-types';

export default class ChainlinkDataStreamsVerifierMockContract extends BaseContract<ChainlinkDataStreamsVerifierMock> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      ChainlinkDataStreamsVerifierMock__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    ownerWalletPrivateKey: string,
  ): Promise<ChainlinkDataStreamsVerifierMockContract> {
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract =
      await new ChainlinkDataStreamsVerifierMock__factory(owner).deploy();

    return new this(await (await contract.waitForDeployment()).getAddress());
  }

  public getEthersContract(): ChainlinkDataStreamsVerifierMock {
    return this.contract;
  }
}
