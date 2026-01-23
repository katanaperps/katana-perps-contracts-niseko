import { DataPackagesWrapper } from '@redstone-finance/evm-connector';
import * as redstoneSdk from '@redstone-finance/sdk';
import { ethers, network } from 'hardhat';

import {
  hardhatChainId,
  getDomainSeparator,
  indexPriceToArgumentStruct,
  decimalToPips,
} from '../lib';

import {
  baseAssetSymbol,
  buildIndexPrice,
  buildIndexPriceWithTimestamp,
  buildIndexPriceWithValue,
  deployContractsExceptCustodian,
  expect,
  getLatestBlockTimestampInSeconds,
} from './helpers';

import type {
  ChainlinkDataStreamsIndexPriceAdapter__factory,
  ChainlinkDataStreamsVerifierMock__factory,
  ExchangeIndexPriceAdapterMock,
  ExchangeIndexPriceAdapterMock__factory,
  Exchange_v1,
  KatanaPerpsIndexAndOraclePriceAdapter,
  KatanaPerpsIndexAndOraclePriceAdapter__factory,
  RedStoneIndexPriceAdapter__factory,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type * as redstoneProtocol from '@redstone-finance/protocol';

const redstoneAuthorizedSigners = [
  '0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774',
  '0xdEB22f54738d54976C4c0fe5ce6d408E40d88499',
  '0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202',
  '0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE',
  '0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de',
];

describe('KatanaPerpsIndexAndOraclePriceAdapter', function () {
  let ExchangeIndexPriceAdapterMockFactory: ExchangeIndexPriceAdapterMock__factory;
  let KatanaPerpsIndexAndOraclePriceAdapterFactory: KatanaPerpsIndexAndOraclePriceAdapter__factory;
  let indexPriceServiceWallet: SignerWithAddress;
  let owner: SignerWithAddress;

  before(async () => {
    await network.provider.send('hardhat_reset');
    ExchangeIndexPriceAdapterMockFactory = await ethers.getContractFactory(
      'ExchangeIndexPriceAdapterMock',
    );
    KatanaPerpsIndexAndOraclePriceAdapterFactory =
      await ethers.getContractFactory('KatanaPerpsIndexAndOraclePriceAdapter');
    indexPriceServiceWallet = (await ethers.getSigners())[5];
    [owner] = await ethers.getSigners();
  });

  describe('deploy', async function () {
    it('should work for valid activator and IPS wallet', async () => {
      await KatanaPerpsIndexAndOraclePriceAdapterFactory.deploy(owner.address, [
        indexPriceServiceWallet.address,
      ]);
    });

    it('should revert for invalid activator', async () => {
      await expect(
        KatanaPerpsIndexAndOraclePriceAdapterFactory.deploy(
          ethers.ZeroAddress,
          [indexPriceServiceWallet.address],
        ),
      ).to.eventually.be.rejectedWith(/invalid activator/i);
    });

    it('should revert for missing IPS wallets', async () => {
      await expect(
        KatanaPerpsIndexAndOraclePriceAdapterFactory.deploy(owner.address, []),
      ).to.eventually.be.rejectedWith(/missing IPS wallets/i);
    });

    it('should revert for invalid IPS wallet', async () => {
      await expect(
        KatanaPerpsIndexAndOraclePriceAdapterFactory.deploy(owner.address, [
          ethers.ZeroAddress,
        ]),
      ).to.eventually.be.rejectedWith(/invalid IPS wallet/i);
    });
  });

  describe('setActive', async function () {
    let exchange: Exchange_v1;
    let indexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;
    let oldIndexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;

    beforeEach(async () => {
      const results = await deployContractsExceptCustodian(owner);
      exchange = results.exchange;
      oldIndexPriceAdapter = results.indexPriceAdapter;

      indexPriceAdapter =
        await KatanaPerpsIndexAndOraclePriceAdapterFactory.deploy(
          owner.address,
          [indexPriceServiceWallet.address],
        );
    });

    it('should work for valid contract address', async () => {
      await indexPriceAdapter.setActive(await exchange.getAddress());

      await expect(
        indexPriceAdapter.exchangeDomainSeparator(),
      ).to.eventually.equal(
        ethers.TypedDataEncoder.hashDomain(
          getDomainSeparator(await exchange.getAddress(), hardhatChainId),
        ),
      );
    });

    it('should migrate latest prices', async () => {
      await exchange.setDispatcher(owner.address);
      await exchange.addMarket({
        exists: true,
        isActive: false,
        baseAssetSymbol,
        indexPriceAtDeactivation: 0,
        lastIndexPrice: 0,
        lastIndexPriceTimestampInMs: 0,
        overridableFields: {
          initialMarginFraction: '5000000',
          maintenanceMarginFraction: '3000000',
          incrementalInitialMarginFraction: '1000000',
          baselinePositionSize: '14000000000',
          incrementalPositionSize: '2800000000',
          maximumPositionSize: '282000000000',
          minimumPositionSize: '10000000',
        },
      });
      await exchange.connect(owner).activateMarket(baseAssetSymbol);
      await exchange
        .connect(owner)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await oldIndexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              owner,
              '1900.00000000',
            ),
          ),
        ]);

      await expect(
        indexPriceAdapter.loadPriceForBaseAssetSymbol(baseAssetSymbol),
      ).to.eventually.be.rejectedWith(/missing price/i);

      await indexPriceAdapter.setActive(await exchange.getAddress());

      expect(
        (
          await indexPriceAdapter.loadPriceForBaseAssetSymbol(baseAssetSymbol)
        ).toString(),
      ).to.equal(decimalToPips('1900.00000000'));
    });

    it('should revert for invalid exchange address', async () => {
      await expect(
        indexPriceAdapter.setActive(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid exchange contract address/i);
    });

    it('should work when called twice', async () => {
      await indexPriceAdapter.setActive(await exchange.getAddress());
      await indexPriceAdapter.setActive(await exchange.getAddress());
    });

    it('should revert when called not called by activator', async () => {
      await indexPriceAdapter.setActive(await exchange.getAddress());

      await expect(
        indexPriceAdapter
          .connect((await ethers.getSigners())[1])
          .setActive(await exchange.getAddress()),
      ).to.be.revertedWith(/caller must be activator/i);
    });
  });

  describe('loadPriceForBaseAssetSymbol', async function () {
    let exchangeMock: ExchangeIndexPriceAdapterMock;
    let indexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;

    beforeEach(async () => {
      indexPriceAdapter =
        await KatanaPerpsIndexAndOraclePriceAdapterFactory.deploy(
          owner.address,
          [indexPriceServiceWallet.address],
        );
      exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());
    });

    it('should work when price is in storage', async () => {
      const indexPrice = await buildIndexPrice(
        await exchangeMock.getAddress(),
        indexPriceServiceWallet,
      );

      await exchangeMock.validateIndexPricePayload(
        indexPriceToArgumentStruct(
          await indexPriceAdapter.getAddress(),
          indexPrice,
        ).payload,
      );

      const price = (
        await indexPriceAdapter.loadPriceForBaseAssetSymbol(baseAssetSymbol)
      ).toString();
      expect(price).to.equal(decimalToPips(indexPrice.price));
    });

    it('should not store outdated price', async () => {
      const indexPrice = await buildIndexPrice(
        await exchangeMock.getAddress(),
        indexPriceServiceWallet,
      );

      await exchangeMock.validateIndexPricePayload(
        indexPriceToArgumentStruct(
          await indexPriceAdapter.getAddress(),
          indexPrice,
        ).payload,
      );

      const indexPrice2 = await buildIndexPriceWithTimestamp(
        await exchangeMock.getAddress(),
        indexPriceServiceWallet,
        (await getLatestBlockTimestampInSeconds()) * 1000 - 10000,
        baseAssetSymbol,
        '1234.67890000',
      );
      await exchangeMock.validateIndexPricePayload(
        indexPriceToArgumentStruct(
          await indexPriceAdapter.getAddress(),
          indexPrice2,
        ).payload,
      );

      const price = (
        await indexPriceAdapter.loadPriceForBaseAssetSymbol(baseAssetSymbol)
      ).toString();
      expect(price).to.equal(decimalToPips(indexPrice.price));
    });

    it('should revert for missing price', async () => {
      await expect(
        indexPriceAdapter.loadPriceForBaseAssetSymbol(baseAssetSymbol),
      ).to.eventually.be.rejectedWith(/missing price/i);
    });
  });

  describe('validateIndexPricePayload', async () => {
    let indexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;

    beforeEach(async () => {
      indexPriceAdapter =
        await KatanaPerpsIndexAndOraclePriceAdapterFactory.deploy(
          owner.address,
          [indexPriceServiceWallet.address],
        );
    });

    it('should revert when not called by exchange', async () => {
      await expect(
        indexPriceAdapter.validateIndexPricePayload('0x00'),
      ).to.eventually.be.rejectedWith(/exchange not set/i);

      const { exchange } = await deployContractsExceptCustodian(owner);
      await indexPriceAdapter.setActive(await exchange.getAddress());
      await expect(
        indexPriceAdapter.validateIndexPricePayload('0x00'),
      ).to.eventually.be.rejectedWith(/caller must be exchange/i);
    });

    it('should revert when price is zero', async () => {
      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      await expect(
        exchangeMock.validateIndexPricePayload(
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithTimestamp(
              await exchangeMock.getAddress(),
              indexPriceServiceWallet,
              (await getLatestBlockTimestampInSeconds()) * 1000 - 10000,
              baseAssetSymbol,
              '0.00000000',
            ),
          ).payload,
        ),
      ).to.eventually.be.rejectedWith(/unexpected non-positive price/i);
    });
  });

  describe('validateInitialIndexPricePayloadAdmin', async () => {
    let exchange: Exchange_v1;
    let indexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;

    beforeEach(async () => {
      indexPriceAdapter =
        await KatanaPerpsIndexAndOraclePriceAdapterFactory.deploy(
          owner.address,
          [indexPriceServiceWallet.address],
        );
      exchange = (
        await deployContractsExceptCustodian(
          owner,
          owner,
          owner,
          indexPriceServiceWallet,
        )
      ).exchange;
    });

    it('should work when no price yet exists', async () => {
      await indexPriceAdapter.setActive(await exchange.getAddress());

      await expect(
        indexPriceAdapter.loadPriceForBaseAssetSymbol(baseAssetSymbol),
      ).to.eventually.be.rejectedWith(/missing price/i);

      await indexPriceAdapter.validateInitialIndexPricePayloadAdmin(
        indexPriceToArgumentStruct(
          await indexPriceAdapter.getAddress(),
          await buildIndexPriceWithValue(
            await exchange.getAddress(),
            indexPriceServiceWallet,
            '1900.00000000',
          ),
        ).payload,
      );

      expect(
        (
          await indexPriceAdapter.loadPriceForBaseAssetSymbol(baseAssetSymbol)
        ).toString(),
      ).to.equal(decimalToPips('1900.00000000'));
    });

    it('should revert when price is zero', async () => {
      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      await expect(
        indexPriceAdapter.validateInitialIndexPricePayloadAdmin(
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithTimestamp(
              await exchangeMock.getAddress(),
              indexPriceServiceWallet,
              (await getLatestBlockTimestampInSeconds()) * 1000 - 10000,
              baseAssetSymbol,
              '0.00000000',
            ),
          ).payload,
        ),
      ).to.eventually.be.rejectedWith(/unexpected non-positive price/i);
    });

    it('should revert when not sent by admin', async () => {
      await expect(
        indexPriceAdapter
          .connect((await ethers.getSigners())[8])
          .validateInitialIndexPricePayloadAdmin(
            indexPriceToArgumentStruct(
              await indexPriceAdapter.getAddress(),
              await buildIndexPriceWithValue(
                await exchange.getAddress(),
                indexPriceServiceWallet,
                '1900.00000000',
              ),
            ).payload,
          ),
      ).to.be.revertedWithCustomError(indexPriceAdapter, 'SenderMustBeAdmin');
    });

    it('should revert when exchange is not set', async () => {
      await expect(
        indexPriceAdapter.validateInitialIndexPricePayloadAdmin(
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '1900.00000000',
            ),
          ).payload,
        ),
      ).to.eventually.be.rejectedWith(/exchange not set/i);
    });

    it('should revert when price already exists', async () => {
      await indexPriceAdapter.setActive(await exchange.getAddress());

      await indexPriceAdapter.validateInitialIndexPricePayloadAdmin(
        indexPriceToArgumentStruct(
          await indexPriceAdapter.getAddress(),
          await buildIndexPriceWithValue(
            await exchange.getAddress(),
            indexPriceServiceWallet,
            '1900.00000000',
          ),
        ).payload,
      );

      await expect(
        indexPriceAdapter.validateInitialIndexPricePayloadAdmin(
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '1900.00000000',
            ),
          ).payload,
        ),
      ).to.eventually.be.rejectedWith(/price already exists for market/i);
    });
  });
});

describe('RedStoneIndexPriceAdapter', function () {
  let RedStoneIndexPriceAdapterFactory: RedStoneIndexPriceAdapter__factory;
  let owner: SignerWithAddress;

  before(async () => {
    await network.provider.send('hardhat_reset');
    RedStoneIndexPriceAdapterFactory = await ethers.getContractFactory(
      'RedStoneIndexPriceAdapter',
    );
    [owner] = await ethers.getSigners();
  });

  describe('deploy', async function () {
    it('should work for valid activator and single market with price multiplier of 1', async () => {
      const dataFeedId = ethers.encodeBytes32String('ETH');

      await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [baseAssetSymbol],
        [dataFeedId],
        [1],
      );
    });

    it('should work for valid activator and multiple markets', async () => {
      const dataFeedId1 = ethers.encodeBytes32String('ETH');
      const dataFeedId2 = ethers.encodeBytes32String('BTC');

      await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [baseAssetSymbol, 'BTC'],
        [dataFeedId1, dataFeedId2],
        [1, 1],
      );
    });

    it('should work for valid activator and market with price multiplier greater than 1', async () => {
      const dataFeedId = ethers.encodeBytes32String('ETH');
      // Base asset symbol must start with the price multiplier as a string
      const baseAssetSymbolWithMultiplier = '1000ETH';

      await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [baseAssetSymbolWithMultiplier],
        [dataFeedId],
        [1000],
      );
    });

    it('should work with empty markets array', async () => {
      await RedStoneIndexPriceAdapterFactory.deploy(owner.address, [], [], []);
    });

    it('should revert for invalid activator address', async () => {
      const dataFeedId = ethers.encodeBytes32String('ETH');

      await expect(
        RedStoneIndexPriceAdapterFactory.deploy(
          ethers.ZeroAddress,
          [baseAssetSymbol],
          [dataFeedId],
          [1],
        ),
      ).to.eventually.be.rejectedWith(/invalid activator address/i);
    });

    it('should revert for argument length mismatch between baseAssetSymbols and dataFeedIds', async () => {
      const dataFeedId1 = ethers.encodeBytes32String('ETH');
      const dataFeedId2 = ethers.encodeBytes32String('BTC');

      await expect(
        RedStoneIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [dataFeedId1, dataFeedId2],
          [1],
        ),
      ).to.eventually.be.rejectedWith(/argument length mismatch/i);
    });

    it('should revert for argument length mismatch between dataFeedIds and priceMultipliers', async () => {
      const dataFeedId = ethers.encodeBytes32String('ETH');

      await expect(
        RedStoneIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [dataFeedId],
          [1, 2],
        ),
      ).to.eventually.be.rejectedWith(/argument length mismatch/i);
    });

    it('should revert for invalid data feed ID (zero bytes32)', async () => {
      await expect(
        RedStoneIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [ethers.ZeroHash],
          [1],
        ),
      ).to.eventually.be.rejectedWith(/invalid data feed id/i);
    });

    it('should revert for invalid base asset symbol (empty string)', async () => {
      const dataFeedId = ethers.encodeBytes32String('ETH');

      await expect(
        RedStoneIndexPriceAdapterFactory.deploy(
          owner.address,
          [''],
          [dataFeedId],
          [1],
        ),
      ).to.eventually.be.rejectedWith(/invalid base asset symbol/i);
    });

    it('should revert for invalid price multiplier (zero)', async () => {
      const dataFeedId = ethers.encodeBytes32String('ETH');

      await expect(
        RedStoneIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [dataFeedId],
          [0],
        ),
      ).to.eventually.be.rejectedWith(/invalid price multiplier/i);
    });

    it('should revert when price multiplier > 1 but base asset symbol does not start with multiplier', async () => {
      const dataFeedId = ethers.encodeBytes32String('ETH');

      await expect(
        RedStoneIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol], // 'ETH' does not start with '1000'
          [dataFeedId],
          [1000],
        ),
      ).to.eventually.be.rejectedWith(
        /base asset symbol does not start with price multiplier/i,
      );
    });

    it('should revert for duplicate data feed ID', async () => {
      const dataFeedId = ethers.encodeBytes32String('ETH');

      await expect(
        RedStoneIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol, 'ETH2'],
          [dataFeedId, dataFeedId], // Same data feed ID
          [1, 1],
        ),
      ).to.eventually.be.rejectedWith(/already added data feed id/i);
    });

    it('should revert for duplicate base asset symbol', async () => {
      const dataFeedId1 = ethers.encodeBytes32String('ETH');
      const dataFeedId2 = ethers.encodeBytes32String('BTC');

      await expect(
        RedStoneIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol, baseAssetSymbol], // Same base asset symbol
          [dataFeedId1, dataFeedId2],
          [1, 1],
        ),
      ).to.eventually.be.rejectedWith(/already added base asset symbol/i);
    });
  });

  describe('addMarket', async function () {
    it('should revert when called by non-admin wallet', async () => {
      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [],
        [],
        [],
      );

      const dataFeedId = ethers.encodeBytes32String('ETH');
      const nonAdminWallet = (await ethers.getSigners())[8];

      await expect(
        indexPriceAdapter
          .connect(nonAdminWallet)
          .addMarket(baseAssetSymbol, dataFeedId, 1),
      ).to.be.revertedWithCustomError(indexPriceAdapter, 'SenderMustBeAdmin');
    });
  });

  describe('setActive', async function () {
    it('should revert when called by non-activator wallet', async () => {
      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [],
        [],
        [],
      );

      const nonActivatorWallet = (await ethers.getSigners())[8];
      const { exchange } = await deployContractsExceptCustodian(owner);

      await expect(
        indexPriceAdapter
          .connect(nonActivatorWallet)
          .setActive(await exchange.getAddress()),
      ).to.eventually.be.rejectedWith(/caller must be activator/i);
    });

    it('should revert when already active', async () => {
      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [],
        [],
        [],
      );

      const { exchange } = await deployContractsExceptCustodian(owner);
      await indexPriceAdapter.setActive(await exchange.getAddress());

      await expect(
        indexPriceAdapter.setActive(await exchange.getAddress()),
      ).to.eventually.be.rejectedWith(/adapter already active/i);
    });

    it('should revert when exchange argument is not a deployed contract', async () => {
      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [],
        [],
        [],
      );

      // Use a regular wallet address (not a contract)
      const notAContract = (await ethers.getSigners())[5].address;

      await expect(
        indexPriceAdapter.setActive(notAContract),
      ).to.eventually.be.rejectedWith(/invalid exchange contract address/i);
    });
  });

  describe('validateIndexPricePayload', async function () {
    const ethDataFeedId = ethers.encodeBytes32String(baseAssetSymbol);
    let ExchangeIndexPriceAdapterMockFactory: ExchangeIndexPriceAdapterMock__factory;
    let samplePayload: string;
    let samplePayloadTimestamp: number;
    let samplePayloadPrice: bigint;

    before(async () => {
      RedStoneIndexPriceAdapterFactory = await ethers.getContractFactory(
        'RedStoneIndexPriceAdapter',
      );
      ExchangeIndexPriceAdapterMockFactory = await ethers.getContractFactory(
        'ExchangeIndexPriceAdapterMock',
      );
      [owner] = await ethers.getSigners();

      // https://github.com/redstone-finance/redstone-oracles-monorepo/blob/3aff529/packages/evm-connector/contracts/data-services/PrimaryProdDataServiceConsumerBase.sol
      const dataPackages = await redstoneSdk.requestDataPackages({
        dataServiceId: 'redstone-primary-prod',
        dataPackagesIds: [baseAssetSymbol],
        uniqueSignersCount: 3,
        authorizedSigners: redstoneAuthorizedSigners,
      });
      // Building a payload for manual usage based on fetched data packages
      const wrapper = new DataPackagesWrapper(dataPackages);
      const redstonePayload = `0x${await wrapper.prepareRedstonePayload(true)}`;

      samplePayload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'bytes'],
        [ethDataFeedId, redstonePayload],
      );

      const ethPackages = dataPackages[baseAssetSymbol];
      if (!ethPackages) {
        throw new Error(`Missing index ${baseAssetSymbol} in dataPackages`);
      }
      samplePayloadTimestamp = ethPackages[0].toObj().timestampMilliseconds;

      // Note: This assumes that al packages have the same price
      samplePayloadPrice = ethers.toBigInt(
        ethPackages[0].dataPackage.dataPoints[0].value,
      );
      /*
      Timestamp and price can also be extracted from the prepared contract
      payload:

      const parsed = new RedstonePayloadParser(
        ethers.getBytes(redstonePayload),
      ).parse();
      samplePayloadTimestamp =
        parsed.signedDataPackages[0].toObj().timestampMilliseconds;
      samplePayloadPrice = ethers.toBigInt(
        parsed.signedDataPackages[0].dataPackage.dataPoints[0].value,
      );
      */
    });

    it('should revert when exchange is not set', async () => {
      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [baseAssetSymbol],
        [ethDataFeedId],
        [1],
      );

      // Call directly without setting exchange
      await expect(
        indexPriceAdapter.validateIndexPricePayload(samplePayload),
      ).to.eventually.be.rejectedWith(/caller must be exchange contract/i);
    });

    it('should revert when caller is not the exchange', async () => {
      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [baseAssetSymbol],
        [ethDataFeedId],
        [1],
      );

      // Create a mock exchange and set it as active
      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      // Try to call directly (not through exchange)
      await expect(
        indexPriceAdapter.validateIndexPricePayload(samplePayload),
      ).to.eventually.be.rejectedWith(/caller must be exchange contract/i);
    });

    it('should revert for unknown price ID', async () => {
      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [], // No markets added
        [],
        [],
      );

      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      // The payload contains ETH data feed ID but no markets are added
      await expect(
        exchangeMock.validateIndexPricePayload(samplePayload),
      ).to.eventually.be.rejectedWith(/unknown price id/i);
    });

    it('should revert for unknown price ID when different market is configured', async () => {
      const btcDataFeedId = ethers.encodeBytes32String('BTC');

      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        ['BTC'], // Only BTC configured, not ETH
        [btcDataFeedId],
        [1],
      );

      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      // The payload contains ETH data feed ID but only BTC is configured
      await expect(
        exchangeMock.validateIndexPricePayload(samplePayload),
      ).to.eventually.be.rejectedWith(/unknown price id/i);
    });

    it('should return IndexPrice with correct values for valid input', async () => {
      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [baseAssetSymbol],
        [ethDataFeedId],
        [1],
      );

      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      // Call validateIndexPricePayload through the mock exchange
      const tx = await exchangeMock.validateIndexPricePayload(samplePayload);
      const receipt = await tx.wait();

      // Get the ValidatedIndexPrice event
      const event = receipt?.logs.find((log) => {
        try {
          return (
            exchangeMock.interface.parseLog(log)?.name === 'ValidatedIndexPrice'
          );
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;

      const parsedEvent = exchangeMock.interface.parseLog(event!);
      const indexPrice = parsedEvent?.args?.indexPrice;

      // Verify the IndexPrice struct fields
      // baseAssetSymbol should be 'ETH'
      expect(indexPrice.baseAssetSymbol).to.equal(baseAssetSymbol);
      expect(indexPrice.price).to.equal(samplePayloadPrice);
      expect(indexPrice.timestampInMs).to.equal(samplePayloadTimestamp);
    });

    it('should return IndexPrice with price multiplied by priceMultiplier for 10ETH market', async () => {
      const multipliedBaseAssetSymbol = '10ETH';
      const priceMultiplier = 10;

      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        [multipliedBaseAssetSymbol],
        [ethDataFeedId],
        [priceMultiplier],
      );

      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      // Call validateIndexPricePayload through the mock exchange
      const tx = await exchangeMock.validateIndexPricePayload(samplePayload);
      const receipt = await tx.wait();

      // Get the ValidatedIndexPrice event
      const event = receipt?.logs.find((log) => {
        try {
          return (
            exchangeMock.interface.parseLog(log)?.name === 'ValidatedIndexPrice'
          );
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;

      const parsedEvent = exchangeMock.interface.parseLog(event!);
      const indexPrice = parsedEvent?.args?.indexPrice;

      // Verify the IndexPrice struct fields
      // baseAssetSymbol should be '10ETH'
      expect(indexPrice.baseAssetSymbol).to.equal(multipliedBaseAssetSymbol);

      // price should be exactly 10x the payload-encoded price
      expect(indexPrice.price).to.equal(
        samplePayloadPrice * BigInt(priceMultiplier),
      );

      expect(indexPrice.timestampInMs).to.equal(samplePayloadTimestamp);
    });

    /**
     * Based on https://github.com/redstone-finance/redstone-oracles-monorepo/blob/44b06f892864f36c9d3676c0694641e3e92f77b9/packages/sdk/src/data-feed-values.ts#L40-L44
     * Returns the price as a float.
     */
    const determinePriceFromDataPackages = (
      dataPackages: redstoneProtocol.SignedDataPackage[],
    ): number => {
      const prices = dataPackages.map((dataPackage) =>
        parseInt(
          ethers.hexlify(dataPackage.dataPackage.dataPoints[0].value),
          16,
        ),
      );
      return redstoneSdk.aggregateValues(prices, 'median');
    };

    /**
     * Generates the payload that needs to be provided to the
     * `validateIndexPricePayload` Exchange contract function for validation
     * of Redstone index price data.
     */
    const generateValidateIndexPricePayload = async (
      assetSymbol: string,
      dataPackages: redstoneProtocol.SignedDataPackage[],
    ) => {
      const wrapper = new DataPackagesWrapper({ [assetSymbol]: dataPackages });
      return ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'bytes'],
        [
          ethers.encodeBytes32String(assetSymbol),
          `0x${await wrapper.prepareRedstonePayload(true)}`,
        ],
      );
    };

    /**
     * Requests prices for multiple assets from the Redstone REST API, and
     * validates each price individually against the contracts. This mirrors
     * the end-to-end integration that involves Index Price Selection Service,
     * persistence, dispatch, and index price validation by the contracts.
     */
    it('should succeed for multiple assets', async () => {
      const assets = ['BTC', 'ETH'];

      const indexPriceAdapter = await RedStoneIndexPriceAdapterFactory.deploy(
        owner.address,
        assets,
        assets.map(ethers.encodeBytes32String),
        assets.map((_) => 1),
      );
      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      const validateIndexPricePayload = async (payload: string) => {
        const tx = await exchangeMock.validateIndexPricePayload(payload);
        const receipt = await tx.wait();
        if (!receipt) {
          throw new Error(`receipt is null`);
        }
        const logDescriptions = receipt.logs
          .map((log) => exchangeMock.interface.parseLog(log))
          .filter((logDescription) => logDescription !== null)
          .filter(
            (logDescription) => logDescription.name === 'ValidatedIndexPrice',
          );

        if (logDescriptions.length !== 1) {
          throw new Error(
            `Expected 1 LogDescription, got ${logDescriptions.length}`,
          );
        }
        const price = logDescriptions[0].args[0] as unknown as [
          assetSymbol: string,
          timestampInMs: bigint,
          priceInPips: bigint,
        ];
        return {
          baseAssetSymbol: price[0],
          timestampInMs: price[1],
          price: price[2],
        };
      };

      const dataPackagesByAssetSymbol = await redstoneSdk.requestDataPackages({
        dataServiceId: 'redstone-primary-prod',
        dataPackagesIds: assets,
        uniqueSignersCount: 3,
        authorizedSigners: redstoneAuthorizedSigners,
      });

      for (const [assetSymbol, dataPackages] of Object.entries(
        dataPackagesByAssetSymbol,
      )) {
        if (!dataPackages || dataPackages.length === 0) {
          throw new Error(
            `No dataPackages were returned for asset ${assetSymbol}`,
          );
        }
        // All packages are expected to have the same timestamp
        const timestamp = dataPackages[0].toObj().timestampMilliseconds;
        const price = determinePriceFromDataPackages(dataPackages);

        const payload = await generateValidateIndexPricePayload(
          assetSymbol,
          dataPackages,
        );
        const validatedPrice = await validateIndexPricePayload(payload);

        expect(validatedPrice.baseAssetSymbol).to.eql(assetSymbol);
        expect(validatedPrice.price.toString()).to.eql(price.toString(10));
        expect(validatedPrice.timestampInMs).to.eql(BigInt(timestamp));
      }
    });
  });
});

describe('ChainlinkDataStreamsIndexPriceAdapter', function () {
  let ChainlinkDataStreamsIndexPriceAdapterFactory: ChainlinkDataStreamsIndexPriceAdapter__factory;
  let ChainlinkDataStreamsVerifierMockFactory: ChainlinkDataStreamsVerifierMock__factory;
  let ExchangeIndexPriceAdapterMockFactory: ExchangeIndexPriceAdapterMock__factory;
  let owner: SignerWithAddress;

  before(async () => {
    await network.provider.send('hardhat_reset');
    ChainlinkDataStreamsIndexPriceAdapterFactory =
      await ethers.getContractFactory('ChainlinkDataStreamsIndexPriceAdapter');
    ChainlinkDataStreamsVerifierMockFactory = await ethers.getContractFactory(
      'ChainlinkDataStreamsVerifierMock',
    );
    ExchangeIndexPriceAdapterMockFactory = await ethers.getContractFactory(
      'ExchangeIndexPriceAdapterMock',
    );
    [owner] = await ethers.getSigners();
  });

  describe('deploy', async function () {
    it('should work for valid activator and single market with price multiplier of 1', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      // Deploy a mock contract to use as verifier
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
        owner.address,
        [baseAssetSymbol],
        [8],
        [feedId],
        [1],
        await mockVerifier.getAddress(),
      );
    });

    it('should work for valid activator and multiple markets', async () => {
      const feedId1 = ethers.encodeBytes32String('ETH');
      const feedId2 = ethers.encodeBytes32String('BTC');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
        owner.address,
        [baseAssetSymbol, 'BTC'],
        [8, 8],
        [feedId1, feedId2],
        [1, 1],
        await mockVerifier.getAddress(),
      );
    });

    it('should work for valid activator and market with price multiplier greater than 1', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const baseAssetSymbolWithMultiplier = '1000ETH';
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
        owner.address,
        [baseAssetSymbolWithMultiplier],
        [8],
        [feedId],
        [1000],
        await mockVerifier.getAddress(),
      );
    });

    it('should work with empty markets array', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
        owner.address,
        [],
        [],
        [],
        [],
        await mockVerifier.getAddress(),
      );
    });

    it('should work with 18 decimals', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
        owner.address,
        [baseAssetSymbol],
        [18],
        [feedId],
        [1],
        await mockVerifier.getAddress(),
      );
    });

    it('should revert for invalid activator address', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          ethers.ZeroAddress,
          [baseAssetSymbol],
          [8],
          [feedId],
          [1],
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid activator address/i);
    });

    it('should revert for argument length mismatch between baseAssetSymbols and decimals', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [8, 8], // Two decimals but one symbol
          [feedId],
          [1],
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/argument length mismatch/i);
    });

    it('should revert for argument length mismatch between decimals and feedIds', async () => {
      const feedId1 = ethers.encodeBytes32String('ETH');
      const feedId2 = ethers.encodeBytes32String('BTC');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [8],
          [feedId1, feedId2], // Two feed IDs but one symbol
          [1],
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/argument length mismatch/i);
    });

    it('should revert for argument length mismatch between feedIds and priceMultipliers', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [8],
          [feedId],
          [1, 2], // Two multipliers but one feed
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/argument length mismatch/i);
    });

    it('should revert for decimals greater than 18', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [19], // More than 18 decimals
          [feedId],
          [1],
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(
        /asset cannot have more than 18 decimals/i,
      );
    });

    it('should revert for invalid feed ID (zero bytes32)', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [8],
          [ethers.ZeroHash],
          [1],
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid feed id/i);
    });

    it('should revert for invalid base asset symbol (empty string)', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [''],
          [8],
          [feedId],
          [1],
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid base asset symbol/i);
    });

    it('should revert for invalid price multiplier (zero)', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [8],
          [feedId],
          [0],
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid price multiplier/i);
    });

    it('should revert when price multiplier > 1 but base asset symbol does not start with multiplier', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol], // 'ETH' does not start with '1000'
          [8],
          [feedId],
          [1000],
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(
        /base asset symbol does not start with price multiplier/i,
      );
    });

    it('should revert for duplicate feed ID', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol, 'ETH2'],
          [8, 8],
          [feedId, feedId], // Same feed ID
          [1, 1],
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/already added feed id/i);
    });

    it('should revert for duplicate base asset symbol', async () => {
      const feedId1 = ethers.encodeBytes32String('ETH');
      const feedId2 = ethers.encodeBytes32String('BTC');
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol, baseAssetSymbol], // Same base asset symbol
          [8, 8],
          [feedId1, feedId2],
          [1, 1],
          await mockVerifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/already added base asset symbol/i);
    });

    it('should revert for invalid verifier contract address (not a contract)', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const notAContract = (await ethers.getSigners())[5].address;

      await expect(
        ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [8],
          [feedId],
          [1],
          notAContract,
        ),
      ).to.eventually.be.rejectedWith(
        /invalid chainlink verifier contract address/i,
      );
    });
  });

  describe('addMarket', async function () {
    it('should work when adding a new market with price multiplier of 1', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const feedId = ethers.encodeBytes32String('ETH');
      await indexPriceAdapter.addMarket(baseAssetSymbol, 8, feedId, 1);

      const market = await indexPriceAdapter.marketsByBaseAssetSymbol(
        baseAssetSymbol,
      );
      expect(market.exists).to.be.true;
      expect(market.baseAssetSymbol).to.equal(baseAssetSymbol);
      expect(market.decimals).to.equal(8);
      expect(market.feedId).to.equal(feedId);
      expect(market.priceMultiplier).to.equal(1);
    });

    it('should work when adding a new market with price multiplier greater than 1', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const feedId = ethers.encodeBytes32String('ETH');
      const baseAssetSymbolWithMultiplier = '1000ETH';
      await indexPriceAdapter.addMarket(
        baseAssetSymbolWithMultiplier,
        8,
        feedId,
        1000,
      );

      const market = await indexPriceAdapter.marketsByBaseAssetSymbol(
        baseAssetSymbolWithMultiplier,
      );
      expect(market.exists).to.be.true;
      expect(market.baseAssetSymbol).to.equal(baseAssetSymbolWithMultiplier);
      expect(market.priceMultiplier).to.equal(1000);
    });

    it('should revert when decimals are over 18', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const feedId = ethers.encodeBytes32String('ETH');
      await expect(
        indexPriceAdapter.addMarket(baseAssetSymbol, 19, feedId, 1),
      ).to.eventually.be.rejectedWith(
        /asset cannot have more than 18 decimals/i,
      );
    });

    it('should revert when feedId is zero', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      await expect(
        indexPriceAdapter.addMarket(baseAssetSymbol, 8, ethers.ZeroHash, 1),
      ).to.eventually.be.rejectedWith(/invalid feed id/i);
    });

    it('should revert for duplicate feedId', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const feedId = ethers.encodeBytes32String('ETH');
      await indexPriceAdapter.addMarket(baseAssetSymbol, 8, feedId, 1);

      await expect(
        indexPriceAdapter.addMarket('ETH2', 8, feedId, 1),
      ).to.eventually.be.rejectedWith(/already added feed id/i);
    });

    it('should revert for empty base asset symbol string', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const feedId = ethers.encodeBytes32String('ETH');
      await expect(
        indexPriceAdapter.addMarket('', 8, feedId, 1),
      ).to.eventually.be.rejectedWith(/invalid base asset symbol/i);
    });

    it('should revert for zero price multiplier', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const feedId = ethers.encodeBytes32String('ETH');
      await expect(
        indexPriceAdapter.addMarket(baseAssetSymbol, 8, feedId, 0),
      ).to.eventually.be.rejectedWith(/invalid price multiplier/i);
    });

    it('should revert for invalid symbol prefix when price multiplier is greater than 1', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const feedId = ethers.encodeBytes32String('ETH');
      await expect(
        indexPriceAdapter.addMarket(baseAssetSymbol, 8, feedId, 1000), // 'ETH' does not start with '1000'
      ).to.eventually.be.rejectedWith(
        /base asset symbol does not start with price multiplier/i,
      );
    });

    it('should revert when called by non-admin wallet', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const feedId = ethers.encodeBytes32String('ETH');
      const nonAdminWallet = (await ethers.getSigners())[8];

      await expect(
        indexPriceAdapter
          .connect(nonAdminWallet)
          .addMarket(baseAssetSymbol, 8, feedId, 1),
      ).to.be.revertedWithCustomError(indexPriceAdapter, 'SenderMustBeAdmin');
    });
  });

  describe('setActive', async function () {
    it('should work when properly called', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const { exchange } = await deployContractsExceptCustodian(owner);
      await indexPriceAdapter.setActive(await exchange.getAddress());

      expect(await indexPriceAdapter.exchange()).to.equal(
        await exchange.getAddress(),
      );
    });

    it('should revert when called by non-activator wallet', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const nonActivatorWallet = (await ethers.getSigners())[8];
      const { exchange } = await deployContractsExceptCustodian(owner);

      await expect(
        indexPriceAdapter
          .connect(nonActivatorWallet)
          .setActive(await exchange.getAddress()),
      ).to.revertedWith(/caller must be activator/i);
    });

    it('should revert when adapter is already active', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const { exchange } = await deployContractsExceptCustodian(owner);
      await indexPriceAdapter.setActive(await exchange.getAddress());

      await expect(
        indexPriceAdapter.setActive(await exchange.getAddress()),
      ).to.revertedWith(/adapter already active/i);
    });

    it('should revert when exchange argument is not a deployed contract', async () => {
      const mockVerifier = await ExchangeIndexPriceAdapterMockFactory.deploy(
        ethers.ZeroAddress,
      );
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [],
          [],
          [],
          [],
          await mockVerifier.getAddress(),
        );

      const notAContract = (await ethers.getSigners())[5].address;

      await expect(indexPriceAdapter.setActive(notAContract)).to.revertedWith(
        /invalid exchange contract address/i,
      );
    });
  });

  describe('validateIndexPricePayload', async function () {
    it('should work when called with valid arguments', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const decimals = 8;
      const priceMultiplier = 1;
      const priceInDecimals = BigInt(2000_00000000); // $2000 with 8 decimals

      // Deploy the ChainlinkDataStreamsVerifierMock
      const verifierMock =
        await ChainlinkDataStreamsVerifierMockFactory.deploy();

      // Deploy the index price adapter with ETH market
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [decimals],
          [feedId],
          [priceMultiplier],
          await verifierMock.getAddress(),
        );

      // Deploy ExchangeIndexPriceAdapterMock and set adapter active
      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      // Construct ReportV3 struct values
      const validFromTimestamp = Math.floor(Date.now() / 1000);
      const observationsTimestamp = validFromTimestamp;
      const nativeFee = 0;
      const linkFee = 0;
      const expiresAt = validFromTimestamp + 3600;
      const price = priceInDecimals;
      const bid = priceInDecimals - BigInt(100000000);
      const ask = priceInDecimals + BigInt(100000000);

      // ABI encode the ReportV3 struct
      const reportV3Encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        [
          'bytes32',
          'uint32',
          'uint32',
          'uint192',
          'uint192',
          'uint32',
          'int192',
          'int192',
          'int192',
        ],
        [
          feedId,
          validFromTimestamp,
          observationsTimestamp,
          nativeFee,
          linkFee,
          expiresAt,
          price,
          bid,
          ask,
        ],
      );

      // Construct the reportData: 2 bytes version prefix (version 3) + ReportV3 encoded
      const versionPrefix = new Uint8Array([0x00, 0x03]);
      const reportData = ethers.concat([versionPrefix, reportV3Encoded]);

      // Construct the full payload: empty bytes32[3] + reportData as bytes
      const emptyBytes32Array = [
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash,
      ];
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32[3]', 'bytes'],
        [emptyBytes32Array, reportData],
      );

      // Call validateIndexPricePayload through the mock exchange
      const tx = await exchangeMock.validateIndexPricePayload(payload);
      const receipt = await tx.wait();

      // Get the ValidatedIndexPrice event
      const event = receipt?.logs.find((log) => {
        try {
          return (
            exchangeMock.interface.parseLog(log)?.name === 'ValidatedIndexPrice'
          );
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;

      const parsedEvent = exchangeMock.interface.parseLog(event!);
      const indexPrice = parsedEvent?.args?.indexPrice;

      // Verify the IndexPrice struct fields
      expect(indexPrice.baseAssetSymbol).to.equal(baseAssetSymbol);
      expect(indexPrice.timestampInMs).to.equal(validFromTimestamp * 1000);
      expect(indexPrice.price).to.equal(priceInDecimals);
    });

    it('should revert when schema version is not 3', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const decimals = 8;
      const priceMultiplier = 1;
      const priceInDecimals = BigInt(2000_00000000);

      const verifierMock =
        await ChainlinkDataStreamsVerifierMockFactory.deploy();

      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [decimals],
          [feedId],
          [priceMultiplier],
          await verifierMock.getAddress(),
        );

      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      // Construct ReportV3 struct values
      const validFromTimestamp = Math.floor(Date.now() / 1000);
      const observationsTimestamp = validFromTimestamp;
      const nativeFee = 0;
      const linkFee = 0;
      const expiresAt = validFromTimestamp + 3600;
      const price = priceInDecimals;
      const bid = priceInDecimals - BigInt(100000000);
      const ask = priceInDecimals + BigInt(100000000);

      const reportV3Encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        [
          'bytes32',
          'uint32',
          'uint32',
          'uint192',
          'uint192',
          'uint32',
          'int192',
          'int192',
          'int192',
        ],
        [
          feedId,
          validFromTimestamp,
          observationsTimestamp,
          nativeFee,
          linkFee,
          expiresAt,
          price,
          bid,
          ask,
        ],
      );

      // Use version 2 instead of version 3
      const versionPrefix = new Uint8Array([0x00, 0x02]);
      const reportData = ethers.concat([versionPrefix, reportV3Encoded]);

      const emptyBytes32Array = [
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash,
      ];
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32[3]', 'bytes'],
        [emptyBytes32Array, reportData],
      );

      await expect(
        exchangeMock.validateIndexPricePayload(payload),
      ).to.eventually.be.rejectedWith(/report version must be 3/i);
    });

    it('should revert when feedId does not correspond to an added market', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const unknownFeedId = ethers.encodeBytes32String('BTC');
      const decimals = 8;
      const priceMultiplier = 1;
      const priceInDecimals = BigInt(2000_00000000);

      const verifierMock =
        await ChainlinkDataStreamsVerifierMockFactory.deploy();

      // Deploy adapter with ETH market only
      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [decimals],
          [feedId],
          [priceMultiplier],
          await verifierMock.getAddress(),
        );

      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      // Construct ReportV3 with BTC feedId (not added to contract)
      const validFromTimestamp = Math.floor(Date.now() / 1000);
      const observationsTimestamp = validFromTimestamp;
      const nativeFee = 0;
      const linkFee = 0;
      const expiresAt = validFromTimestamp + 3600;
      const price = priceInDecimals;
      const bid = priceInDecimals - BigInt(100000000);
      const ask = priceInDecimals + BigInt(100000000);

      const reportV3Encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        [
          'bytes32',
          'uint32',
          'uint32',
          'uint192',
          'uint192',
          'uint32',
          'int192',
          'int192',
          'int192',
        ],
        [
          unknownFeedId, // Use BTC feedId which is not added
          validFromTimestamp,
          observationsTimestamp,
          nativeFee,
          linkFee,
          expiresAt,
          price,
          bid,
          ask,
        ],
      );

      const versionPrefix = new Uint8Array([0x00, 0x03]);
      const reportData = ethers.concat([versionPrefix, reportV3Encoded]);

      const emptyBytes32Array = [
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash,
      ];
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32[3]', 'bytes'],
        [emptyBytes32Array, reportData],
      );

      await expect(
        exchangeMock.validateIndexPricePayload(payload),
      ).to.eventually.be.rejectedWith(/unknown feed id/i);
    });

    it('should revert when called by wallet other than whitelisted Exchange', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const decimals = 8;
      const priceMultiplier = 1;

      const verifierMock =
        await ChainlinkDataStreamsVerifierMockFactory.deploy();

      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [decimals],
          [feedId],
          [priceMultiplier],
          await verifierMock.getAddress(),
        );

      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      // Try to call validateIndexPricePayload directly (not through exchange)
      await expect(
        indexPriceAdapter.validateIndexPricePayload('0x00'),
      ).to.eventually.be.rejectedWith(/caller must be exchange contract/i);
    });

    it('should revert when verifier.s_feeManager() returns non-zero address', async () => {
      const feedId = ethers.encodeBytes32String('ETH');
      const decimals = 8;
      const priceMultiplier = 1;
      const priceInDecimals = BigInt(2000_00000000);

      const verifierMock =
        await ChainlinkDataStreamsVerifierMockFactory.deploy();

      const indexPriceAdapter =
        await ChainlinkDataStreamsIndexPriceAdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [decimals],
          [feedId],
          [priceMultiplier],
          await verifierMock.getAddress(),
        );

      const exchangeMock = await ExchangeIndexPriceAdapterMockFactory.deploy(
        await indexPriceAdapter.getAddress(),
      );
      await indexPriceAdapter.setActive(await exchangeMock.getAddress());

      // Set feeManager to a non-zero address
      const nonZeroAddress = (await ethers.getSigners())[5].address;
      await (
        verifierMock as unknown as {
          setFeeManager: (addr: string) => Promise<void>;
        }
      ).setFeeManager(nonZeroAddress);

      // Construct valid payload
      const validFromTimestamp = Math.floor(Date.now() / 1000);
      const observationsTimestamp = validFromTimestamp;
      const nativeFee = 0;
      const linkFee = 0;
      const expiresAt = validFromTimestamp + 3600;
      const price = priceInDecimals;
      const bid = priceInDecimals - BigInt(100000000);
      const ask = priceInDecimals + BigInt(100000000);

      const reportV3Encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        [
          'bytes32',
          'uint32',
          'uint32',
          'uint192',
          'uint192',
          'uint32',
          'int192',
          'int192',
          'int192',
        ],
        [
          feedId,
          validFromTimestamp,
          observationsTimestamp,
          nativeFee,
          linkFee,
          expiresAt,
          price,
          bid,
          ask,
        ],
      );

      const versionPrefix = new Uint8Array([0x00, 0x03]);
      const reportData = ethers.concat([versionPrefix, reportV3Encoded]);

      const emptyBytes32Array = [
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash,
      ];
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32[3]', 'bytes'],
        [emptyBytes32Array, reportData],
      );

      await expect(
        exchangeMock.validateIndexPricePayload(payload),
      ).to.eventually.be.rejectedWith(/feemanager not supported/i);
    });
  });
});
