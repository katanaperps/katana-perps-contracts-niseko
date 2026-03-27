import { ethers, network } from 'hardhat';

import {
  baseAssetSymbol,
  deployAndAssociateContracts,
  deployContractsExceptCustodian,
  expect,
} from './helpers';

import type {
  ChainlinkDataStreamsIndexAndOraclePriceAdapter,
  ChainlinkDataStreamsIndexAndOraclePriceAdapter__factory,
  ChainlinkDataStreamsVerifierMock,
  ChainlinkDataStreamsVerifierMock__factory,
  ExchangeIndexPriceAdapterMock,
  ExchangeIndexPriceAdapterMock__factory,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// Feed IDs with version encoded in first 2 bytes
const feedIdV3 =
  '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
const feedIdV3Alt =
  '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8';
const feedIdV8 =
  '0x000862205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
const feedIdV10 =
  '0x000a62205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
const feedIdV11 =
  '0x000b62205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
const feedIdUnsupported =
  '0x000462205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';

// 18-decimal price: $2000
const price18d = BigInt('2000000000000000000000');
// Expected pips: 2000.00000000 = 200_000_000_000
const expectedPips = BigInt('200000000000');

function buildV3Payload(
  feedId: string,
  validFromTimestamp: number,
  price: bigint,
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
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
      validFromTimestamp,
      0,
      0,
      validFromTimestamp + 3600,
      price,
      price - BigInt(1e16),
      price + BigInt(1e16),
    ],
  );
  const reportData = ethers.concat([new Uint8Array([0x00, 0x03]), encoded]);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32[3]', 'bytes'],
    [[ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash], reportData],
  );
}

function buildV8Payload(
  feedId: string,
  validFromTimestamp: number,
  midPrice: bigint,
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      'bytes32',
      'uint32',
      'uint32',
      'uint192',
      'uint192',
      'uint32',
      'uint64',
      'int192',
      'uint32',
    ],
    [
      feedId,
      validFromTimestamp,
      validFromTimestamp,
      0,
      0,
      validFromTimestamp + 3600,
      BigInt(validFromTimestamp) * BigInt(1e9),
      midPrice,
      2,
    ],
  );
  const reportData = ethers.concat([new Uint8Array([0x00, 0x08]), encoded]);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32[3]', 'bytes'],
    [[ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash], reportData],
  );
}

function buildV10Payload(
  feedId: string,
  validFromTimestamp: number,
  tokenizedPrice: bigint,
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      'bytes32',
      'uint32',
      'uint32',
      'uint192',
      'uint192',
      'uint32',
      'uint64',
      'int192',
      'uint32',
      'int192',
      'int192',
      'uint32',
      'int192',
    ],
    [
      feedId,
      validFromTimestamp,
      validFromTimestamp,
      0,
      0,
      validFromTimestamp + 3600,
      BigInt(validFromTimestamp) * BigInt(1e9),
      tokenizedPrice, // price (equity)
      2,
      BigInt(1e18), // currentMultiplier
      0, // newMultiplier
      0, // activationDateTime
      tokenizedPrice, // tokenizedPrice
    ],
  );
  const reportData = ethers.concat([new Uint8Array([0x00, 0x0a]), encoded]);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32[3]', 'bytes'],
    [[ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash], reportData],
  );
}

function buildV11Payload(
  feedId: string,
  validFromTimestamp: number,
  lastTradedPrice: bigint,
): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      'bytes32',
      'uint32',
      'uint32',
      'uint192',
      'uint192',
      'uint32',
      'int192',
      'uint64',
      'int192',
      'int192',
      'int192',
      'int192',
      'int192',
      'uint32',
    ],
    [
      feedId,
      validFromTimestamp,
      validFromTimestamp,
      0,
      0,
      validFromTimestamp + 3600,
      lastTradedPrice, // mid
      BigInt(validFromTimestamp) * BigInt(1e9),
      lastTradedPrice - BigInt(1e16), // bid
      BigInt(100e18), // bidVolume
      lastTradedPrice + BigInt(1e16), // ask
      BigInt(100e18), // askVolume
      lastTradedPrice,
      2,
    ],
  );
  const reportData = ethers.concat([new Uint8Array([0x00, 0x0b]), encoded]);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32[3]', 'bytes'],
    [[ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash], reportData],
  );
}

// Build a payload with a mismatched version prefix (prefix says V3 but feedId encodes V8)
function buildMismatchedVersionPayload(
  feedId: string,
  versionByte: number,
  price: bigint,
): string {
  const validFromTimestamp = Math.floor(Date.now() / 1000);
  // Encode as V3 struct regardless of feedId version
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
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
      validFromTimestamp,
      0,
      0,
      validFromTimestamp + 3600,
      price,
      price,
      price,
    ],
  );
  const reportData = ethers.concat([
    new Uint8Array([0x00, versionByte]),
    encoded,
  ]);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32[3]', 'bytes'],
    [[ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash], reportData],
  );
}

describe('ChainlinkDataStreamsIndexAndOraclePriceAdapter', function () {
  let AdapterFactory: ChainlinkDataStreamsIndexAndOraclePriceAdapter__factory;
  let VerifierMockFactory: ChainlinkDataStreamsVerifierMock__factory;
  let ExchangeMockFactory: ExchangeIndexPriceAdapterMock__factory;
  let owner: SignerWithAddress;

  before(async () => {
    await network.provider.send('hardhat_reset');
    AdapterFactory = await ethers.getContractFactory(
      'ChainlinkDataStreamsIndexAndOraclePriceAdapter',
    );
    VerifierMockFactory = await ethers.getContractFactory(
      'ChainlinkDataStreamsVerifierMock',
    );
    ExchangeMockFactory = await ethers.getContractFactory(
      'ExchangeIndexPriceAdapterMock',
    );
    [owner] = await ethers.getSigners();
  });

  async function deployMockVerifier(): Promise<ChainlinkDataStreamsVerifierMock> {
    return VerifierMockFactory.deploy();
  }

  async function deployAdapter(
    feedIds: string[] = [feedIdV3],
    symbols: string[] = [baseAssetSymbol],
    decimals: number[] = [18],
    multipliers: number[] = [1],
    verifierAddress?: string,
  ): Promise<ChainlinkDataStreamsIndexAndOraclePriceAdapter> {
    const verifier =
      verifierAddress ?? (await (await deployMockVerifier()).getAddress());
    return AdapterFactory.deploy(
      owner.address,
      symbols,
      decimals,
      feedIds,
      multipliers,
      verifier,
    );
  }

  async function deployAdapterWithExchange(
    feedIds: string[] = [feedIdV3],
    symbols: string[] = [baseAssetSymbol],
    decimals: number[] = [18],
    multipliers: number[] = [1],
  ): Promise<{
    adapter: ChainlinkDataStreamsIndexAndOraclePriceAdapter;
    exchangeMock: ExchangeIndexPriceAdapterMock;
    verifierMock: ChainlinkDataStreamsVerifierMock;
  }> {
    const verifierMock = await deployMockVerifier();
    const adapter = await AdapterFactory.deploy(
      owner.address,
      symbols,
      decimals,
      feedIds,
      multipliers,
      await verifierMock.getAddress(),
    );
    const exchangeMock = await ExchangeMockFactory.deploy(
      await adapter.getAddress(),
    );
    await adapter.setActive(await exchangeMock.getAddress());
    return { adapter, exchangeMock, verifierMock };
  }

  // ─── deploy ──────────────────────────────────────────────────────────

  describe('deploy', function () {
    it('should work with a V3 feed', async () => {
      await deployAdapter([feedIdV3]);
    });

    it('should work with a V8 feed', async () => {
      await deployAdapter([feedIdV8]);
    });

    it('should work with a V10 feed', async () => {
      await deployAdapter([feedIdV10]);
    });

    it('should work with a V11 feed', async () => {
      await deployAdapter([feedIdV11]);
    });

    it('should work with multiple markets across different versions', async () => {
      await deployAdapter(
        [feedIdV3, feedIdV8, feedIdV10, feedIdV11],
        ['ETH', 'AAPL', 'TSLA', 'GOLD'],
        [18, 18, 18, 18],
        [1, 1, 1, 1],
      );
    });

    it('should work with price multiplier greater than 1', async () => {
      await deployAdapter([feedIdV3], ['1000ETH'], [18], [1000]);
    });

    it('should work with empty markets array', async () => {
      await deployAdapter([], [], [], []);
    });

    it('should revert for invalid activator address', async () => {
      const verifier = await deployMockVerifier();
      await expect(
        AdapterFactory.deploy(
          ethers.ZeroAddress,
          [],
          [],
          [],
          [],
          await verifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid activator address/i);
    });

    it('should revert for argument length mismatch', async () => {
      const verifier = await deployMockVerifier();
      await expect(
        AdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [18, 18],
          [feedIdV3],
          [1],
          await verifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/argument length mismatch/i);
    });

    it('should revert for unsupported report version in feed ID', async () => {
      const verifier = await deployMockVerifier();
      await expect(
        AdapterFactory.deploy(
          owner.address,
          [baseAssetSymbol],
          [18],
          [feedIdUnsupported],
          [1],
          await verifier.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/unsupported report version/i);
    });

    it('should revert for invalid verifier contract address', async () => {
      const notAContract = (await ethers.getSigners())[5].address;
      await expect(
        AdapterFactory.deploy(owner.address, [], [], [], [], notAContract),
      ).to.eventually.be.rejectedWith(
        /invalid chainlink verifier contract address/i,
      );
    });
  });

  // ─── addMarket ───────────────────────────────────────────────────────

  describe('addMarket', function () {
    it('should work for each supported report version', async () => {
      const adapter = await deployAdapter([], [], [], []);

      await adapter.addMarket('ETH', 18, feedIdV3, 1);
      await adapter.addMarket('AAPL', 18, feedIdV8, 1);
      await adapter.addMarket('TSLA', 18, feedIdV10, 1);
      await adapter.addMarket('GOLD', 18, feedIdV11, 1);

      const market = await adapter.marketsByBaseAssetSymbol('ETH');
      expect(market.exists).to.be.true;
      expect(market.feedId).to.equal(feedIdV3);
    });

    it('should work with price multiplier greater than 1', async () => {
      const adapter = await deployAdapter([], [], [], []);
      await adapter.addMarket('1000ETH', 18, feedIdV3, 1000);

      const market = await adapter.marketsByBaseAssetSymbol('1000ETH');
      expect(market.priceMultiplier).to.equal(1000);
    });

    it('should revert for decimals over 18', async () => {
      const adapter = await deployAdapter([], [], [], []);
      await expect(
        adapter.addMarket(baseAssetSymbol, 19, feedIdV3, 1),
      ).to.eventually.be.rejectedWith(
        /asset cannot have more than 18 decimals/i,
      );
    });

    it('should revert for zero feed ID', async () => {
      const adapter = await deployAdapter([], [], [], []);
      await expect(
        adapter.addMarket(baseAssetSymbol, 18, ethers.ZeroHash, 1),
      ).to.eventually.be.rejectedWith(/invalid feed id/i);
    });

    it('should revert for unsupported report version', async () => {
      const adapter = await deployAdapter([], [], [], []);
      await expect(
        adapter.addMarket(baseAssetSymbol, 18, feedIdUnsupported, 1),
      ).to.eventually.be.rejectedWith(/unsupported report version/i);
    });

    it('should revert for duplicate feed ID', async () => {
      const adapter = await deployAdapter([feedIdV3]);
      await expect(
        adapter.addMarket('BTC', 18, feedIdV3, 1),
      ).to.eventually.be.rejectedWith(/already added feed id/i);
    });

    it('should revert for empty base asset symbol', async () => {
      const adapter = await deployAdapter([], [], [], []);
      await expect(
        adapter.addMarket('', 18, feedIdV3, 1),
      ).to.eventually.be.rejectedWith(/invalid base asset symbol/i);
    });

    it('should revert for duplicate base asset symbol', async () => {
      const adapter = await deployAdapter([feedIdV3]);
      await expect(
        adapter.addMarket(baseAssetSymbol, 18, feedIdV3Alt, 1),
      ).to.eventually.be.rejectedWith(/already added base asset symbol/i);
    });

    it('should revert for zero price multiplier', async () => {
      const adapter = await deployAdapter([], [], [], []);
      await expect(
        adapter.addMarket(baseAssetSymbol, 18, feedIdV3, 0),
      ).to.eventually.be.rejectedWith(/invalid price multiplier/i);
    });

    it('should revert when multiplier > 1 but symbol does not start with multiplier', async () => {
      const adapter = await deployAdapter([], [], [], []);
      await expect(
        adapter.addMarket(baseAssetSymbol, 18, feedIdV3, 1000),
      ).to.eventually.be.rejectedWith(
        /base asset symbol does not start with price multiplier/i,
      );
    });

    it('should revert when called by non-admin', async () => {
      const adapter = await deployAdapter([], [], [], []);
      const nonAdmin = (await ethers.getSigners())[8];
      await expect(
        adapter.connect(nonAdmin).addMarket(baseAssetSymbol, 18, feedIdV3, 1),
      ).to.be.revertedWithCustomError(adapter, 'SenderMustBeAdmin');
    });
  });

  // ─── loadPriceForBaseAssetSymbol ─────────────────────────────────────

  describe('loadPriceForBaseAssetSymbol', function () {
    it('should return price after validateIndexPricePayload stores it', async () => {
      const { adapter, exchangeMock } = await deployAdapterWithExchange();
      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV3Payload(feedIdV3, ts, price18d);

      await exchangeMock.validateIndexPricePayload(payload);

      expect(
        await adapter.loadPriceForBaseAssetSymbol(baseAssetSymbol),
      ).to.equal(expectedPips);
    });

    it('should revert when no price has been stored', async () => {
      const adapter = await deployAdapter();
      await expect(
        adapter.loadPriceForBaseAssetSymbol(baseAssetSymbol),
      ).to.eventually.be.rejectedWith(/missing price/i);
    });

    it('should revert for unknown base asset symbol', async () => {
      const adapter = await deployAdapter();
      await expect(
        adapter.loadPriceForBaseAssetSymbol('UNKNOWN'),
      ).to.eventually.be.rejectedWith(/missing price/i);
    });
  });

  // ─── setActive ───────────────────────────────────────────────────────

  describe('setActive', function () {
    it('should set exchange on first call', async () => {
      const adapter = await deployAdapter();
      const exchangeMock = await ExchangeMockFactory.deploy(
        await adapter.getAddress(),
      );

      await adapter.setActive(await exchangeMock.getAddress());

      expect(await adapter.exchange()).to.equal(
        await exchangeMock.getAddress(),
      );
    });

    it('should silently return on second call (dual adapter pattern)', async () => {
      const adapter = await deployAdapter();
      const exchangeMock = await ExchangeMockFactory.deploy(
        await adapter.getAddress(),
      );

      await adapter.setActive(await exchangeMock.getAddress());
      // Second call should not revert
      await adapter.setActive(await exchangeMock.getAddress());

      expect(await adapter.exchange()).to.equal(
        await exchangeMock.getAddress(),
      );
    });

    it('should backfill prices from Exchange markets', async () => {
      const adapter = await deployAdapter();
      const { exchange } = await deployAndAssociateContracts(owner);

      await adapter.setActive(await exchange.getAddress());

      // Exchange has ETH market, adapter has ETH market - backfill should write
      const stored = await adapter.latestIndexPriceByBaseAssetSymbol(
        baseAssetSymbol,
      );
      expect(stored.baseAssetSymbol).to.equal(baseAssetSymbol);
    });

    it('should skip backfill for markets not in the adapter', async () => {
      // Adapter has no markets, Exchange has ETH - the if-branch is false
      const adapter = await deployAdapter([], [], [], []);
      const { exchange } = await deployAndAssociateContracts(owner);

      await adapter.setActive(await exchange.getAddress());

      const stored = await adapter.latestIndexPriceByBaseAssetSymbol(
        baseAssetSymbol,
      );
      expect(stored.timestampInMs).to.equal(0);
    });

    it('should revert when called by non-activator', async () => {
      const adapter = await deployAdapter();
      const nonActivator = (await ethers.getSigners())[8];
      const exchangeMock = await ExchangeMockFactory.deploy(
        await adapter.getAddress(),
      );

      await expect(
        adapter
          .connect(nonActivator)
          .setActive(await exchangeMock.getAddress()),
      ).to.revertedWith(/caller must be activator/i);
    });

    it('should revert when exchange is not a contract', async () => {
      const adapter = await deployAdapter();
      const notAContract = (await ethers.getSigners())[5].address;

      await expect(adapter.setActive(notAContract)).to.revertedWith(
        /invalid exchange contract address/i,
      );
    });
  });

  // ─── validateInitialIndexPricePayloadAdmin ───────────────────────────

  describe('validateInitialIndexPricePayloadAdmin', function () {
    it('should store initial price for a market', async () => {
      const { adapter, verifierMock } = await deployAdapterWithExchange();

      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV3Payload(feedIdV3, ts, price18d);

      await adapter.validateInitialIndexPricePayloadAdmin(payload);

      expect(
        await adapter.loadPriceForBaseAssetSymbol(baseAssetSymbol),
      ).to.equal(expectedPips);
    });

    it('should revert when exchange is not set', async () => {
      const adapter = await deployAdapter();
      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV3Payload(feedIdV3, ts, price18d);

      await expect(
        adapter.validateInitialIndexPricePayloadAdmin(payload),
      ).to.eventually.be.rejectedWith(/exchange not set/i);
    });

    it('should revert when price already exists for market', async () => {
      const { adapter } = await deployAdapterWithExchange();

      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV3Payload(feedIdV3, ts, price18d);

      await adapter.validateInitialIndexPricePayloadAdmin(payload);

      await expect(
        adapter.validateInitialIndexPricePayloadAdmin(payload),
      ).to.eventually.be.rejectedWith(/price already exists for market/i);
    });

    it('should revert when called by non-admin', async () => {
      const { adapter } = await deployAdapterWithExchange();
      const nonAdmin = (await ethers.getSigners())[8];
      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV3Payload(feedIdV3, ts, price18d);

      await expect(
        adapter
          .connect(nonAdmin)
          .validateInitialIndexPricePayloadAdmin(payload),
      ).to.be.revertedWithCustomError(adapter, 'SenderMustBeAdmin');
    });
  });

  // ─── validateIndexPricePayload ───────────────────────────────────────

  describe('validateIndexPricePayload', function () {
    it('should decode V3 report and extract price', async () => {
      const { exchangeMock } = await deployAdapterWithExchange(
        [feedIdV3],
        [baseAssetSymbol],
        [18],
      );
      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV3Payload(feedIdV3, ts, price18d);

      const tx = await exchangeMock.validateIndexPricePayload(payload);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          return (
            exchangeMock.interface.parseLog(log)?.name === 'ValidatedIndexPrice'
          );
        } catch {
          return false;
        }
      });

      const parsed = exchangeMock.interface.parseLog(event!);
      expect(parsed?.args?.indexPrice.baseAssetSymbol).to.equal(
        baseAssetSymbol,
      );
      expect(parsed?.args?.indexPrice.timestampInMs).to.equal(ts * 1000);
      expect(parsed?.args?.indexPrice.price).to.equal(expectedPips);
    });

    it('should decode V8 report and extract midPrice', async () => {
      const { exchangeMock } = await deployAdapterWithExchange(
        [feedIdV8],
        [baseAssetSymbol],
        [18],
      );
      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV8Payload(feedIdV8, ts, price18d);

      const tx = await exchangeMock.validateIndexPricePayload(payload);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          return (
            exchangeMock.interface.parseLog(log)?.name === 'ValidatedIndexPrice'
          );
        } catch {
          return false;
        }
      });

      const parsed = exchangeMock.interface.parseLog(event!);
      expect(parsed?.args?.indexPrice.price).to.equal(expectedPips);
    });

    it('should decode V10 report and extract tokenizedPrice', async () => {
      const { exchangeMock } = await deployAdapterWithExchange(
        [feedIdV10],
        [baseAssetSymbol],
        [18],
      );
      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV10Payload(feedIdV10, ts, price18d);

      const tx = await exchangeMock.validateIndexPricePayload(payload);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          return (
            exchangeMock.interface.parseLog(log)?.name === 'ValidatedIndexPrice'
          );
        } catch {
          return false;
        }
      });

      const parsed = exchangeMock.interface.parseLog(event!);
      expect(parsed?.args?.indexPrice.price).to.equal(expectedPips);
    });

    it('should decode V11 report and extract lastTradedPrice', async () => {
      const { exchangeMock } = await deployAdapterWithExchange(
        [feedIdV11],
        [baseAssetSymbol],
        [18],
      );
      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV11Payload(feedIdV11, ts, price18d);

      const tx = await exchangeMock.validateIndexPricePayload(payload);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          return (
            exchangeMock.interface.parseLog(log)?.name === 'ValidatedIndexPrice'
          );
        } catch {
          return false;
        }
      });

      const parsed = exchangeMock.interface.parseLog(event!);
      expect(parsed?.args?.indexPrice.price).to.equal(expectedPips);
    });

    it('should apply price multiplier', async () => {
      const { exchangeMock } = await deployAdapterWithExchange(
        [feedIdV3],
        ['1000ETH'],
        [18],
        [1000],
      );
      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV3Payload(feedIdV3, ts, price18d);

      const tx = await exchangeMock.validateIndexPricePayload(payload);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          return (
            exchangeMock.interface.parseLog(log)?.name === 'ValidatedIndexPrice'
          );
        } catch {
          return false;
        }
      });

      const parsed = exchangeMock.interface.parseLog(event!);
      expect(parsed?.args?.indexPrice.price).to.equal(
        expectedPips * BigInt(1000),
      );
    });

    it('should update latestIndexPriceByBaseAssetSymbol', async () => {
      const { adapter, exchangeMock } = await deployAdapterWithExchange();
      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV3Payload(feedIdV3, ts, price18d);

      await exchangeMock.validateIndexPricePayload(payload);

      const stored = await adapter.latestIndexPriceByBaseAssetSymbol(
        baseAssetSymbol,
      );
      expect(stored.price).to.equal(expectedPips);
      expect(stored.timestampInMs).to.equal(ts * 1000);
    });

    it('should revert for unsupported report version in payload', async () => {
      const { exchangeMock } = await deployAdapterWithExchange();
      const ts = Math.floor(Date.now() / 1000);
      // Build payload with version prefix 0x0002 (unsupported)
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
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
        [feedIdV3, ts, ts, 0, 0, ts + 3600, price18d, price18d, price18d],
      );
      const reportData = ethers.concat([new Uint8Array([0x00, 0x02]), encoded]);
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32[3]', 'bytes'],
        [[ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash], reportData],
      );

      await expect(
        exchangeMock.validateIndexPricePayload(payload),
      ).to.eventually.be.rejectedWith(/unsupported report version/i);
    });

    it('should revert for unknown feed ID', async () => {
      const { exchangeMock } = await deployAdapterWithExchange();
      const ts = Math.floor(Date.now() / 1000);
      // Use a V3 feed ID that wasn't registered
      const payload = buildV3Payload(feedIdV3Alt, ts, price18d);

      await expect(
        exchangeMock.validateIndexPricePayload(payload),
      ).to.eventually.be.rejectedWith(/unknown feed id/i);
    });

    it('should revert for non-positive price (zero)', async () => {
      const { exchangeMock } = await deployAdapterWithExchange();
      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV3Payload(feedIdV3, ts, BigInt(0));

      await expect(
        exchangeMock.validateIndexPricePayload(payload),
      ).to.eventually.be.rejectedWith(/unexpected non-positive price/i);
    });

    it('should revert for report version mismatch between payload and feed ID', async () => {
      // Register a V8 feed but submit a V3 payload with the V8 feedId
      const { exchangeMock } = await deployAdapterWithExchange(
        [feedIdV8],
        [baseAssetSymbol],
        [18],
      );
      // Version prefix says V3 (0x03), but feedId starts with 0x0008
      const payload = buildMismatchedVersionPayload(feedIdV8, 0x03, price18d);

      await expect(
        exchangeMock.validateIndexPricePayload(payload),
      ).to.eventually.be.rejectedWith(/report version mismatch/i);
    });

    it('should revert when exchange is not set', async () => {
      const adapter = await deployAdapter();

      await expect(
        adapter.validateIndexPricePayload('0x00'),
      ).to.eventually.be.rejectedWith(/exchange not set/i);
    });

    it('should revert when called by non-exchange wallet', async () => {
      const { adapter } = await deployAdapterWithExchange();

      await expect(
        adapter.validateIndexPricePayload('0x00'),
      ).to.eventually.be.rejectedWith(/caller must be exchange contract/i);
    });

    it('should revert when feeManager is set', async () => {
      const { exchangeMock, verifierMock } = await deployAdapterWithExchange();

      const nonZeroAddress = (await ethers.getSigners())[5].address;
      await (
        verifierMock as unknown as {
          setFeeManager: (addr: string) => Promise<void>;
        }
      ).setFeeManager(nonZeroAddress);

      const ts = Math.floor(Date.now() / 1000);
      const payload = buildV3Payload(feedIdV3, ts, price18d);

      await expect(
        exchangeMock.validateIndexPricePayload(payload),
      ).to.eventually.be.rejectedWith(/feemanager not supported/i);
    });
  });
});
