import { time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, network } from 'hardhat';

import {
  decimalToPips,
  exitFundWithdrawDelayInS,
  fieldUpgradeDelayInS,
} from '../lib';

import {
  baseAssetSymbol,
  buildIndexPrice,
  deployAndAssociateContracts,
  executeTrade,
  expect,
  fundWallets,
  quoteAssetSymbol,
} from './helpers';

import type { IndexPrice } from '../lib';
import type {
  ChainlinkAggregatorMock,
  Exchange_v1,
  Governance,
  KatanaPerpsIndexAndOraclePriceAdapter,
  ManagedAccountProviderMock,
  USDC,
  WithdrawExitValidationsMock,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('Exchange', function () {
  let chainlinkAggregator: ChainlinkAggregatorMock;
  let dispatcherWallet: SignerWithAddress;
  let exchange: Exchange_v1;
  let exitFundWallet: SignerWithAddress;
  let governance: Governance;
  let indexPrice: IndexPrice;
  let indexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;
  let indexPriceServiceWallet: SignerWithAddress;
  let insuranceFundWallet: SignerWithAddress;
  let ownerWallet: SignerWithAddress;
  let trader1Wallet: SignerWithAddress;
  let trader2Wallet: SignerWithAddress;
  let usdc: USDC;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    const wallets = await ethers.getSigners();

    const [feeWallet] = wallets;
    [
      ,
      dispatcherWallet,
      exitFundWallet,
      indexPriceServiceWallet,
      insuranceFundWallet,
      ownerWallet,
      trader1Wallet,
      trader2Wallet,
    ] = wallets;
    const results = await deployAndAssociateContracts(
      ownerWallet,
      dispatcherWallet,
      exitFundWallet,
      feeWallet,
      indexPriceServiceWallet,
      insuranceFundWallet,
    );
    chainlinkAggregator = results.chainlinkAggregator;
    exchange = results.exchange;
    governance = results.governance;
    indexPriceAdapter = results.indexPriceAdapter;
    usdc = results.usdc;

    await usdc.faucet(dispatcherWallet.address);

    await fundWallets(
      [trader1Wallet, trader2Wallet],
      dispatcherWallet,
      exchange,
      results.usdc,
    );

    indexPrice = await buildIndexPrice(
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
  });

  async function createVaultWithExitedManagerWallet(): Promise<
    [ManagedAccountProviderMock, SignerWithAddress]
  > {
    const depositorWallet = trader1Wallet;
    const managerWallet = (await ethers.getSigners())[15];

    // 1. Deploy ManagedAccountProviderMock
    const managedAccountProvider: ManagedAccountProviderMock = await (
      await ethers.getContractFactory('ManagedAccountProviderMock')
    ).deploy(await exchange.getAddress());

    // 2. Upgrade the Exchange to whitelist it
    await governance.initiateManagedAccountProvidersUpgrade([
      await managedAccountProvider.getAddress(),
    ]);
    await time.increase(fieldUpgradeDelayInS);
    await governance.finalizeManagedAccountProvidersUpgrade([
      await managedAccountProvider.getAddress(),
    ]);

    // 3. Deploy bridge adapter mock
    const bridgeAdapterMock = await (
      await ethers.getContractFactory('BridgeAdapterMock')
    ).deploy();
    await bridgeAdapterMock.setManagedAccountProvider(
      await managedAccountProvider.getAddress(),
    );
    await bridgeAdapterMock.setExchange(await exchange.getAddress());
    await usdc.approve(bridgeAdapterMock, BigInt(2) ** BigInt(64));

    // 4. Upgrade the Exchange to whitelist it
    await governance.initiateBridgeAdaptersUpgrade([
      await bridgeAdapterMock.getAddress(),
    ]);
    await time.increase(fieldUpgradeDelayInS);
    await governance.finalizeBridgeAdaptersUpgrade([
      await bridgeAdapterMock.getAddress(),
    ]);

    // 5. Associate manager wallet with provider
    await managedAccountProvider.addManagedAccount(managerWallet.address, '0x');

    // 6. Make a deposit
    const depositQuantityInDecimal = '2000.00000000';
    const depositQuantityPips = decimalToPips(depositQuantityInDecimal);
    await bridgeAdapterMock.connect(ownerWallet).depositToManagedAccount(
      ethers.parseUnits(depositQuantityInDecimal, 6), // quantityInAssetUnits
      trader1Wallet.address, // depositorWallet
      await managedAccountProvider.getAddress(), // managedAccountProvider
      '0x', // managedAccountProviderPayload
      managerWallet.address,
    );
    const depositIndex = await exchange.depositIndex();
    await exchange
      .connect(dispatcherWallet)
      .applyPendingDepositToManagedAccount(
        depositIndex,
        depositQuantityPips,
        managerWallet.address,
      );

    // 7. Make a trade so manager wallet has an open position
    await fundWallets([trader2Wallet], dispatcherWallet, exchange, usdc);
    await executeTrade(
      exchange,
      dispatcherWallet,
      await buildIndexPrice(
        await exchange.getAddress(),
        indexPriceServiceWallet,
      ),
      await indexPriceAdapter.getAddress(),
      managerWallet,
      trader2Wallet,
      baseAssetSymbol,
    );

    // 8. Exit the manager wallet
    await managedAccountProvider
      .connect(depositorWallet)
      .exitWallet(managerWallet.address);

    return [managedAccountProvider, managerWallet];
  }

  describe('exitWallet', function () {
    it('should work for non-exited wallet', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      const exitEvents = await exchange.queryFilter(
        exchange.filters.WalletExited(),
      );
      expect(exitEvents).to.have.lengthOf(1);
      expect(exitEvents[0].args?.wallet).to.equal(trader1Wallet.address);
    });

    it('should fail for exited wallet', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);
      await expect(
        exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address),
      ).to.eventually.be.rejectedWith(/wallet already exited/i);
    });

    it('should fail for EF', async function () {
      await expect(
        exchange.connect(exitFundWallet).exitWallet(exitFundWallet.address),
      ).to.eventually.be.rejectedWith(/cannot exit EF/i);
    });

    it('should fail for IF', async function () {
      await expect(
        exchange
          .connect(insuranceFundWallet)
          .exitWallet(insuranceFundWallet.address),
      ).to.eventually.be.rejectedWith(/cannot exit IF/i);
    });

    it('should revert when caller is not MA for manager wallet', async function () {
      const [, managerWallet] = await createVaultWithExitedManagerWallet();

      // Attempt to call 'exitWallet' directly from the manager wallet
      // instead of through the MA contract, and assert that it reverts
      await expect(
        exchange.connect(managerWallet).exitWallet(managerWallet.address),
      ).to.be.revertedWith('Caller must be MA when exiting manager wallet');
    });

    it('should revert when caller is not the wallet being exited', async function () {
      // Attempt to call 'exitWallet' for trader2's wallet from trader1's wallet
      await expect(
        exchange.connect(trader1Wallet).exitWallet(trader2Wallet.address),
      ).to.be.revertedWith('Caller must be wallet to exit');
    });
  });

  describe('withdrawExit', function () {
    it('should work for exited wallet', async function () {
      expect(
        (
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            trader1Wallet.address,
          )
        ).toString(),
      ).to.not.equal('0');

      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);
      await exchange.withdrawExit(trader1Wallet.address);

      expect(
        (
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            trader1Wallet.address,
          )
        ).toString(),
      ).to.equal('0');

      expect(
        (
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            trader2Wallet.address,
          )
        ).toString(),
      ).to.not.equal('0');

      await exchange.connect(trader2Wallet).exitWallet(trader2Wallet.address);
      await exchange.withdrawExit(trader2Wallet.address);

      expect(
        (
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            trader2Wallet.address,
          )
        ).toString(),
      ).to.equal('0');

      // Subsequent calls to withdraw exit perform a zero transfer
      await exchange.withdrawExit(trader1Wallet.address);
      await exchange.withdrawExit(trader2Wallet.address);
    });

    it('should work for exited wallet with negative EAV', async function () {
      expect(
        (
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            trader1Wallet.address,
          )
        ).toString(),
      ).to.not.equal('0');

      await chainlinkAggregator.setPrice(decimalToPips('100000.00000000'));

      expect(
        (
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            trader1Wallet.address,
          )
        ).toString(),
      ).to.equal('0');

      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);
      await exchange.withdrawExit(trader1Wallet.address);
    });

    it('should work for EF', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);
      await exchange.withdrawExit(trader1Wallet.address);

      // Expire EF withdraw delay
      await time.increase(exitFundWithdrawDelayInS);

      // Deposit additional quote to allow for EF exit withdrawal
      await fundWallets(
        [ownerWallet],
        dispatcherWallet,
        exchange,
        usdc,
        '100000.0',
      );

      expect(
        (
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            exitFundWallet.address,
          )
        ).toString(),
      ).to.not.equal('0');

      await exchange.withdrawExit(exitFundWallet.address);

      expect(
        (
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            exitFundWallet.address,
          )
        ).toString(),
      ).to.equal('0');

      // Subsequent calls to withdraw exit perform a zero transfer
      await exchange.withdrawExit(exitFundWallet.address);
    });

    it('should revert for exited wallet before finalized', async function () {
      await exchange.setChainPropagationPeriod(10000);
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);
      await expect(
        exchange.withdrawExit(trader1Wallet.address),
      ).to.eventually.be.rejectedWith(/wallet exit not finalized/i);
    });

    it('should revert when called by a wallet associated with an MA', async function () {
      const [, managerWallet] = await createVaultWithExitedManagerWallet();

      // 5. Attempt to call 'withdrawExit' from the new vault's manager account
      // and assert that it reverts
      await expect(
        exchange.withdrawExit(managerWallet.address),
      ).to.be.revertedWith('Cannot withdraw exit from MA manager wallet');
    });

    describe('validateExitQuoteQuantityAndCoerceIfNeeded', async function () {
      let withdrawExitValidationsMock: WithdrawExitValidationsMock;

      beforeEach(async () => {
        withdrawExitValidationsMock = await (
          await ethers.getContractFactory('WithdrawExitValidationsMock')
        ).deploy();
      });

      it('should coerce negative values within tolerance', async function () {
        expect(
          (
            await withdrawExitValidationsMock.validateExitQuoteQuantityAndCoerceIfNeeded(
              false,
              -5,
            )
          ).toString(),
        ).to.equal('0');
        expect(
          (
            await withdrawExitValidationsMock.validateExitQuoteQuantityAndCoerceIfNeeded(
              false,
              -9999,
            )
          ).toString(),
        ).to.equal('0');
      });

      it('should not coerce positive values', async function () {
        expect(
          (
            await withdrawExitValidationsMock.validateExitQuoteQuantityAndCoerceIfNeeded(
              false,
              5,
            )
          ).toString(),
        ).to.equal('5');
        expect(
          (
            await withdrawExitValidationsMock.validateExitQuoteQuantityAndCoerceIfNeeded(
              false,
              1000000,
            )
          ).toString(),
        ).to.equal('1000000');
      });

      it('should revert for negative values outside tolerance', async function () {
        await expect(
          withdrawExitValidationsMock.validateExitQuoteQuantityAndCoerceIfNeeded(
            false,
            -1000000,
          ),
        ).to.eventually.be.rejectedWith(/negative quote after exit/i);
      });

      it('should revert for negative values inside tolerance for EF', async function () {
        await expect(
          withdrawExitValidationsMock.validateExitQuoteQuantityAndCoerceIfNeeded(
            true,
            -1,
          ),
        ).to.eventually.be.rejectedWith(/negative quote after exit/i);
      });
    });
  });

  describe('withdrawExitAdmin', function () {
    it('should work for exited wallet during system recovery', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);
      exchange.withdrawExit(trader1Wallet.address);
      await exchange.setChainPropagationPeriod(10000);
      await exchange.connect(trader2Wallet).exitWallet(trader2Wallet.address);

      await exchange.withdrawExitAdmin(trader2Wallet.address);

      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader2Wallet.address,
            quoteAssetSymbol,
          )
        ).toString(),
      ).to.equal('0');

      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader2Wallet.address,
            baseAssetSymbol,
          )
        ).toString(),
      ).to.equal('0');
      expect(
        (
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            trader2Wallet.address,
          )
        ).toString(),
      ).to.equal('0');
    });

    it('should revert for wallet not exited', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);
      await exchange.withdrawExit(trader1Wallet.address);

      await expect(
        exchange.withdrawExitAdmin(trader2Wallet.address),
      ).to.eventually.be.rejectedWith(/wallet not exited/i);

      await expect(
        exchange.withdrawExitAdmin(exitFundWallet.address),
      ).to.eventually.be.rejectedWith(/wallet not exited/i);
    });

    it('should revert when not called by admin or dispatch', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);
      exchange.withdrawExit(trader1Wallet.address);

      await expect(
        exchange
          .connect(trader1Wallet)
          .withdrawExitAdmin(exitFundWallet.address),
      ).to.be.revertedWithCustomError(
        exchange,
        'SenderMustBeAdminOrDispatcher',
      );
    });

    it('should revert when not in system recovery', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      await expect(
        exchange.withdrawExitAdmin(trader1Wallet.address),
      ).to.be.revertedWithCustomError(exchange, 'ExitFundHasNoPositions');
    });

    it('should revert when called for a wallet associated with an MA', async function () {
      const [vault, managerWallet] = await createVaultWithExitedManagerWallet();

      // Withdraw manager wallet so EF has an open position
      await vault
        .connect(managerWallet)
        .withdrawExit(managerWallet.address, managerWallet.address, 100);

      // Attempt to call 'withdrawExitAdmin' from the new vault's manager
      // wallet and assert that it reverts
      await expect(
        exchange.withdrawExitAdmin(managerWallet.address),
      ).to.be.revertedWith('Cannot withdraw exit from MA manager wallet');
    });
  });

  describe('clearWalletExit', function () {
    it('should work for exited wallet', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);
      await exchange.withdrawExit(trader1Wallet.address);

      await exchange.connect(trader1Wallet).clearWalletExit();

      const exitEvents = await exchange.queryFilter(
        exchange.filters.WalletExitCleared(),
      );
      expect(exitEvents).to.have.lengthOf(1);
      expect(exitEvents[0].args?.wallet).to.equal(trader1Wallet.address);
    });

    it('should revert for walled not exited', async function () {
      await expect(
        exchange.connect(trader1Wallet).clearWalletExit(),
      ).to.eventually.be.rejectedWith(/wallet exit not finalized/i);
    });

    it('should revert for wallet exited but not withdrawn', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      await expect(
        exchange.connect(trader1Wallet).clearWalletExit(),
      ).to.eventually.be.rejectedWith(/must withdraw exit before clearing/i);
    });

    it('should revert when called for a wallet associated with an MA', async function () {
      const [vault, managerWallet] = await createVaultWithExitedManagerWallet();

      // Withdraw manager wallet exit
      await vault
        .connect(managerWallet)
        .withdrawExit(
          managerWallet.address,
          managerWallet.address,
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            managerWallet.address,
          ),
        );

      // Attempt to call 'clearWalletExit' from the MA manager wallet
      // and assert that it reverts
      await expect(
        exchange.connect(managerWallet).clearWalletExit(),
      ).to.be.revertedWith('Cannot clear exit for MA manager wallet');
    });
  });

  describe('withdrawExitFromManagedAccount', function () {
    it('should revert when not called by an MA contract', async function () {
      await expect(
        exchange.withdrawExitFromManagedAccount(
          trader1Wallet.address,
          trader2Wallet.address,
          10000000,
        ),
      ).to.be.revertedWith('Invalid Managed Account Provider contract');
    });
  });
});
