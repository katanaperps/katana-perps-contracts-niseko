import { ethers, network } from 'hardhat';

import {
  baseAssetSymbol,
  deployContractsExceptCustodian,
  expect,
} from './helpers';

import type {
  ChainlinkDataStreamsIndexPriceAdapter__factory,
  ChainlinkDataStreamsVerifierMock__factory,
  ExchangeIndexPriceAdapterMock__factory,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId1 =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
      const feedId2 =
        '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId1 =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
      const feedId2 =
        '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId1 =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
      const feedId2 =
        '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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

      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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

      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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

      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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

    it('should revert when feedId encodes wrong report version', async () => {
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
        indexPriceAdapter.addMarket(
          baseAssetSymbol,
          8,
          '0x000b2bba8b7a8f22b2175e95997312389df8b77c841a982814eba028817efa15',
          1,
        ),
      ).to.eventually.be.rejectedWith(/report version must be 3/i);
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

      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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

      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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

      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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

      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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

      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
      const unknownFeedId =
        '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
      const feedId =
        '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
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
