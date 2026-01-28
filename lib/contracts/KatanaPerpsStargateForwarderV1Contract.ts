import { ethers } from 'ethers';

import { KatanaPerpsStargateForwarder_v1__factory } from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type { KatanaPerpsStargateForwarder_v1 } from '../../typechain-types';

export default class KatanaPerpsStargateForwarderV1Contract extends BaseContract<KatanaPerpsStargateForwarder_v1> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      KatanaPerpsStargateForwarder_v1__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<KatanaPerpsStargateForwarder_v1__factory['deploy']>,
    libraryAddresses: {
      katanaPerpsStargateForwarderComposing: string;
    },
    ownerWalletPrivateKey: string,
  ): Promise<KatanaPerpsStargateForwarderV1Contract> {
    const linkLibraryAddresses: ConstructorParameters<
      typeof KatanaPerpsStargateForwarder_v1__factory
    >[0] = {
      'contracts/bridge-adapters/libraries/KatanaPerpsStargateForwarderComposing_v1.sol:KatanaPerpsStargateForwarderComposing_v1':
        libraryAddresses.katanaPerpsStargateForwarderComposing,
    };
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract = await new KatanaPerpsStargateForwarder_v1__factory(
      linkLibraryAddresses,
      owner,
    ).deploy(...args);

    return new this(await (await contract.waitForDeployment()).getAddress());
  }

  public getEthersContract(): KatanaPerpsStargateForwarder_v1 {
    return this.contract;
  }
}
