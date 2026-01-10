import { time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, network } from 'hardhat';
import { v1 as uuidv1 } from 'uuid';

import {
  fieldUpgradeDelayInS,
  getWithdrawalFromManagedAccountByQuantitySignatureTypedData,
  getWithdrawFromManagedAccountByQuantityArguments,
  getWithdrawalFromManagedAccountBySharesSignatureTypedData,
  getWithdrawFromManagedAccountByShareArguments,
  decimalToPips,
  decimalToAssetUnits,
} from '../lib';

import {
  baseAssetSymbol,
  buildIndexPrice,
  deployAndAssociateContracts,
  executeTrade,
  expect,
  fundWallets,
  getLatestBlockTimestampInSeconds,
  quoteAssetDecimals,
} from './helpers';

import type {
  WithdrawalFromManagedAccountByQuantity,
  WithdrawalFromManagedAccountByShares,
} from '../lib';
import type {
  Exchange_v1,
  Governance,
  KatanaPerpsIndexAndOraclePriceAdapter,
  ManagedAccountProviderMock,
  USDC,
  BridgeAdapterMock,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('ManagedAccounts', function () {
  let bridgeAdapterMock: BridgeAdapterMock;
  let dispatcherWallet: SignerWithAddress;
  let exchange: Exchange_v1;
  let exitFundWallet: SignerWithAddress;
  let feeWallet: SignerWithAddress;
  let governance: Governance;
  let indexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;
  let indexPriceServiceWallet: SignerWithAddress;
  let insuranceFundWallet: SignerWithAddress;
  let managedAccountProvider: ManagedAccountProviderMock;
  let managerWallet: SignerWithAddress;
  let managerWallet2: SignerWithAddress;
  let ownerWallet: SignerWithAddress;
  let trader1Wallet: SignerWithAddress;
  let trader2Wallet: SignerWithAddress;
  let usdc: USDC;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    const wallets = await ethers.getSigners();

    [
      ownerWallet,
      dispatcherWallet,
      exitFundWallet,
      feeWallet,
      indexPriceServiceWallet,
      insuranceFundWallet,
      managerWallet,
      managerWallet2,
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
    exchange = results.exchange;
    governance = results.governance;
    indexPriceAdapter = results.indexPriceAdapter;
    usdc = results.usdc;

    await fundWallets(
      [trader1Wallet, trader2Wallet],
      dispatcherWallet,
      exchange,
      results.usdc,
    );

    managedAccountProvider = await (
      await ethers.getContractFactory('ManagedAccountProviderMock')
    ).deploy(await results.exchange.getAddress());

    await results.governance.initiateManagedAccountProvidersUpgrade([
      await managedAccountProvider.getAddress(),
    ]);
    await time.increase(fieldUpgradeDelayInS);
    await results.governance.finalizeManagedAccountProvidersUpgrade([
      await managedAccountProvider.getAddress(),
    ]);

    await expect(
      exchange.loadManagedAccountProvidersLength(),
    ).to.eventually.equal(1);

    bridgeAdapterMock = await (
      await ethers.getContractFactory('BridgeAdapterMock')
    ).deploy();
    await bridgeAdapterMock.setManagedAccountProvider(
      await managedAccountProvider.getAddress(),
    );
    await bridgeAdapterMock.setExchange(await results.exchange.getAddress());
    await usdc.approve(bridgeAdapterMock, BigInt(2) ** BigInt(64));

    await governance.initiateBridgeAdaptersUpgrade([
      await bridgeAdapterMock.getAddress(),
    ]);
    await time.increase(fieldUpgradeDelayInS);
    await governance.finalizeBridgeAdaptersUpgrade([
      await bridgeAdapterMock.getAddress(),
    ]);
  });

  describe('addManagedAccount', () => {
    it('should revert with "Wallet exited" when wallet is exited', async () => {
      // Exit the manager wallet
      await exchange.connect(managerWallet).exitWallet(managerWallet.address);

      // Attempt to add managed account for exited wallet
      await expect(
        bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x'),
      ).to.eventually.be.rejectedWith('Wallet exited');
    });

    it('should revert with "Wallet cannot have open positions" when wallet has open position', async () => {
      // Execute a trade to give manager wallet an open position
      await fundWallets(
        [managerWallet, trader1Wallet],
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
        managerWallet,
        trader1Wallet,
        baseAssetSymbol,
      );

      // Attempt to add managed account for wallet with open position
      await expect(
        bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x'),
      ).to.eventually.be.rejectedWith('Wallet cannot have open positions');
    });

    it('should revert with "Wallet has pending deposits" when wallet has pending deposits', async () => {
      // Make a deposit for manager wallet but don't apply it
      const depositQuantity = ethers.parseUnits('100.0', quoteAssetDecimals);
      await usdc.transfer(managerWallet.address, depositQuantity);
      await usdc
        .connect(managerWallet)
        .approve(await exchange.getAddress(), depositQuantity);
      await exchange
        .connect(managerWallet)
        .deposit(depositQuantity, ethers.ZeroAddress);

      // Verify pending deposit exists
      const pendingDeposit = await exchange.pendingDepositQuantityByWallet(
        managerWallet.address,
      );
      expect(pendingDeposit).to.be.greaterThan(0);

      // Attempt to add managed account for wallet with pending deposits
      await expect(
        bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x'),
      ).to.eventually.be.rejectedWith('Wallet has pending deposits');
    });

    it('should revert with "Wallet cannot have open balance" when wallet has open balance', async () => {
      // Make a deposit and apply it
      const depositQuantity = ethers.parseUnits('100.0', quoteAssetDecimals);
      await usdc.transfer(managerWallet.address, depositQuantity);
      await usdc
        .connect(managerWallet)
        .approve(await exchange.getAddress(), depositQuantity);
      await exchange
        .connect(managerWallet)
        .deposit(depositQuantity, ethers.ZeroAddress);

      // Apply the deposit
      await exchange
        .connect(dispatcherWallet)
        .applyPendingDepositsForWallet(
          decimalToPips('100.00000000'),
          managerWallet.address,
        );

      // Verify wallet has open balance
      const balance = await exchange.loadBalanceBySymbol(
        managerWallet.address,
        'USD',
      );
      expect(balance).to.be.greaterThan(0);

      // Attempt to add managed account for wallet with open balance
      await expect(
        bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x'),
      ).to.eventually.be.rejectedWith('Wallet cannot have open balance');
    });

    it('should revert with "Wallet already associated with MA" when wallet is already associated', async () => {
      // Add managed account for manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Attempt to add managed account again for the same wallet
      await expect(
        bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x'),
      ).to.eventually.be.rejectedWith('Wallet already associated with MA');
    });
  });

  describe('depositToManagedAccount', () => {
    it('should successfully deposit to managed account', async () => {
      // Add managed account for manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );

      const depositQuantityInDecimal = '500.00000000';
      const depositQuantityInAssetUnits = decimalToAssetUnits(
        depositQuantityInDecimal,
        quoteAssetDecimals,
      );
      const depositQuantityPips = decimalToPips(depositQuantityInDecimal);

      // Make deposit to managed account via the provider
      await usdc.transfer(managedAccountProvider, depositQuantityInAssetUnits);
      await managedAccountProvider.depositToManagedAccount(
        depositQuantityInAssetUnits,
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // payload
        managerWallet.address, // managerWallet
      );

      // Verify deposit was queued
      const depositIndex = await exchange.depositIndex();
      expect(depositIndex).to.equal(3);

      // Verify pending deposit quantity
      const pendingDeposit = await exchange.pendingDepositQuantityByWallet(
        managerWallet.address,
      );
      expect(pendingDeposit).to.equal(depositQuantityPips);

      // Verify deposit event was emitted
      const depositedEvents = await exchange.queryFilter(
        exchange.filters.Deposited(),
      );
      expect(depositedEvents).to.have.lengthOf(3);
      expect(depositedEvents[2].args?.index).to.equal(depositIndex);
      expect(depositedEvents[2].args?.quantity).to.equal(depositQuantityPips);
      expect(depositedEvents[2].args?.sourceWallet).to.equal(
        await managedAccountProvider.getAddress(),
      );
      expect(depositedEvents[2].args?.depositorWallet).to.equal(
        managerWallet.address,
      );
      expect(depositedEvents[2].args?.isAssociatedWithManagedAccount).to.be
        .true;
    });

    it('should revert with invalid manager wallet', async () => {
      await expect(
        bridgeAdapterMock.depositToManagedAccount(
          ethers.parseUnits('1000', 6), // quantityInAssetUnits
          trader1Wallet.address, // depositorWallet
          await managedAccountProvider.getAddress(), // managedAccountProvider
          '0x', // managedAccountProviderPayload
          ethers.ZeroAddress, // managerWallet set to zero
        ),
      ).to.eventually.be.rejectedWith('Invalid manager wallet');
    });

    it('should revert with invalid depositor wallet', async () => {
      await expect(
        bridgeAdapterMock.depositToManagedAccount(
          ethers.parseUnits('1000', 6), // quantityInAssetUnits
          ethers.ZeroAddress, // depositorWallet set to zero
          await managedAccountProvider.getAddress(), // managedAccountProvider
          '0x', // managedAccountProviderPayload
          managerWallet.address, // managerWallet
        ),
      ).to.eventually.be.rejectedWith('Invalid depositor wallet');
    });

    it('should revert when called from non-whitelisted caller', async () => {
      await expect(
        exchange.connect(trader1Wallet).depositToManagedAccount(
          ethers.parseUnits('1000', 6), // quantityInAssetUnits
          trader2Wallet.address, // depositorWallet
          await managedAccountProvider.getAddress(), // managedAccountProvider
          '0x', // managedAccountProviderPayload
          managerWallet.address, // managerWallet
        ),
      ).to.eventually.be.rejectedWith(
        'Caller must be MA provider or bridge adapter',
      );
    });

    it('should revert when manager wallet is not associated with the specified MA provider', async () => {
      // Add a managed account for the manager wallet with the correct provider
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Create a second managed account provider
      const managedAccountProvider2 = await (
        await ethers.getContractFactory('ManagedAccountProviderMock')
      ).deploy(await exchange.getAddress());

      // Enable deposits on the bogus provider
      await managedAccountProvider2.setDepositEnabled(
        managerWallet.address,
        true,
      );

      // Whitelist the second managed account provider
      await governance.initiateManagedAccountProvidersUpgrade([
        await managedAccountProvider.getAddress(),
        await managedAccountProvider2.getAddress(),
      ]);
      await time.increase(fieldUpgradeDelayInS);
      await governance.finalizeManagedAccountProvidersUpgrade([
        await managedAccountProvider.getAddress(),
        await managedAccountProvider2.getAddress(),
      ]);

      // Attempt to deposit using the bogus provider instead of the correct one
      await expect(
        bridgeAdapterMock.depositToManagedAccount(
          ethers.parseUnits('1000', 6), // quantityInAssetUnits
          trader1Wallet.address, // depositorWallet
          await managedAccountProvider2.getAddress(), // second MA provider
          '0x', // managedAccountProviderPayload
          managerWallet.address, // managerWallet
        ),
      ).to.eventually.be.rejectedWith('Manager wallet not associated with MA');
    });

    it('should revert when a manager wallet tries to deposit to another manager wallet MA', async () => {
      // Add managed accounts for both manager wallets
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');
      await bridgeAdapterMock.addManagedAccount(managerWallet2.address, '0x');

      // Enable deposits for both manager wallets
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setDepositEnabled(
        managerWallet2.address,
        true,
      );

      // Attempt to deposit where managerWallet is the depositor but tries to deposit to managerWallet2's MA
      await expect(
        bridgeAdapterMock.depositToManagedAccount(
          ethers.parseUnits('1000', 6), // quantityInAssetUnits
          managerWallet.address, // depositorWallet (a manager wallet)
          await managedAccountProvider.getAddress(), // managedAccountProvider
          '0x', // managedAccountProviderPayload
          managerWallet2.address, // managerWallet (different manager wallet)
        ),
      ).to.eventually.be.rejectedWith(
        'Manager wallet can only deposit to its own MA',
      );
    });
  });

  describe('applyPendingDepositToManagedAccount', () => {
    beforeEach(async () => {
      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
    });

    it('should revert when manager wallet is exited', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make a deposit to create a pending deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        managerWallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      // Exit the manager wallet
      await managedAccountProvider.exitWallet(managerWallet.address);

      // Attempt to apply pending deposit and expect reversion
      await expect(
        bridgeAdapterMock.applyPendingDepositToManagedAccount(
          1, // depositIndex
          ethers.parseUnits('1000', 8), // quantity in pips
          managerWallet.address, // managerWallet
        ),
      ).to.eventually.be.rejectedWith('Manager wallet is exited');
    });

    it('should revert when quantity exceeds pending deposit', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make a deposit to create a pending deposit of 1000 USDC
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits (1000 USDC)
        managerWallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      // Attempt to apply more than the pending deposit (2000 > 1000)
      await expect(
        bridgeAdapterMock.applyPendingDepositToManagedAccount(
          1, // depositIndex
          ethers.parseUnits('2000', 8), // quantity in pips (2000 USDC worth)
          managerWallet.address, // managerWallet
        ),
      ).to.eventually.be.rejectedWith('Quantity to apply exceeds pending');
    });

    it('should revert when wallet is not associated with any MA', async () => {
      // Make a regular deposit (not to a managed account) for trader1Wallet
      const depositQuantity = ethers.parseUnits('1000', 6);
      await usdc.transfer(trader1Wallet.address, depositQuantity);
      await usdc
        .connect(trader1Wallet)
        .approve(await exchange.getAddress(), depositQuantity);
      await exchange
        .connect(trader1Wallet)
        .deposit(depositQuantity, ethers.ZeroAddress);

      // trader1Wallet now has a pending deposit but is not associated with any MA
      // Attempt to apply the pending deposit as if it were for a managed account
      await expect(
        bridgeAdapterMock.applyPendingDepositToManagedAccount(
          1, // depositIndex
          ethers.parseUnits('1000', 8), // quantity in pips
          trader1Wallet.address, // trader1Wallet (not associated with MA)
        ),
      ).to.eventually.be.rejectedWith('Manager wallet not associated with MA');
    });
  });

  describe('applyPendingWithdrawalFromManagedAccountByQuantity', () => {
    it('should successfully execute withdrawal with non-zero bridge adapter', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      const depositQuantityInDecimal = '1000.00000000';
      const depositQuantityInAssetUnits = decimalToAssetUnits(
        depositQuantityInDecimal,
        quoteAssetDecimals,
      );
      await usdc.transfer(
        await managedAccountProvider.getAddress(),
        depositQuantityInAssetUnits,
      );
      await managedAccountProvider.depositToManagedAccount(
        depositQuantityInAssetUnits,
        trader1Wallet.address,
        await managedAccountProvider.getAddress(),
        '0x',
        managerWallet.address,
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        3, // depositIndex (2 from beforeEach + 1 from previous test)
        decimalToPips(depositQuantityInDecimal),
        managerWallet.address,
      );

      // Create a withdrawal request with bridge adapter set
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: await bridgeAdapterMock.getAddress(), // Non-zero bridge adapter
        bridgeAdapterPayload: ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint32'],
          [1],
        ),
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Execute the withdrawal
      await bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
        ...getWithdrawFromManagedAccountByQuantityArguments(
          withdrawal,
          '0.01000000',
          signature,
        ),
      );

      // Verify withdrawal was successful
      const withdrawnEvents = await exchange.queryFilter(
        exchange.filters.Withdrawn(),
      );
      expect(withdrawnEvents).to.have.lengthOf(1);
      expect(withdrawnEvents[0].args?.wallet).to.equal(managerWallet.address);
      expect(withdrawnEvents[0].args?.quantity).to.equal(
        decimalToPips('100.00000000'),
      );
    });

    it('should successfully execute withdrawal with gas fee equal to gross quantity', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      const depositQuantityInDecimal = '1000.00000000';
      const depositQuantityInAssetUnits = decimalToAssetUnits(
        depositQuantityInDecimal,
        quoteAssetDecimals,
      );
      await usdc.transfer(
        await managedAccountProvider.getAddress(),
        depositQuantityInAssetUnits,
      );
      await managedAccountProvider.depositToManagedAccount(
        depositQuantityInAssetUnits,
        trader1Wallet.address,
        await managedAccountProvider.getAddress(),
        '0x',
        managerWallet.address,
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        3, // depositIndex
        decimalToPips(depositQuantityInDecimal),
        managerWallet.address,
      );

      // Get custodian address
      const custodianAddress = await exchange.custodian();

      // Create a withdrawal request
      const withdrawalQuantity = '50.00000000';
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: withdrawalQuantity,
        maxShares: '0.00000000',
        maximumGasFee: withdrawalQuantity, // Set max gas fee equal to quantity
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Capture custodian balance before
      const custodianBalanceBefore = await usdc.balanceOf(custodianAddress);

      // Execute the withdrawal with gas fee equal to gross quantity
      await bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
        ...getWithdrawFromManagedAccountByQuantityArguments(
          withdrawal,
          withdrawalQuantity, // gasFee equals gross quantity
          signature,
        ),
      );

      // Verify withdrawal was successful
      const withdrawnEvents = await exchange.queryFilter(
        exchange.filters.Withdrawn(),
      );
      expect(withdrawnEvents).to.have.lengthOf(1);
      expect(withdrawnEvents[0].args?.wallet).to.equal(managerWallet.address);
      expect(withdrawnEvents[0].args?.quantity).to.equal(
        decimalToPips(withdrawalQuantity),
      );

      // Verify custodian balance unchanged (net quantity is zero, no transfer)
      const custodianBalanceAfter = await usdc.balanceOf(custodianAddress);
      expect(custodianBalanceAfter).to.equal(custodianBalanceBefore);
    });

    it('should revert when manager wallet is not associated with MA', async () => {
      // Do NOT add a managed account for the manager wallet
      // This wallet is not associated with any MA

      // Create a withdrawal request for a wallet not associated with MA
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address, // Not associated with MA
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw and expect reversion
      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.00000000',
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Manager wallet not associated with MA');
    });

    it('should revert when depositor wallet is exited', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Exit the depositor wallet (trader1Wallet)
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      // Create a withdrawal request
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw and expect reversion
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.00000000',
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Depositor wallet is exited');
    });

    it('should revert when manager wallet is exited', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Exit the manager wallet using the managed account provider
      await managedAccountProvider.exitWallet(managerWallet.address);

      // Create a withdrawal request
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw and expect reversion
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.00000000',
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Manager wallet is exited');
    });

    it('should revert when exit fund wallet attempts to withdraw', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit from EF wallet
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        exitFundWallet.address, // depositorWallet - EF wallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request from EF wallet
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: exitFundWallet.address, // EF wallet as depositor
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal with EF wallet
      const signature = await exitFundWallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw and expect reversion
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.00000000',
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('EF cannot withdraw from MA');
    });

    it('should revert on duplicate withdrawal', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Execute the withdrawal successfully the first time
      await bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
        ...getWithdrawFromManagedAccountByQuantityArguments(
          withdrawal,
          '0.00000000',
          signature,
        ),
      );

      // Attempt to execute the same withdrawal again and expect reversion
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.00000000',
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Duplicate withdrawal');
    });

    it('should revert when gas fee exceeds maximum gas fee', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request with maximumGasFee = 0.10
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000', // maximum gas fee
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw with gasFee (0.20) > maximumGasFee (0.10)
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.20000000', // gasFee exceeds maximumGasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Excessive withdrawal fee');
    });

    it('should revert when maximum gas fee exceeds withdrawal quantity', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request where maximumGasFee (150) > quantity (100)
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000', // withdrawal quantity
        maxShares: '0.00000000',
        maximumGasFee: '150.00000000', // maximumGasFee exceeds quantity
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw with maximumGasFee > quantity
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.00000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Excessive withdrawal fee');
    });

    it('should revert with invalid wallet signature', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal with the WRONG wallet (trader2 instead of trader1)
      const invalidSignature = await trader2Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw with invalid signature
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.00000000', // gasFee
            invalidSignature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Invalid wallet signature');
    });

    it('should revert with invalid bridge adapter', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request with a non-whitelisted bridge adapter
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: trader2Wallet.address, // Non-whitelisted bridge adapter
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw with non-whitelisted bridge adapter
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.00000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Invalid bridge adapter');
    });

    it('should revert with invalid managed account provider contract', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a non-whitelisted managed account provider
      const nonWhitelistedProvider = await (
        await ethers.getContractFactory('ManagedAccountProviderMock')
      ).deploy(await exchange.getAddress());

      // Create a withdrawal request with the non-whitelisted MA provider
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await nonWhitelistedProvider.getAddress(), // Non-whitelisted provider
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw with non-whitelisted MA provider
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.00000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith(
        'Invalid Managed Account Provider contract',
      );
    });
  });

  describe('applyPendingWithdrawalFromManagedAccountByShares', () => {
    it('should revert when depositor wallet is exited', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Exit the depositor wallet (trader1Wallet)
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      // Create a withdrawal request by shares
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw and expect reversion
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '100.00000000', // grossQuantity
            '0.00000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Depositor wallet is exited');
    });

    it('should revert when manager wallet is exited', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Exit the manager wallet using the managed account provider
      await managedAccountProvider.exitWallet(managerWallet.address);

      // Create a withdrawal request by shares
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw and expect reversion
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '100.00000000', // grossQuantity
            '0.00000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Manager wallet is exited');
    });

    it('should revert when exit fund wallet attempts to withdraw', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit from EF wallet
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        exitFundWallet.address, // depositorWallet - EF wallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request by shares from EF wallet
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: exitFundWallet.address, // EF wallet as depositor
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal with EF wallet
      const signature = await exitFundWallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw and expect reversion
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '100.00000000', // grossQuantity
            '0.00000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('EF cannot withdraw from MA');
    });

    it('should revert on duplicate withdrawal', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request by shares
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Execute the withdrawal successfully the first time
      await bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
        ...getWithdrawFromManagedAccountByShareArguments(
          withdrawal,
          '100.00000000', // grossQuantity
          '0.00000000', // gasFee
          signature,
        ),
      );

      // Attempt to execute the same withdrawal again and expect reversion
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '100.00000000', // grossQuantity
            '0.00000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Duplicate withdrawal');
    });

    it('should revert when gas fee exceeds maximum gas fee', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request with maximumGasFee = 0.10
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000', // maximum gas fee
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw with gasFee (0.20) > maximumGasFee (0.10)
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '100.00000000', // grossQuantity
            '0.20000000', // gasFee exceeds maximumGasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Excessive withdrawal fee');
    });

    it('should revert when maximum gas fee exceeds withdrawal quantity', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request where maximumGasFee (150) will exceed grossQuantity (100)
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '150.00000000', // maximumGasFee will exceed grossQuantity
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw with maximumGasFee > grossQuantity
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '100.00000000', // grossQuantity
            '0.00000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Excessive withdrawal fee');
    });

    it('should revert when gross quantity is below minimum quantity', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request with minimumQuantity = 200
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '200.00000000', // minimum quantity
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw with grossQuantity (100) < minimumQuantity (200)
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '100.00000000', // grossQuantity below minimumQuantity
            '0.00000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Minimum quantity not met');
    });

    it('should revert with invalid wallet signature', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request by shares
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal with the WRONG wallet (trader2 instead of trader1)
      const invalidSignature = await trader2Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw with invalid signature
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '100.00000000', // grossQuantity
            '0.00000000', // gasFee
            invalidSignature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Invalid wallet signature');
    });

    it('should revert with invalid bridge adapter', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal request by shares with a non-whitelisted bridge adapter
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: trader2Wallet.address, // Non-whitelisted bridge adapter
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to withdraw with non-whitelisted bridge adapter
      await expect(
        bridgeAdapterMock.applyPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '100.00000000', // grossQuantity
            '0.00000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Invalid bridge adapter');
    });
  });

  describe('cancelPendingWithdrawalFromManagedAccountByQuantity', () => {
    it('should revert when depositor wallet is exited', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Exit the depositor wallet (trader1Wallet)
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      // Create a withdrawal cancellation request
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to cancel withdrawal and expect reversion
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.01000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Depositor wallet is exited');
    });

    it('should revert when manager wallet is exited', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Exit the manager wallet using the managed account provider
      await managedAccountProvider.exitWallet(managerWallet.address);

      // Create a withdrawal cancellation request
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to cancel withdrawal and expect reversion
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.01000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Manager wallet is exited');
    });

    it('should revert when exit fund wallet attempts to cancel', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit from EF wallet
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        exitFundWallet.address, // depositorWallet - EF wallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal cancellation request from EF wallet
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: exitFundWallet.address, // EF wallet as depositor
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal with EF wallet
      const signature = await exitFundWallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to cancel withdrawal and expect reversion
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.01000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('EF cannot withdraw from MA');
    });

    it('should revert when gas fee exceeds maximum gas fee', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal cancellation request with maximumGasFee = 0.10
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000', // maximum gas fee
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to cancel with gasFee (0.20) > maximumGasFee (0.10)
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.20000000', // gasFee exceeds maximumGasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Excessive withdrawal fee');
    });

    it('should revert on duplicate cancellation', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal cancellation request
      const withdrawal: WithdrawalFromManagedAccountByQuantity = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        quantity: '100.00000000',
        maxShares: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountByQuantitySignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Cancel the withdrawal successfully the first time
      await bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
        ...getWithdrawFromManagedAccountByQuantityArguments(
          withdrawal,
          '0.01000000', // gasFee
          signature,
        ),
      );

      // Attempt to cancel the same withdrawal again and expect reversion
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByQuantityArguments(
            withdrawal,
            '0.01000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Duplicate withdrawal');
    });
  });

  describe('cancelPendingWithdrawalFromManagedAccountByShares', () => {
    it('should revert when depositor wallet is exited', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Exit the depositor wallet (trader1Wallet)
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      // Create a withdrawal cancellation request by shares
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to cancel withdrawal and expect reversion
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '0.01000000', // grossQuantity
            '0.01000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Depositor wallet is exited');
    });

    it('should revert when manager wallet is exited', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Exit the manager wallet using the managed account provider
      await managedAccountProvider.exitWallet(managerWallet.address);

      // Create a withdrawal cancellation request by shares
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to cancel withdrawal and expect reversion
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '0.01000000', // grossQuantity
            '0.01000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Manager wallet is exited');
    });

    it('should revert when exit fund wallet attempts to cancel', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit from EF wallet
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        exitFundWallet.address, // depositorWallet - EF wallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal cancellation request by shares from EF wallet
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: exitFundWallet.address, // EF wallet as depositor
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal with EF wallet
      const signature = await exitFundWallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to cancel withdrawal and expect reversion
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '0.01000000', // grossQuantity
            '0.01000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('EF cannot withdraw from MA');
    });

    it('should revert when gas fee exceeds maximum gas fee', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal cancellation request with maximumGasFee = 0.10
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000', // maximum gas fee
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to cancel with gasFee (0.20) > maximumGasFee (0.10)
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '0.20000000', // grossQuantity
            '0.20000000', // gasFee exceeds maximumGasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Excessive withdrawal fee');
    });

    it('should revert when gross quantity does not equal gas fee', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal cancellation request
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Attempt to cancel with grossQuantity (0.05) != gasFee (0.01)
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '0.05000000', // grossQuantity
            '0.01000000', // gasFee (not equal to grossQuantity)
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Quantity must equal fee');
    });

    it('should revert on duplicate cancellation', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Create a withdrawal cancellation request by shares
      const withdrawal: WithdrawalFromManagedAccountByShares = {
        nonce: uuidv1({
          msecs: (await getLatestBlockTimestampInSeconds()) * 1000,
        }),
        managerWallet: managerWallet.address,
        depositorWallet: trader1Wallet.address,
        shares: '50.00000000',
        minimumQuantity: '0.00000000',
        maximumGasFee: '0.10000000',
        managedAccountProvider: await managedAccountProvider.getAddress(),
        managedAccountProviderPayload: '0x',
        bridgeAdapter: ethers.ZeroAddress,
        bridgeAdapterPayload: '0x',
      };

      // Sign the withdrawal
      const signature = await trader1Wallet.signTypedData(
        ...getWithdrawalFromManagedAccountBySharesSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      // Cancel the withdrawal successfully the first time
      await bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
        ...getWithdrawFromManagedAccountByShareArguments(
          withdrawal,
          '0.01000000', // grossQuantity
          '0.01000000', // gasFee
          signature,
        ),
      );

      // Attempt to cancel the same withdrawal again and expect reversion
      await expect(
        bridgeAdapterMock.cancelPendingWithdrawalFromManagedAccount(
          ...getWithdrawFromManagedAccountByShareArguments(
            withdrawal,
            '0.01000000', // grossQuantity
            '0.01000000', // gasFee
            signature,
          ),
        ),
      ).to.eventually.be.rejectedWith('Duplicate withdrawal');
    });
  });

  describe('withdrawExitFromManagedAccount', () => {
    it('should revert when manager wallet is not associated with MA', async () => {
      // Try to withdraw exit for a wallet that is not associated with any MA
      await expect(
        managedAccountProvider.withdrawExit(
          trader1Wallet.address, // managerWallet not associated with MA
          trader1Wallet.address, // depositorWallet
          ethers.parseUnits('1', 8), // exitWithdrawalQuantity in pips
        ),
      ).to.eventually.be.rejectedWith('Manager wallet not associated with MA');
    });

    it('should revert when wallet exit is not finalized', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('1000', 6), // quantityInAssetUnits
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('1000', 8), // quantity in pips
        managerWallet.address, // managerWallet
      );

      // Try to withdraw exit without finalizing the wallet exit first
      await expect(
        managedAccountProvider.withdrawExit(
          managerWallet.address, // managerWallet
          trader1Wallet.address, // depositorWallet
          ethers.parseUnits('1', 8), // exitWithdrawalQuantity in pips
        ),
      ).to.eventually.be.rejectedWith('Wallet exit not finalized');
    });

    it('should revert when quantity exceeds available quote balance', async () => {
      // Add a managed account for the manager wallet
      await bridgeAdapterMock.addManagedAccount(managerWallet.address, '0x');

      // Enable deposits for the manager wallet
      await managedAccountProvider.setDepositEnabled(
        managerWallet.address,
        true,
      );
      await managedAccountProvider.setApplyDepositEnabled(
        managerWallet.address,
        true,
      );

      // Make and apply a deposit of 100 USDC
      await bridgeAdapterMock.depositToManagedAccount(
        ethers.parseUnits('100', 6), // quantityInAssetUnits (100 USDC)
        trader1Wallet.address, // depositorWallet
        await managedAccountProvider.getAddress(), // managedAccountProvider
        '0x', // managedAccountProviderPayload
        managerWallet.address, // managerWallet
      );

      await exchange.setDispatcher(await bridgeAdapterMock.getAddress());
      await bridgeAdapterMock.applyPendingDepositToManagedAccount(
        1, // depositIndex
        ethers.parseUnits('100', 8), // quantity in pips (100 USDC)
        managerWallet.address, // managerWallet
      );

      // Exit the manager wallet
      await managedAccountProvider.exitWallet(managerWallet.address);

      // Try to withdraw more than the available balance (1000 > 100)
      await expect(
        managedAccountProvider.withdrawExit(
          managerWallet.address, // managerWallet
          trader1Wallet.address, // depositorWallet
          ethers.parseUnits('1000', 8), // exitWithdrawalQuantity in pips (exceeds balance)
        ),
      ).to.eventually.be.rejectedWith(
        'Quantity exceeds available quote balance',
      );
    });
  });
});
