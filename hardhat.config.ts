import * as dotenv from 'dotenv';

import '@typechain/hardhat';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-chai-matchers';
import '@nomicfoundation/hardhat-verify';
import 'hardhat-contract-sizer';
import 'solidity-coverage';
import type { HardhatUserConfig } from 'hardhat/config';

dotenv.config();

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

// Later versions of Solidity produce significantly larger contract sizes,
// possibly due to the changing of the default Yul sequence although adding
// back the earlier sequence via compiler options does not seem to help
// https://github.com/ethereum/solidity/commit/54ab398a44143fce6f63502f533c651f4d080bae
const SOLC_VERSION = '0.8.25';

const solidity = {
  compilers: [
    {
      version: SOLC_VERSION,
      settings: {
        optimizer: {
          enabled: true,
          runs: 1000000,
        },
        viaIR: true,
      },
    },
  ],
  overrides: {
    'contracts/Exchange_v1.sol': {
      version: SOLC_VERSION,
      settings: {
        optimizer: {
          enabled: true,
          runs: 1,
        },
        viaIR: true,
      },
    },
    'contracts/Governance.sol': {
      version: SOLC_VERSION,
      settings: {
        optimizer: {
          enabled: true,
          runs: 40000,
        },
        viaIR: true,
      },
    },
    'contracts/libraries/ManagedAccounts.sol': {
      version: SOLC_VERSION,
      settings: {
        optimizer: {
          enabled: true,
          runs: 500,
        },
        viaIR: true,
      },
    },
    'contracts/libraries/Trading.sol': {
      version: SOLC_VERSION,
      settings: {
        optimizer: {
          enabled: true,
          runs: 20000,
        },
        viaIR: true,
      },
    },
  },
};

const config: HardhatUserConfig = {
  solidity,
  mocha: {
    timeout: 100000000,
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: !!process.env.COVERAGE,
    },
    bokutoTestnet: {
      chainId: 737373,
      url: 'https://rpc-bokuto.katanarpc.com',
    },
    katanaMainnet: {
      chainId: 747474,
      url: 'https://rpc.katanarpc.com',
    },
  },
  etherscan: {
    apiKey: {
      bokutoTestnet: 'abc',
      katanaMainnet: 'abc',
    },
    customChains: [
      {
        network: 'bokutoTestnet',
        chainId: 737373,
        urls: {
          apiURL: 'https://explorer-bokuto.katanarpc.com/api',
          browserURL: 'https://explorer-bokuto.katanarpc.com/',
        },
      },
      {
        network: 'katanaMainnet',
        chainId: 747474,
        urls: {
          apiURL: 'https://explorer.katanarpc.com/api',
          browserURL: 'https://explorer.katanarpc.com/',
        },
      },
    ],
  },
};

export default config;
