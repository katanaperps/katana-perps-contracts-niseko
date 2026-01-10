import { ethers, network } from 'hardhat';

import { baseAssetSymbol, expect } from './helpers';

import type {
  ChainlinkAggregatorMock__factory,
  ChainlinkOraclePriceAdapter__factory,
} from '../typechain-types';

describe('oracle price adapters', function () {
  describe('ChainlinkOraclePriceAdapter', function () {
    let ChainlinkOraclePriceAdapterFactory: ChainlinkOraclePriceAdapter__factory;
    let ChainlinkAggregatorFactory: ChainlinkAggregatorMock__factory;

    before(async () => {
      await network.provider.send('hardhat_reset');
      [ChainlinkAggregatorFactory, ChainlinkOraclePriceAdapterFactory] =
        await Promise.all([
          ethers.getContractFactory('ChainlinkAggregatorMock'),
          ethers.getContractFactory('ChainlinkOraclePriceAdapter'),
        ]);
    });

    describe('deploy', async function () {
      it('should work for valid arguments', async () => {
        await ChainlinkOraclePriceAdapterFactory.deploy(
          [baseAssetSymbol],
          [await (await ChainlinkAggregatorFactory.deploy()).getAddress()],
        );
      });

      it('should revert for mismatched argument lengths', async () => {
        await expect(
          ChainlinkOraclePriceAdapterFactory.deploy(
            [baseAssetSymbol, baseAssetSymbol],
            [await (await ChainlinkAggregatorFactory.deploy()).getAddress()],
          ),
        ).to.be.revertedWith(/argument length mismatch/i);
      });

      it('should revert for invalid base asset symbol', async () => {
        await expect(
          ChainlinkOraclePriceAdapterFactory.deploy(
            [''],
            [await (await ChainlinkAggregatorFactory.deploy()).getAddress()],
          ),
        ).to.be.revertedWith(/invalid base asset symbol/i);
      });

      it('should revert for invalid aggregator address', async () => {
        await expect(
          ChainlinkOraclePriceAdapterFactory.deploy(
            [baseAssetSymbol, baseAssetSymbol],
            [
              await (await ChainlinkAggregatorFactory.deploy()).getAddress(),
              ethers.ZeroAddress,
            ],
          ),
        ).to.be.revertedWith(/invalid chainlink aggregator address/i);
      });
    });

    describe('addBaseAssetSymbolAndAggregator', async function () {
      it('should work for valid base asset symbol and aggregator', async () => {
        const adapter = await ChainlinkOraclePriceAdapterFactory.deploy(
          [baseAssetSymbol],
          [await (await ChainlinkAggregatorFactory.deploy()).getAddress()],
        );

        await adapter.addBaseAssetSymbolAndAggregator(
          'XYZ',
          await (await ChainlinkAggregatorFactory.deploy()).getAddress(),
        );
      });

      it('should revert when not sent by admin', async () => {
        const adapter = await ChainlinkOraclePriceAdapterFactory.deploy(
          [baseAssetSymbol],
          [await (await ChainlinkAggregatorFactory.deploy()).getAddress()],
        );

        await expect(
          adapter
            .connect((await ethers.getSigners())[5])
            .addBaseAssetSymbolAndAggregator(
              'XYZ',
              await (await ChainlinkAggregatorFactory.deploy()).getAddress(),
            ),
        ).to.be.revertedWithCustomError(adapter, 'SenderMustBeAdmin');
      });

      it('should revert for invalid base asset symbol', async () => {
        const adapter = await ChainlinkOraclePriceAdapterFactory.deploy(
          [baseAssetSymbol],
          [await (await ChainlinkAggregatorFactory.deploy()).getAddress()],
        );

        await expect(
          adapter.addBaseAssetSymbolAndAggregator(
            '',
            await (await ChainlinkAggregatorFactory.deploy()).getAddress(),
          ),
        ).to.be.revertedWith(/invalid base asset symbol/i);
      });

      it('should revert for invalid await aggregator.getAddress()', async () => {
        const adapter = await ChainlinkOraclePriceAdapterFactory.deploy(
          [baseAssetSymbol],
          [await (await ChainlinkAggregatorFactory.deploy()).getAddress()],
        );

        await expect(
          adapter.addBaseAssetSymbolAndAggregator('XYZ', ethers.ZeroAddress),
        ).to.be.revertedWith(/invalid chainlink aggregator/i);
      });

      it('should revert for already added base asset symbol', async () => {
        const adapter = await ChainlinkOraclePriceAdapterFactory.deploy(
          [baseAssetSymbol],
          [await (await ChainlinkAggregatorFactory.deploy()).getAddress()],
        );

        await expect(
          adapter.addBaseAssetSymbolAndAggregator(
            baseAssetSymbol,
            await (await ChainlinkAggregatorFactory.deploy()).getAddress(),
          ),
        ).to.be.revertedWith(/already added base asset symbol/i);
      });

      it('should revert for already added aggregator', async () => {
        const aggregator = await ChainlinkAggregatorFactory.deploy();
        const adapter = await ChainlinkOraclePriceAdapterFactory.deploy(
          [baseAssetSymbol],
          [await aggregator.getAddress()],
        );

        await expect(
          adapter.addBaseAssetSymbolAndAggregator(
            'XYZ',
            await aggregator.getAddress(),
          ),
        ).to.be.revertedWith(/already added chainlink aggregator/i);
      });
    });

    describe('loadPriceForBaseAssetSymbol', async function () {
      it('should revert for invalid symbol', async () => {
        const adapter = await ChainlinkOraclePriceAdapterFactory.deploy(
          [baseAssetSymbol],
          [await (await ChainlinkAggregatorFactory.deploy()).getAddress()],
        );

        await expect(
          adapter.loadPriceForBaseAssetSymbol('XYZ'),
        ).to.be.revertedWith(/missing aggregator for symbol/i);
      });

      it('should revert for negative feed price', async () => {
        const chainlinkAggregator = await ChainlinkAggregatorFactory.deploy();

        const adapter = await ChainlinkOraclePriceAdapterFactory.deploy(
          [baseAssetSymbol],
          [await chainlinkAggregator.getAddress()],
        );

        await chainlinkAggregator.setPrice(-100);
        await expect(
          adapter.loadPriceForBaseAssetSymbol(baseAssetSymbol),
        ).to.be.revertedWith(/unexpected non-positive feed price/i);
      });

      it('should revert for negative price after conversion to pips', async () => {
        const chainlinkAggregator = await ChainlinkAggregatorFactory.deploy();

        const adapter = await ChainlinkOraclePriceAdapterFactory.deploy(
          [baseAssetSymbol],
          [await chainlinkAggregator.getAddress()],
        );

        await chainlinkAggregator.setPrice(1000);
        await chainlinkAggregator.setDecimals(20);
        await expect(
          adapter.loadPriceForBaseAssetSymbol(baseAssetSymbol),
        ).to.be.revertedWith(/unexpected non-positive price/i);
      });
    });
  });
});
