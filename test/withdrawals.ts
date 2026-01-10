import { time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, network } from 'hardhat';
import { v1 as uuidv1 } from 'uuid';

import {
  decimalToPips,
  exitFundWithdrawDelayInS,
  fieldUpgradeDelayInS,
  getWithdrawArguments,
  getWithdrawalSignatureTypedData,
  indexPriceToArgumentStruct,
} from '../lib';

import {
  baseAssetSymbol,
  buildIndexPrice,
  buildIndexPriceWithValue,
  deployAndAssociateContracts,
  expect,
  executeTrade,
  fundWallets,
  quoteAssetDecimals,
  quoteAssetSymbol,
} from './helpers';

import type { Withdrawal } from '../lib';
import type {
  Exchange_v1,
  Governance,
  KatanaPerpsIndexAndOraclePriceAdapter,
  ManagedAccountProviderMock,
  USDC,
  BridgeAdapterMock,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('Exchange', function () {
  let dispatcherWallet: SignerWithAddress;
  let exchange: Exchange_v1;
  let exitFundWallet: SignerWithAddress;
  let feeWallet: SignerWithAddress;
  let governance: Governance;
  let indexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;
  let indexPriceServiceWallet: SignerWithAddress;
  let signature: string;
  let traderWallet: SignerWithAddress;
  let usdc: USDC;
  let withdrawal: Withdrawal;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    const wallets = await ethers.getSigners();
    dispatcherWallet = wallets[0];
    exitFundWallet = wallets[3];
    feeWallet = wallets[4];
    indexPriceServiceWallet = wallets[5];
    traderWallet = wallets[7];
    const results = await deployAndAssociateContracts(
      wallets[1],
      dispatcherWallet,
      exitFundWallet,
      feeWallet,
      indexPriceServiceWallet,
      wallets[6],
    );
    exchange = results.exchange;
    governance = results.governance;
    indexPriceAdapter = results.indexPriceAdapter;
    usdc = results.usdc;

    const depositQuantity = ethers.parseUnits('5.0', quoteAssetDecimals);
    await results.usdc.transfer(traderWallet.address, depositQuantity);
    await results.usdc
      .connect(traderWallet)
      .approve(await exchange.getAddress(), depositQuantity);
    await (
      await exchange
        .connect(traderWallet)
        .deposit(depositQuantity, ethers.ZeroAddress)
    ).wait();
    await exchange
      .connect(dispatcherWallet)
      .applyPendingDepositsForWallet(
        decimalToPips('5.00000000'),
        traderWallet.address,
      );

    withdrawal = {
      nonce: uuidv1(),
      wallet: traderWallet.address,
      quantity: '1.00000000',
      maximumGasFee: '0.10000000',
      bridgeAdapter: ethers.ZeroAddress,
      bridgeAdapterPayload: '0x',
    };
    signature = await traderWallet.signTypedData(
      ...getWithdrawalSignatureTypedData(
        withdrawal,
        await exchange.getAddress(),
      ),
    );
  });

  describe('skim', function () {
    it('should work when Exchange is holding token', async function () {
      const tokenQuantity = 100000;
      await usdc.transfer(await exchange.getAddress(), tokenQuantity);
      await exchange.skim(await usdc.getAddress());

      const transferEvents = await usdc.queryFilter(usdc.filters.Transfer());
      const transferToFeeWalletEvent =
        transferEvents[transferEvents.length - 1];
      expect(transferToFeeWalletEvent.args?.from).to.equal(
        await exchange.getAddress(),
      );
      expect(transferToFeeWalletEvent.args?.to).to.equal(feeWallet.address);
      expect(transferToFeeWalletEvent.args?.value).to.equal(tokenQuantity);
    });

    it('should revert when not called by admin wallet', async function () {
      await expect(
        exchange.connect(dispatcherWallet).skim(await usdc.getAddress()),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
    });

    it('should revert for invalid token address', async function () {
      await expect(
        exchange.skim(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid token address/i);
    });
  });

  describe('withdraw', function () {
    it('should work with no gas fee', async function () {
      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00000000', signature));

      const withdrawnEvents = await exchange.queryFilter(
        exchange.filters.Withdrawn(),
      );
      expect(withdrawnEvents).to.have.lengthOf(1);
      expect(withdrawnEvents[0].args?.quantity).to.equal(
        decimalToPips('1.00000000'),
      );
    });

    it('should work with zero gross quantity', async function () {
      withdrawal.quantity = '0.00000000';
      withdrawal.maximumGasFee = '0.00000000';
      signature = await traderWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00000000', signature));

      const withdrawnEvents = await exchange.queryFilter(
        exchange.filters.Withdrawn(),
      );
      expect(withdrawnEvents).to.have.lengthOf(1);
      expect(withdrawnEvents[0].args?.quantity).to.equal(
        decimalToPips('0.00000000'),
      );
    });

    it('should work with zero net quantity', async function () {
      withdrawal.quantity = '1.00000000';
      withdrawal.maximumGasFee = '1.00000000';
      signature = await traderWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '1.00000000', signature));

      const withdrawnEvents = await exchange.queryFilter(
        exchange.filters.Withdrawn(),
      );
      expect(withdrawnEvents).to.have.lengthOf(1);
      expect(withdrawnEvents[0].args?.quantity).to.equal(
        decimalToPips('1.00000000'),
      );
    });

    it('should work with gas fee', async function () {
      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00100000', signature));

      const withdrawnEvents = await exchange.queryFilter(
        exchange.filters.Withdrawn(),
      );
      expect(withdrawnEvents).to.have.lengthOf(1);
      expect(withdrawnEvents[0].args?.quantity).to.equal(
        decimalToPips('1.00000000'),
      );
    });

    it('should work with gas fee for fee wallet', async function () {
      const gasFeeCharged = '0.00100000';

      await fundWallets(
        [feeWallet],
        dispatcherWallet,
        exchange,
        usdc,
        '1.00000000',
      );

      withdrawal.wallet = feeWallet.address;
      signature = await feeWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      await exchange
        .connect(dispatcherWallet)
        .withdraw(
          ...getWithdrawArguments(withdrawal, gasFeeCharged, signature),
        );

      const withdrawnEvents = await exchange.queryFilter(
        exchange.filters.Withdrawn(),
      );
      expect(withdrawnEvents).to.have.lengthOf(1);
      expect(withdrawnEvents[0].args?.quantity).to.equal(
        decimalToPips('1.00000000'),
      );

      // Gas fee sent back to wallet
      expect(
        (
          await exchange.loadBalanceBySymbol(
            feeWallet.address,
            quoteAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips(gasFeeCharged));
    });

    it('should work for EF after block delay', async function () {
      const trader2Wallet = (await ethers.getSigners())[10];
      await fundWallets(
        [traderWallet, trader2Wallet],
        dispatcherWallet,
        exchange,
        usdc,
      );

      await executeTrade(
        exchange,
        dispatcherWallet,
        await buildIndexPrice(
          await exchange.getAddress(),
          indexPriceServiceWallet,
        ),
        await indexPriceAdapter.getAddress(),
        traderWallet,
        trader2Wallet,
      );

      await exchange.connect(traderWallet).exitWallet(traderWallet.address);
      await exchange.withdrawExit(traderWallet.address);

      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '1900.00000000',
              baseAssetSymbol,
            ),
          ),
        ]);

      await exchange.connect(dispatcherWallet).deleverageExitFundClosure({
        baseAssetSymbol,
        counterpartyWallet: trader2Wallet.address,
        liquidatingWallet: exitFundWallet.address,
        liquidationBaseQuantity: decimalToPips('10.00000000'),
        liquidationQuoteQuantity: decimalToPips('19000.00000000'),
      });

      // Expire EF withdraw delay
      await time.increase(exitFundWithdrawDelayInS);

      withdrawal.wallet = exitFundWallet.address;
      withdrawal.quantity = '1.00000000';
      signature = await exitFundWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00100000', signature));

      const withdrawnEvents = await exchange.queryFilter(
        exchange.filters.Withdrawn(),
      );
      expect(withdrawnEvents).to.have.lengthOf(1);
      expect(withdrawnEvents[0].args?.quantity).to.equal(
        decimalToPips('1.00000000'),
      );
    });

    it('should revert when quote asset transfer fails', async function () {
      await usdc.setIsTransferDisabled(true);

      await expect(
        exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.00100000', signature),
          ),
      ).to.eventually.be.rejectedWith(/quote asset transfer failed/i);
    });

    it('should revert if EF balance would be negative', async function () {
      const trader2Wallet = (await ethers.getSigners())[10];
      await fundWallets(
        [traderWallet, trader2Wallet],
        dispatcherWallet,
        exchange,
        usdc,
      );

      await executeTrade(
        exchange,
        dispatcherWallet,
        await buildIndexPrice(
          await exchange.getAddress(),
          indexPriceServiceWallet,
        ),
        await indexPriceAdapter.getAddress(),
        traderWallet,
        trader2Wallet,
      );

      await exchange.connect(traderWallet).exitWallet(traderWallet.address);
      await exchange.withdrawExit(traderWallet.address);

      await exchange.connect(dispatcherWallet).deleverageExitFundClosure({
        baseAssetSymbol,
        counterpartyWallet: trader2Wallet.address,
        liquidatingWallet: exitFundWallet.address,
        liquidationBaseQuantity: decimalToPips('10.00000000'),
        liquidationQuoteQuantity: decimalToPips('20000.00000000'),
      });

      // Expire EF withdraw delay
      await time.increase(exitFundWithdrawDelayInS);

      withdrawal.wallet = exitFundWallet.address;
      withdrawal.quantity = '1000.00000000';
      signature = await exitFundWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      await expect(
        exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.00100000', signature),
          ),
      ).to.eventually.be.rejectedWith(
        /EF may not withdraw to a negative balance/i,
      );
    });

    it('should revert for EF before block delay', async function () {
      const trader2Wallet = (await ethers.getSigners())[10];
      await fundWallets(
        [traderWallet, trader2Wallet],
        dispatcherWallet,
        exchange,
        usdc,
      );

      await executeTrade(
        exchange,
        dispatcherWallet,
        await buildIndexPrice(
          await exchange.getAddress(),
          indexPriceServiceWallet,
        ),
        await indexPriceAdapter.getAddress(),
        traderWallet,
        trader2Wallet,
      );

      await exchange.connect(traderWallet).exitWallet(traderWallet.address);
      await exchange.withdrawExit(traderWallet.address);

      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '1900.00000000',
              baseAssetSymbol,
            ),
          ),
        ]);

      await exchange.connect(dispatcherWallet).deleverageExitFundClosure({
        baseAssetSymbol,
        counterpartyWallet: trader2Wallet.address,
        liquidatingWallet: exitFundWallet.address,
        liquidationBaseQuantity: decimalToPips('10.00000000'),
        liquidationQuoteQuantity: decimalToPips('19000.00000000'),
      });

      withdrawal.wallet = exitFundWallet.address;
      withdrawal.quantity = '1.00000000';
      signature = await exitFundWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      await expect(
        exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.00100000', signature),
          ),
      ).to.eventually.be.rejectedWith(/EF position opened too recently/i);
    });

    it('should revert when replayed', async function () {
      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00000000', signature));

      await expect(
        exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.00000000', signature),
          ),
      ).to.eventually.be.rejectedWith(/duplicate withdrawal/i);
    });

    it('should revert on excessive withdrawal fee', async function () {
      await expect(
        exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.70000000', signature),
          ),
      ).to.eventually.be.rejectedWith(/excessive withdrawal fee/i);

      withdrawal.maximumGasFee = '1.10000000';
      signature = await traderWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );
      await expect(
        exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.10000000', signature),
          ),
      ).to.eventually.be.rejectedWith(/excessive withdrawal fee/i);
    });

    it('should revert for exited wallet', async function () {
      await exchange.connect(traderWallet).exitWallet(traderWallet.address);
      await exchange.withdrawExit(traderWallet.address);

      await expect(
        exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '1.00000000', signature),
          ),
      ).to.eventually.be.rejectedWith(/wallet is exited/i);
    });

    it('should revert when not sent by dispatcher', async function () {
      await expect(
        exchange.withdraw(
          ...getWithdrawArguments(withdrawal, '1.00000000', signature),
        ),
      ).to.eventually.be.rejectedWith(/SenderMustBeDispatcher/i);
    });

    it('should revert for invalid signature', async function () {
      signature = await dispatcherWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      await expect(
        exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.00000000', signature),
          ),
      ).to.eventually.be.rejectedWith(/invalid wallet signature/i);
    });

    it('should revert for invalid bridge adapter', async function () {
      withdrawal.bridgeAdapter = dispatcherWallet.address;
      signature = await traderWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      await expect(
        exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.00000000', signature),
          ),
      ).to.eventually.be.rejectedWith(/invalid bridge adapter/i);
    });

    it('should revert for wallet associated with MA', async function () {
      // Get a wallet to be used as manager wallet
      const managerWallet = (await ethers.getSigners())[10];

      // Deploy ManagedAccountProviderMock
      const managedAccountProvider: ManagedAccountProviderMock = await (
        await ethers.getContractFactory('ManagedAccountProviderMock')
      ).deploy(await exchange.getAddress());
      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

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

      // Associate the wallet with a managed account
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Make a deposit to the managed account
      const depositQuantity = ethers.parseUnits('5.0', quoteAssetDecimals);
      await usdc.transfer(traderWallet.address, depositQuantity);
      await usdc
        .connect(traderWallet)
        .approve(await bridgeAdapterMock.getAddress(), depositQuantity);
      await bridgeAdapterMock
        .connect(traderWallet)
        .depositToManagedAccount(
          depositQuantity,
          traderWallet.address,
          await managedAccountProvider.getAddress(),
          '0x',
          managerWallet.address,
        );

      // Apply the deposit
      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1,
        decimalToPips('5.00000000'),
        managerWallet.address,
      );
      await exchange.setDispatcher(dispatcherWallet);

      // Create a withdrawal for the manager wallet
      const maWithdrawal: Withdrawal = {
        nonce: uuidv1(),
        wallet: managerWallet.address,
        quantity: '1.00000000',
        maximumGasFee: '0.10000000',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };
      const maSignature = await managerWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          maWithdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw from the MA-associated wallet using regular withdraw
      await expect(
        exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(maWithdrawal, '0.00000000', maSignature),
          ),
      ).to.eventually.be.rejectedWith(/wallet is associated with ma/i);
    });

    it('should successfully withdraw through whitelisted BridgeAdapterMock', async function () {
      // 1. Deploy BridgeAdapterMock
      const bridgeAdapterMock: BridgeAdapterMock = await (
        await ethers.getContractFactory('BridgeAdapterMock')
      ).deploy();
      await bridgeAdapterMock.setExchange(await exchange.getAddress());

      // 2. Whitelist the bridge adapter
      await governance.initiateBridgeAdaptersUpgrade([
        await bridgeAdapterMock.getAddress(),
      ]);
      await time.increase(fieldUpgradeDelayInS);
      await governance.finalizeBridgeAdaptersUpgrade([
        await bridgeAdapterMock.getAddress(),
      ]);

      // 3. Setup withdrawal targeting the bridge adapter
      const withdrawalQuantity = '2.00000000';
      const bridgeWithdrawal: Withdrawal = {
        nonce: uuidv1(),
        wallet: traderWallet.address,
        quantity: withdrawalQuantity,
        maximumGasFee: '0.10000000',
        bridgeAdapter: await bridgeAdapterMock.getAddress(),
        bridgeAdapterPayload: ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint32'],
          [1], // Some payload
        ),
      };
      const bridgeSignature = await traderWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          bridgeWithdrawal,
          await exchange.getAddress(),
        ),
      );

      // 4. Capture balances before withdrawal
      const traderBalanceBefore = await exchange.loadBalanceBySymbol(
        traderWallet.address,
        quoteAssetSymbol,
      );
      const bridgeAdapterBalanceBefore = await usdc.balanceOf(
        await bridgeAdapterMock.getAddress(),
      );

      // 5. Execute withdrawal
      await exchange
        .connect(dispatcherWallet)
        .withdraw(
          ...getWithdrawArguments(
            bridgeWithdrawal,
            '0.01000000',
            bridgeSignature,
          ),
        );

      // 6. Validate withdrawal occurred
      const withdrawnEvents = await exchange.queryFilter(
        exchange.filters.Withdrawn(),
      );
      expect(withdrawnEvents).to.have.lengthOf(1);
      expect(withdrawnEvents[0].args?.wallet).to.equal(traderWallet.address);
      expect(withdrawnEvents[0].args?.quantity).to.equal(
        decimalToPips(withdrawalQuantity),
      );

      // 7. Validate trader balance decreased
      const traderBalanceAfter = await exchange.loadBalanceBySymbol(
        traderWallet.address,
        quoteAssetSymbol,
      );
      expect(traderBalanceBefore - traderBalanceAfter).to.equal(
        decimalToPips(withdrawalQuantity),
      );

      // 8. Validate tokens ended up in bridge adapter
      const bridgeAdapterBalanceAfter = await usdc.balanceOf(
        await bridgeAdapterMock.getAddress(),
      );
      expect(bridgeAdapterBalanceAfter - bridgeAdapterBalanceBefore).to.equal(
        ethers.parseUnits(withdrawalQuantity, quoteAssetDecimals) -
          ethers.parseUnits('0.01000000', quoteAssetDecimals), // minus gas fee
      );
    });

    it('should successfully withdraw through second whitelisted BridgeAdapterMock', async function () {
      // 1. Deploy first BridgeAdapterMock
      const bridgeAdapterMock1: BridgeAdapterMock = await (
        await ethers.getContractFactory('BridgeAdapterMock')
      ).deploy();
      await bridgeAdapterMock1.setExchange(await exchange.getAddress());

      // 2. Deploy second BridgeAdapterMock
      const bridgeAdapterMock2: BridgeAdapterMock = await (
        await ethers.getContractFactory('BridgeAdapterMock')
      ).deploy();
      await bridgeAdapterMock2.setExchange(await exchange.getAddress());

      // 3. Whitelist both bridge adapters
      await governance.initiateBridgeAdaptersUpgrade([
        await bridgeAdapterMock1.getAddress(),
        await bridgeAdapterMock2.getAddress(),
      ]);
      await time.increase(fieldUpgradeDelayInS);
      await governance.finalizeBridgeAdaptersUpgrade([
        await bridgeAdapterMock1.getAddress(),
        await bridgeAdapterMock2.getAddress(),
      ]);

      // 4. Setup withdrawal targeting the second bridge adapter
      const withdrawalQuantity = '1.50000000';
      const bridgeWithdrawal: Withdrawal = {
        nonce: uuidv1(),
        wallet: traderWallet.address,
        quantity: withdrawalQuantity,
        maximumGasFee: '0.10000000',
        bridgeAdapter: await bridgeAdapterMock2.getAddress(), // Target second adapter
        bridgeAdapterPayload: ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint32'],
          [2], // Some payload
        ),
      };
      const bridgeSignature = await traderWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          bridgeWithdrawal,
          await exchange.getAddress(),
        ),
      );

      // 5. Capture balances before withdrawal
      const traderBalanceBefore = await exchange.loadBalanceBySymbol(
        traderWallet.address,
        quoteAssetSymbol,
      );
      const bridgeAdapter1BalanceBefore = await usdc.balanceOf(
        await bridgeAdapterMock1.getAddress(),
      );
      const bridgeAdapter2BalanceBefore = await usdc.balanceOf(
        await bridgeAdapterMock2.getAddress(),
      );

      // 6. Execute withdrawal
      await exchange
        .connect(dispatcherWallet)
        .withdraw(
          ...getWithdrawArguments(
            bridgeWithdrawal,
            '0.02000000',
            bridgeSignature,
          ),
        );

      // 7. Validate withdrawal occurred
      const withdrawnEvents = await exchange.queryFilter(
        exchange.filters.Withdrawn(),
      );
      expect(withdrawnEvents).to.have.lengthOf(1);
      expect(withdrawnEvents[0].args?.wallet).to.equal(traderWallet.address);
      expect(withdrawnEvents[0].args?.quantity).to.equal(
        decimalToPips(withdrawalQuantity),
      );

      // 8. Validate trader balance decreased
      const traderBalanceAfter = await exchange.loadBalanceBySymbol(
        traderWallet.address,
        quoteAssetSymbol,
      );
      expect(traderBalanceBefore - traderBalanceAfter).to.equal(
        decimalToPips(withdrawalQuantity),
      );

      // 9. Validate tokens ended up in second bridge adapter (not the first)
      const bridgeAdapter1BalanceAfter = await usdc.balanceOf(
        await bridgeAdapterMock1.getAddress(),
      );
      const bridgeAdapter2BalanceAfter = await usdc.balanceOf(
        await bridgeAdapterMock2.getAddress(),
      );

      // First adapter should have no change
      expect(bridgeAdapter1BalanceAfter).to.equal(bridgeAdapter1BalanceBefore);

      // Second adapter should receive the withdrawal amount minus gas fee
      expect(bridgeAdapter2BalanceAfter - bridgeAdapter2BalanceBefore).to.equal(
        ethers.parseUnits(withdrawalQuantity, quoteAssetDecimals) -
          ethers.parseUnits('0.02000000', quoteAssetDecimals), // minus gas fee
      );
    });
  });
});
