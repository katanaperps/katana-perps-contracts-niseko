import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import { decimalToAssetUnits, fieldUpgradeDelayInS } from '../lib';

import {
  buildIndexPrice,
  deployAndAssociateContracts,
  executeTrade,
  fundWallets,
  quoteAssetDecimals,
} from './helpers';

import type {
  Exchange_v1,
  Governance,
  ManagedAccountProviderMock,
  USDC,
  BridgeAdapterMock,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('Exchange', function () {
  let exchange: Exchange_v1;
  let governance: Governance;
  let ownerWallet: SignerWithAddress;
  let usdc: USDC;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    [ownerWallet] = await ethers.getSigners();
    const results = await deployAndAssociateContracts(ownerWallet);
    exchange = results.exchange;
    governance = results.governance;
    usdc = results.usdc;
  });

  describe('setExitFundWallet', async function () {
    it('should work for valid wallet', async () => {
      const [, exitFundWallet] = await ethers.getSigners();

      await exchange.setExitFundWallet(exitFundWallet.address);

      expect(await exchange.exitFundWallet()).to.equal(exitFundWallet.address);
    });

    it('should revert for invalid wallet', async () => {
      await expect(
        exchange.setExitFundWallet(ethers.ZeroAddress),
      ).to.be.revertedWith(/invalid wallet address/i);
    });

    it('should revert for wallet already set', async () => {
      await expect(
        exchange.setExitFundWallet(ownerWallet.address),
      ).to.be.revertedWith(/must be different from current exit fund/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setExitFundWallet(ownerWallet.address),
      ).to.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
    });

    it('should revert when EF has an open position', async () => {
      const { exchange: exitedExchange } = await bootstrapExitedWallet();

      await expect(
        exitedExchange.setExitFundWallet(ownerWallet.address),
      ).to.be.revertedWith(/current exit fund cannot have open balance/i);
    });

    it('should revert when EF has open quote balance', async () => {
      const {
        chainlinkAggregator,
        exchange: exitedExchange,
        trader2Wallet,
      } = await bootstrapExitedWallet();

      await chainlinkAggregator.setPrice(
        decimalToAssetUnits('1500.00000000', quoteAssetDecimals),
      );
      await exitedExchange
        .connect(trader2Wallet)
        .exitWallet(trader2Wallet.address);
      await exitedExchange.withdrawExit(trader2Wallet.address);

      await expect(
        exitedExchange.setExitFundWallet(ownerWallet.address),
      ).to.be.revertedWith(/current exit fund cannot have open balance/i);
    });

    it('should revert when new EF has an open position', async () => {
      const [, traderWallet] = await ethers.getSigners();
      await fundWallets([traderWallet], ownerWallet, exchange, usdc);

      await expect(
        exchange.setExitFundWallet(traderWallet.address),
      ).to.be.revertedWith(/new exit fund cannot have open balance/i);
    });

    it('should revert when new EF is associated with MA', async () => {
      // Create a new wallet to be associated with an MA
      const [, , , , , , , , , , managerWallet] = await ethers.getSigners();

      // Deploy ManagedAccountProviderMock
      const managedAccountProvider: ManagedAccountProviderMock = await (
        await ethers.getContractFactory('ManagedAccountProviderMock')
      ).deploy(await exchange.getAddress());

      await governance.initiateManagedAccountProvidersUpgrade([
        await managedAccountProvider.getAddress(),
      ]);
      await time.increase(fieldUpgradeDelayInS);
      await governance.finalizeManagedAccountProvidersUpgrade([
        await managedAccountProvider.getAddress(),
      ]);

      // Deploy BridgeAdapterMock and configure it
      const bridgeAdapterMock: BridgeAdapterMock = await (
        await ethers.getContractFactory('BridgeAdapterMock')
      ).deploy();
      await bridgeAdapterMock.setManagedAccountProvider(
        await managedAccountProvider.getAddress(),
      );
      await bridgeAdapterMock.setExchange(await exchange.getAddress());

      await governance.initiateBridgeAdaptersUpgrade([
        await bridgeAdapterMock.getAddress(),
      ]);
      await time.increase(fieldUpgradeDelayInS);
      await governance.finalizeBridgeAdaptersUpgrade([
        await bridgeAdapterMock.getAddress(),
      ]);

      // Add the wallet as a managed account
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Attempt to set the MA-associated wallet as exit fund wallet
      await expect(
        exchange.setExitFundWallet(managerWallet.address),
      ).to.be.revertedWith('New Exit Fund cannot be associated with MA');
    });
  });

  describe('setFeeWallet', async function () {
    it('should work for valid wallet', async () => {
      const [, feeWallet] = await ethers.getSigners();

      await exchange.setFeeWallet(feeWallet.address);

      expect(await exchange.feeWallet()).to.equal(feeWallet.address);
    });

    it('should revert for invalid wallet', async () => {
      await expect(
        exchange.setFeeWallet(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(exchange, 'InvalidWalletAddress');
    });

    it('should revert for wallet already set', async () => {
      await expect(
        exchange.setFeeWallet(ownerWallet.address),
      ).to.be.revertedWithCustomError(
        exchange,
        'NewValueMustBeDifferentFromCurrent',
      );
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setFeeWallet(ownerWallet.address),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
    });
  });

  describe('setDispatcher', async function () {
    it('should work for valid wallet', async () => {
      const [ownerWallet, dispatcherWallet] = await ethers.getSigners();

      await exchange
        .connect(ownerWallet)
        .setDispatcher(dispatcherWallet.address);

      expect(await exchange.dispatcherWallet()).to.equal(
        dispatcherWallet.address,
      );

      const events = await exchange.queryFilter(
        exchange.filters.DispatcherChanged(),
      );
      expect(events).to.have.lengthOf(2);
      expect(events[1].args?.previousValue).to.equal(ownerWallet.address);
      expect(events[1].args?.newValue).to.equal(dispatcherWallet.address);
    });

    it('should revert for invalid wallet', async () => {
      await expect(
        exchange.setDispatcher(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(exchange, 'InvalidWalletAddress');
    });

    it('should revert for wallet already set', async () => {
      await expect(
        exchange.setDispatcher(ownerWallet.address),
      ).to.be.revertedWithCustomError(
        exchange,
        'NewValueMustBeDifferentFromCurrent',
      );
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setDispatcher(ownerWallet.address),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
    });
  });
});

async function bootstrapExitedWallet() {
  const [
    ownerWallet,
    dispatcherWallet,
    exitFundWallet,
    feeWallet,
    insuranceFundWallet,
    indexPriceServiceWallet,
    trader1Wallet,
    trader2Wallet,
  ] = await ethers.getSigners();
  const { chainlinkAggregator, exchange, indexPriceAdapter, usdc } =
    await deployAndAssociateContracts(
      ownerWallet,
      dispatcherWallet,
      exitFundWallet,
      feeWallet,
      indexPriceServiceWallet,
      insuranceFundWallet,
    );

  await usdc.connect(dispatcherWallet).faucet(dispatcherWallet.address);

  await fundWallets(
    [trader1Wallet, trader2Wallet, insuranceFundWallet],
    dispatcherWallet,
    exchange,
    usdc,
  );

  const indexPrice = await buildIndexPrice(
    await exchange.getAddress(),
    indexPriceServiceWallet,
  );

  await executeTrade(
    exchange,
    dispatcherWallet,
    indexPrice,
    await indexPriceAdapter.getAddress(),
    trader1Wallet,
    trader2Wallet,
  );

  // Deposit additional quote to allow for EF exit withdrawal
  const depositQuantity = ethers.parseUnits('100000.0', quoteAssetDecimals);
  await usdc
    .connect(ownerWallet)
    .approve(await exchange.getAddress(), depositQuantity);
  await (
    await exchange
      .connect(ownerWallet)
      .deposit(depositQuantity, ethers.ZeroAddress)
  ).wait();

  await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);
  await exchange.withdrawExit(trader1Wallet.address);

  return { chainlinkAggregator, exchange, trader1Wallet, trader2Wallet };
}
