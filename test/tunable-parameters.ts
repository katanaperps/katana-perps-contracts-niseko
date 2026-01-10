import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import { deployAndAssociateContracts } from './helpers';

import type { Exchange_v1 } from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('Exchange', function () {
  let exchange: Exchange_v1;
  let ownerWallet: SignerWithAddress;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    [ownerWallet] = await ethers.getSigners();
    const results = await deployAndAssociateContracts(ownerWallet);
    exchange = results.exchange;
  });

  describe('setChainPropagationPeriod', async function () {
    it('should work for valid argument', async () => {
      await exchange.connect(ownerWallet).setChainPropagationPeriod(22);

      expect((await exchange.chainPropagationPeriodInS()).toString()).to.equal(
        '22',
      );
    });

    it('should revert for argument over max', async () => {
      await expect(
        exchange.setChainPropagationPeriod('10000000000'),
      ).to.eventually.be.rejectedWith(/NewValueExceedsMaximum/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setChainPropagationPeriod(0),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
    });
  });

  describe('setDelegatedKeyExpirationPeriod', async function () {
    it('should work for valid argument', async () => {
      await exchange.connect(ownerWallet).setDelegatedKeyExpirationPeriod(22);

      expect(
        (await exchange.delegateKeyExpirationPeriodInMs()).toString(),
      ).to.equal('22');
    });

    it('should revert for argument over max', async () => {
      await expect(
        exchange
          .connect(ownerWallet)
          .setDelegatedKeyExpirationPeriod('100000000000000'),
      ).to.eventually.be.rejectedWith(/NewValueExceedsMaximum/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setDelegatedKeyExpirationPeriod(0),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
    });
  });

  describe('setPositionBelowMinimumLiquidationPriceToleranceMultiplier', async function () {
    it('should work for valid argument', async () => {
      await exchange
        .connect(ownerWallet)
        .setPositionBelowMinimumLiquidationPriceToleranceMultiplier(200000);

      expect(
        (
          await exchange.positionBelowMinimumLiquidationPriceToleranceMultiplier()
        ).toString(),
      ).to.equal('200000');
    });

    it('should revert for argument over max', async () => {
      await expect(
        exchange
          .connect(ownerWallet)
          .setPositionBelowMinimumLiquidationPriceToleranceMultiplier(
            '100000000000000',
          ),
      ).to.eventually.be.rejectedWith(/NewValueExceedsMaximum/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setPositionBelowMinimumLiquidationPriceToleranceMultiplier(0),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
    });
  });
});
