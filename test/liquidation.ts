import { time } from '@nomicfoundation/hardhat-network-helpers';
import BigNumber from 'bignumber.js';
import { ethers, network } from 'hardhat';

import {
  decimalToPips,
  fieldUpgradeDelayInS,
  indexPriceToArgumentStruct,
} from '../lib';

import {
  baseAssetSymbol,
  buildIndexPrice,
  buildIndexPriceWithValue,
  deployAndAssociateContracts,
  executeTrade,
  expect,
  fundWallets,
  quoteAssetDecimals,
  quoteAssetSymbol,
  setupSingleShortPositionRequiringPositiveQuoteToClose,
} from './helpers';

import type { IndexPrice } from '../lib';
import type {
  Exchange_v1,
  Governance,
  KatanaPerpsIndexAndOraclePriceAdapter,
  LiquidationValidationsMock,
  USDC,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('Exchange', function () {
  let exchange: Exchange_v1;
  let exitFundWallet: SignerWithAddress;
  let governance: Governance;
  let indexPrice: IndexPrice;
  let indexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;
  let indexPriceServiceWallet: SignerWithAddress;
  let insuranceFundWallet: SignerWithAddress;
  let liquidationValidationsMock: LiquidationValidationsMock;
  let ownerWallet: SignerWithAddress;
  let dispatcherWallet: SignerWithAddress;
  let trader1Wallet: SignerWithAddress;
  let trader2Wallet: SignerWithAddress;
  let usdc: USDC;

  before(async () => {
    await network.provider.send('hardhat_reset');

    liquidationValidationsMock = await (
      await ethers.getContractFactory('LiquidationValidationsMock')
    ).deploy();
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
      0,
      true,
      ethers.ZeroAddress,
      ['ETH', 'BTC'],
    );
    exchange = results.exchange;
    governance = results.governance;
    indexPriceAdapter = results.indexPriceAdapter;
    usdc = results.usdc;

    await results.usdc.faucet(dispatcherWallet.address);

    await fundWallets(
      [trader1Wallet, trader2Wallet],
      dispatcherWallet,
      exchange,
      usdc,
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

  describe('calculateQuoteQuantityAtBankruptcyPrice', async function () {
    it('should return 0 for zero totalMaintenanceMarginRequirement', async function () {
      await expect(
        liquidationValidationsMock.calculateQuoteQuantityAtBankruptcyPrice(
          '200000000000',
          '3000000',
          '10000000000',
          '300000000000000',
          '0',
        ),
      ).to.eventually.equal('0');
    });

    it('should return 0 when quote quantity sign is same as position sign', async function () {
      await expect(
        liquidationValidationsMock.calculateQuoteQuantityAtBankruptcyPrice(
          '10000000000',
          '5000000',
          '-1000000000',
          '-98900000000',
          '5000000000',
        ),
      ).to.eventually.equal('0');

      await expect(
        liquidationValidationsMock.calculateQuoteQuantityAtBankruptcyPrice(
          '10000000000',
          '5000000',
          '1000000000',
          '101100000000',
          '5000000000',
        ),
      ).to.eventually.equal('0');
    });

    it('should revert if result overflows int64', async function () {
      await expect(
        liquidationValidationsMock.calculateQuoteQuantityAtBankruptcyPrice(
          new BigNumber(2).pow(63).minus(1).toString(),
          '3000000',
          new BigNumber(2).pow(63).minus(1).toString(),
          '1000000000000000',
          '30000000000000000000000',
        ),
      ).to.eventually.be.rejectedWith(/pip quantity overflows int64/i);
    });

    it('should revert if result underflows int64', async function () {
      await expect(
        liquidationValidationsMock.calculateQuoteQuantityAtBankruptcyPrice(
          new BigNumber(2).pow(63).minus(1).toString(),
          '3000000',
          new BigNumber(2).pow(63).negated().toString(),
          '1000000000000000',
          '30000000000000000000000',
        ),
      ).to.eventually.be.rejectedWith(/pip quantity underflows int64/i);
    });
  });

  describe('liquidatePositionBelowMinimum', async function () {
    beforeEach(async () => {
      const overrides = {
        initialMarginFraction: '5000000',
        maintenanceMarginFraction: '3000000',
        incrementalInitialMarginFraction: '1000000',
        baselinePositionSize: '14000000000',
        incrementalPositionSize: '2800000000',
        maximumPositionSize: '282000000000',
        minimumPositionSize: '10000000000',
      };
      await governance
        .connect(ownerWallet)
        .initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          overrides,
          trader1Wallet.address,
        );
      await time.increase(fieldUpgradeDelayInS);
      await governance
        .connect(dispatcherWallet)
        .finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          overrides,
          trader1Wallet.address,
        );
    });

    it('should work for valid wallet', async function () {
      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
      );

      await exchange.connect(dispatcherWallet).liquidatePositionBelowMinimum({
        baseAssetSymbol,
        liquidatingWallet: trader1Wallet.address,
        liquidationQuoteQuantity: decimalToPips('20000.00000000'),
      });

      const events = await exchange.queryFilter(
        exchange.filters.LiquidatedPositionBelowMinimum(),
      );
      expect(events).to.have.lengthOf(1);
      expect(events[0].args?.baseAssetSymbol).to.equal(baseAssetSymbol);
      expect(events[0].args?.liquidatingWallet).to.equal(trader1Wallet.address);
      expect(events[0].args?.liquidationBaseQuantity).to.equal(
        decimalToPips('10.00000000'),
      );
      expect(events[0].args?.liquidationQuoteQuantity).to.equal(
        decimalToPips('20000.00000000'),
      );
    });

    it('should work for valid wallet with quote below validation threshold', async function () {
      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
      );
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '0.00000100',
              baseAssetSymbol,
            ),
          ),
        ]);

      await exchange.connect(dispatcherWallet).liquidatePositionBelowMinimum({
        baseAssetSymbol,
        liquidatingWallet: trader1Wallet.address,
        liquidationQuoteQuantity: decimalToPips('0.00007213'),
      });
    });

    it('should work when wallet is in maintenance', async function () {
      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
      );

      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '2150.00000000',
              baseAssetSymbol,
            ),
          ),
        ]);

      await exchange.connect(dispatcherWallet).liquidatePositionBelowMinimum({
        baseAssetSymbol,
        liquidatingWallet: trader1Wallet.address,
        liquidationQuoteQuantity: decimalToPips('21500.00000000'),
      });
    });

    it('should revert when expected quote quantity is below validation threshold but provided quote quantity is not', async function () {
      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
      );
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '0.00000100',
              baseAssetSymbol,
            ),
          ),
        ]);

      await expect(
        exchange.connect(dispatcherWallet).liquidatePositionBelowMinimum({
          baseAssetSymbol,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantity: decimalToPips('0.10000000'),
        }),
      ).to.eventually.be.rejectedWith(/invalid quote quantity/i);
    });

    it('should revert when not sent by dispatcher', async function () {
      await expect(
        exchange.liquidatePositionBelowMinimum({
          baseAssetSymbol,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantity: decimalToPips('20000.00000000'),
        }),
      ).to.eventually.be.rejectedWith(/SenderMustBeDispatcher/i);
    });

    it('should revert when position is above minimum', async function () {
      const overrides = {
        initialMarginFraction: '5000000',
        maintenanceMarginFraction: '3000000',
        incrementalInitialMarginFraction: '1000000',
        baselinePositionSize: '14000000000',
        incrementalPositionSize: '2800000000',
        maximumPositionSize: '282000000000',
        minimumPositionSize: '100000000',
      };
      await governance
        .connect(ownerWallet)
        .initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          overrides,
          trader1Wallet.address,
        );
      await time.increase(fieldUpgradeDelayInS);
      await governance
        .connect(dispatcherWallet)
        .finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          overrides,
          trader1Wallet.address,
        );

      await expect(
        exchange.connect(dispatcherWallet).liquidatePositionBelowMinimum({
          baseAssetSymbol,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantity: decimalToPips('20000.00000000'),
        }),
      ).to.eventually.be.rejectedWith(/position size above minimum/i);
    });

    it('should revert for invalid quote value', async function () {
      await expect(
        exchange.connect(dispatcherWallet).liquidatePositionBelowMinimum({
          baseAssetSymbol,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantity: decimalToPips('2000.00000000'),
        }),
      ).to.eventually.be.rejectedWith(/invalid quote quantity/i);
    });

    it('should revert when IF cannot acquire', async function () {
      await expect(
        exchange.connect(dispatcherWallet).liquidatePositionBelowMinimum({
          baseAssetSymbol,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantity: decimalToPips('20000.00000000'),
        }),
      ).to.eventually.be.rejectedWith(/initial margin requirement not met/i);
    });

    it('should revert when liquidating EF', async function () {
      await expect(
        exchange.connect(dispatcherWallet).liquidatePositionBelowMinimum({
          baseAssetSymbol,
          liquidatingWallet: exitFundWallet.address,
          liquidationQuoteQuantity: decimalToPips('20000.00000000'),
        }),
      ).to.eventually.be.rejectedWith(/cannot liquidate EF/i);
    });

    it('should revert when liquidating IF', async function () {
      await expect(
        exchange.connect(dispatcherWallet).liquidatePositionBelowMinimum({
          baseAssetSymbol,
          liquidatingWallet: insuranceFundWallet.address,
          liquidationQuoteQuantity: decimalToPips('20000.00000000'),
        }),
      ).to.eventually.be.rejectedWith(/cannot liquidate IF/i);
    });
  });

  describe('liquidatePositionInDeactivatedMarket', async function () {
    it('should work for valid long wallet position and market', async function () {
      await exchange
        .connect(dispatcherWallet)
        .deactivateMarket(baseAssetSymbol);

      await exchange
        .connect(dispatcherWallet)
        .liquidatePositionInDeactivatedMarket({
          baseAssetSymbol,
          feeQuantity: decimalToPips('20.00000000'),
          liquidatingWallet: trader2Wallet.address,
          liquidationQuoteQuantity: decimalToPips('20000.00000000'),
        });

      const events = await exchange.queryFilter(
        exchange.filters.LiquidatedPositionInDeactivatedMarket(),
      );
      expect(events).to.have.lengthOf(1);
      expect(events[0].args?.baseAssetSymbol).to.equal(baseAssetSymbol);
      expect(events[0].args?.liquidatingWallet).to.equal(trader2Wallet.address);
      expect(events[0].args?.liquidationBaseQuantity).to.equal(
        decimalToPips('10.00000000'),
      );
      expect(events[0].args?.liquidationQuoteQuantity).to.equal(
        decimalToPips('20000.00000000'),
      );
    });

    it('should work for valid short wallet position and market', async function () {
      await exchange
        .connect(dispatcherWallet)
        .deactivateMarket(baseAssetSymbol);

      await exchange
        .connect(dispatcherWallet)
        .liquidatePositionInDeactivatedMarket({
          baseAssetSymbol,
          feeQuantity: decimalToPips('20.00000000'),
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantity: decimalToPips('20000.00000000'),
        });

      const events = await exchange.queryFilter(
        exchange.filters.LiquidatedPositionInDeactivatedMarket(),
      );
      expect(events).to.have.lengthOf(1);
      expect(events[0].args?.baseAssetSymbol).to.equal(baseAssetSymbol);
      expect(events[0].args?.liquidatingWallet).to.equal(trader1Wallet.address);
      expect(events[0].args?.liquidationBaseQuantity).to.equal(
        decimalToPips('10.00000000'),
      );
      expect(events[0].args?.liquidationQuoteQuantity).to.equal(
        decimalToPips('20000.00000000'),
      );
    });

    it('should revert for invalid market', async function () {
      await expect(
        exchange
          .connect(dispatcherWallet)
          .liquidatePositionInDeactivatedMarket({
            baseAssetSymbol: 'XYZ',
            feeQuantity: decimalToPips('20.00000000'),
            liquidatingWallet: trader1Wallet.address,
            liquidationQuoteQuantity: decimalToPips('20000.00000000'),
          }),
      ).to.eventually.be.rejectedWith(/no inactive market found/i);
    });

    it('should when wallet has no open position', async function () {
      await exchange
        .connect(dispatcherWallet)
        .deactivateMarket(baseAssetSymbol);

      await exchange
        .connect(dispatcherWallet)
        .liquidatePositionInDeactivatedMarket({
          baseAssetSymbol,
          feeQuantity: decimalToPips('20.00000000'),
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantity: decimalToPips('20000.00000000'),
        });

      await expect(
        exchange
          .connect(dispatcherWallet)
          .liquidatePositionInDeactivatedMarket({
            baseAssetSymbol,
            feeQuantity: decimalToPips('20.00000000'),
            liquidatingWallet: trader1Wallet.address,
            liquidationQuoteQuantity: decimalToPips('20000.00000000'),
          }),
      ).to.eventually.be.rejectedWith(/open position not found for market/i);
    });

    it('should revert when not sent by dispatcher', async function () {
      await expect(
        exchange.liquidatePositionInDeactivatedMarket({
          baseAssetSymbol,
          feeQuantity: decimalToPips('20.00000000'),
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantity: decimalToPips('20000.00000000'),
        }),
      ).to.eventually.be.rejectedWith(/SenderMustBeDispatcher/i);
    });

    it('should revert for invalid quote quantity', async function () {
      await (
        await exchange
          .connect(dispatcherWallet)
          .deactivateMarket(baseAssetSymbol)
      ).wait();

      await expect(
        exchange
          .connect(dispatcherWallet)
          .liquidatePositionInDeactivatedMarket({
            baseAssetSymbol,
            feeQuantity: decimalToPips('20.00000000'),
            liquidatingWallet: trader1Wallet.address,
            liquidationQuoteQuantity: decimalToPips('10000.00000000'),
          }),
      ).to.eventually.be.rejectedWith(/invalid quote quantity/i);
    });

    it('should revert for excessive fee', async function () {
      await (
        await exchange
          .connect(dispatcherWallet)
          .deactivateMarket(baseAssetSymbol)
      ).wait();

      await expect(
        exchange
          .connect(dispatcherWallet)
          .liquidatePositionInDeactivatedMarket({
            baseAssetSymbol,
            feeQuantity: decimalToPips('10000.00000000'),
            liquidatingWallet: trader1Wallet.address,
            liquidationQuoteQuantity: decimalToPips('20000.00000000'),
          }),
      ).to.eventually.be.rejectedWith(/excessive fee/i);
    });
  });

  describe('liquidateWalletInMaintenance', async function () {
    it('should work for valid wallet', async function () {
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '2150.00000000',
              baseAssetSymbol,
            ),
          ),
        ]);

      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
      );

      await exchange.connect(dispatcherWallet).liquidateWalletInMaintenance({
        counterpartyWallet: insuranceFundWallet.address,
        liquidatingWallet: trader1Wallet.address,
        liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
      });

      const events = await exchange.queryFilter(
        exchange.filters.LiquidatedWalletInMaintenance(),
      );
      expect(events).to.have.lengthOf(1);
      expect(events[0].args?.liquidatingWallet).to.equal(trader1Wallet.address);
    });

    it('should work for valid wallet with one pip quote difference', async function () {
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '2150.00000000',
              baseAssetSymbol,
            ),
          ),
        ]);

      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
      );

      await exchange.connect(dispatcherWallet).liquidateWalletInMaintenance({
        counterpartyWallet: insuranceFundWallet.address,
        liquidatingWallet: trader1Wallet.address,
        liquidationQuoteQuantities: ['21980.00000001'].map(decimalToPips),
      });
    });

    it('should work for valid wallet with a short position requiring positive quote to close', async function () {
      const wallets = await ethers.getSigners();
      const trader3Wallet = wallets[10];
      const trader4Wallet = wallets[11];

      await setupSingleShortPositionRequiringPositiveQuoteToClose(
        exchange,
        governance,
        await indexPriceAdapter.getAddress(),
        usdc,
        dispatcherWallet,
        indexPriceServiceWallet,
        ownerWallet,
        trader3Wallet,
        trader4Wallet,
      );

      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
        '10000.00000000',
      );

      await exchange.connect(dispatcherWallet).liquidateWalletInMaintenance({
        counterpartyWallet: insuranceFundWallet.address,
        liquidatingWallet: trader4Wallet.address,
        liquidationQuoteQuantities: ['0.00000000', '36.66666667'].map(
          decimalToPips,
        ),
      });

      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader4Wallet.address,
            quoteAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader4Wallet.address,
            baseAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
      expect(
        (
          await exchange.loadBalanceBySymbol(trader4Wallet.address, 'BTC')
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
    });

    it('should revert when wallet is not in maintenance', async function () {
      await expect(
        exchange.connect(dispatcherWallet).liquidateWalletInMaintenance({
          counterpartyWallet: insuranceFundWallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
        }),
      ).to.eventually.be.rejectedWith(/maintenance margin requirement met/i);
    });

    it('should work for valid wallet with multiple short positions one of which requires positive quote to close', async function () {
      const wallets = await ethers.getSigners();
      const trader3Wallet = wallets[10];
      const trader4Wallet = wallets[11];

      await setupSingleShortPositionRequiringPositiveQuoteToClose(
        exchange,
        governance,
        await indexPriceAdapter.getAddress(),
        usdc,
        dispatcherWallet,
        indexPriceServiceWallet,
        ownerWallet,
        trader3Wallet,
        trader4Wallet,
      );

      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
        '250.00000000',
      );

      await exchange.connect(dispatcherWallet).liquidateWalletInMaintenance({
        counterpartyWallet: insuranceFundWallet.address,
        liquidatingWallet: trader4Wallet.address,
        liquidationQuoteQuantities: ['0.00000000', '36.66666667'].map(
          decimalToPips,
        ),
      });

      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader4Wallet.address,
            quoteAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader4Wallet.address,
            baseAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
      expect(
        (
          await exchange.loadBalanceBySymbol(trader4Wallet.address, 'BTC')
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
    });

    it('should revert when counterparty is not IF', async function () {
      await expect(
        exchange.connect(dispatcherWallet).liquidateWalletInMaintenance({
          counterpartyWallet: trader2Wallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
        }),
      ).to.eventually.be.rejectedWith(/must liquidate to IF/i);
    });

    it('should revert for invalid quote quantity', async function () {
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '2150.00000000',
              baseAssetSymbol,
            ),
          ),
        ]);

      await expect(
        exchange.connect(dispatcherWallet).liquidateWalletInMaintenance({
          counterpartyWallet: insuranceFundWallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['20080.00000000'].map(decimalToPips),
        }),
      ).to.eventually.be.rejectedWith(/invalid quote quantity/i);
    });

    it('should revert when not sent by dispatcher', async function () {
      await expect(
        exchange.liquidateWalletInMaintenance({
          counterpartyWallet: insuranceFundWallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
        }),
      ).to.eventually.be.rejectedWith(/SenderMustBeDispatcher/i);
    });

    it('should revert for deactivated market', async function () {
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '2150.00000000',
              baseAssetSymbol,
            ),
          ),
        ]);

      await exchange
        .connect(dispatcherWallet)
        .deactivateMarket(baseAssetSymbol);

      await expect(
        exchange.connect(dispatcherWallet).liquidateWalletInMaintenance({
          counterpartyWallet: insuranceFundWallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
        }),
      ).to.eventually.be.rejectedWith(
        /cannot liquidate position in inactive market/i,
      );
    });

    it('should transfer pending deposit to MA provider on liquidation', async function () {
      const managerWallet = (await ethers.getSigners())[15];

      // 1. Deploy ManagedAccountProviderMock
      const managedAccountProvider = await (
        await ethers.getContractFactory('ManagedAccountProviderMock')
      ).deploy(await exchange.getAddress());

      // 2. Whitelist the MA provider
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

      // 4. Whitelist the bridge adapter
      await governance.initiateBridgeAdaptersUpgrade([
        await bridgeAdapterMock.getAddress(),
      ]);
      await time.increase(fieldUpgradeDelayInS);
      await governance.finalizeBridgeAdaptersUpgrade([
        await bridgeAdapterMock.getAddress(),
      ]);

      // 5. Associate manager wallet with provider
      await managedAccountProvider.addManagedAccount(
        managerWallet.address,
        '0x',
      );

      // 6. Make a deposit and apply it
      const initialDepositQuantityInDecimal = '2000.00000000';
      const initialDepositQuantityPips = decimalToPips(
        initialDepositQuantityInDecimal,
      );
      await bridgeAdapterMock
        .connect(ownerWallet)
        .depositToManagedAccount(
          ethers.parseUnits(initialDepositQuantityInDecimal, 6),
          trader1Wallet.address,
          await managedAccountProvider.getAddress(),
          '0x',
          managerWallet.address,
        );
      const depositIndex = await exchange.depositIndex();
      await exchange
        .connect(dispatcherWallet)
        .applyPendingDepositToManagedAccount(
          depositIndex,
          initialDepositQuantityPips,
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
        trader2Wallet,
        managerWallet,
        baseAssetSymbol,
      );

      // 8. Make another deposit but do NOT apply it
      const pendingDepositQuantityInDecimal = '500.00000000';
      await bridgeAdapterMock
        .connect(ownerWallet)
        .depositToManagedAccount(
          ethers.parseUnits(pendingDepositQuantityInDecimal, 6),
          trader1Wallet.address,
          await managedAccountProvider.getAddress(),
          '0x',
          managerWallet.address,
        );

      // Verify pending deposit exists
      const pendingBefore = await exchange.pendingDepositQuantityByWallet(
        managerWallet.address,
      );
      expect(pendingBefore).to.equal(
        decimalToPips(pendingDepositQuantityInDecimal),
      );

      // 9. Alter index price to push manager below maintenance
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '100.00000000',
              baseAssetSymbol,
            ),
          ),
        ]);

      // 10. Fund insurance fund to acquire the position
      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
        '100000.00000000',
      );

      // Capture MA provider balance before liquidation
      const maProviderBalanceBefore = await usdc.balanceOf(
        await managedAccountProvider.getAddress(),
      );

      // 11. Liquidate the manager wallet
      await exchange.connect(dispatcherWallet).liquidateWalletInMaintenance({
        counterpartyWallet: insuranceFundWallet.address,
        liquidatingWallet: managerWallet.address,
        liquidationQuoteQuantities: ['18040.00000000'].map(decimalToPips),
      });

      // 12. Validate pending deposit was transferred to MA provider
      const maProviderBalanceAfter = await usdc.balanceOf(
        await managedAccountProvider.getAddress(),
      );
      expect(maProviderBalanceAfter - maProviderBalanceBefore).to.equal(
        ethers.parseUnits(pendingDepositQuantityInDecimal, quoteAssetDecimals),
      );

      // 13. Validate pending deposit was cleared from Exchange
      const pendingAfter = await exchange.pendingDepositQuantityByWallet(
        managerWallet.address,
      );
      expect(pendingAfter).to.equal(0);

      // 14. Validate liquidation event was emitted
      const events = await exchange.queryFilter(
        exchange.filters.LiquidatedWalletInMaintenance(),
      );
      expect(events.length).to.be.greaterThan(0);
      const lastEvent = events[events.length - 1];
      expect(lastEvent.args?.liquidatingWallet).to.equal(managerWallet.address);
    });

    it('should successfully liquidate manager wallet without pending deposits', async function () {
      const managerWallet = (await ethers.getSigners())[16];

      // 1. Deploy ManagedAccountProviderMock
      const managedAccountProvider = await (
        await ethers.getContractFactory('ManagedAccountProviderMock')
      ).deploy(await exchange.getAddress());

      // 2. Whitelist the MA provider
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

      // 4. Whitelist the bridge adapter
      await governance.initiateBridgeAdaptersUpgrade([
        await bridgeAdapterMock.getAddress(),
      ]);
      await time.increase(fieldUpgradeDelayInS);
      await governance.finalizeBridgeAdaptersUpgrade([
        await bridgeAdapterMock.getAddress(),
      ]);

      // 5. Associate manager wallet with provider
      await managedAccountProvider.addManagedAccount(
        managerWallet.address,
        '0x',
      );

      // 6. Make a deposit and apply it
      const initialDepositQuantityInDecimal = '2000.00000000';
      const initialDepositQuantityPips = decimalToPips(
        initialDepositQuantityInDecimal,
      );
      await bridgeAdapterMock
        .connect(ownerWallet)
        .depositToManagedAccount(
          ethers.parseUnits(initialDepositQuantityInDecimal, 6),
          trader1Wallet.address,
          await managedAccountProvider.getAddress(),
          '0x',
          managerWallet.address,
        );
      const depositIndex = await exchange.depositIndex();
      await exchange
        .connect(dispatcherWallet)
        .applyPendingDepositToManagedAccount(
          depositIndex,
          initialDepositQuantityPips,
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
        trader2Wallet,
        managerWallet,
        baseAssetSymbol,
      );

      // 8. Verify NO pending deposits exist
      const pendingBefore = await exchange.pendingDepositQuantityByWallet(
        managerWallet.address,
      );
      expect(pendingBefore).to.equal(0);

      // 9. Alter index price to push manager below maintenance
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '100.00000000',
              baseAssetSymbol,
            ),
          ),
        ]);

      // 10. Fund insurance fund to acquire the position
      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
        '100000.00000000',
      );

      // Capture MA provider balance before liquidation
      const maProviderBalanceBefore = await usdc.balanceOf(
        await managedAccountProvider.getAddress(),
      );

      // 11. Liquidate the manager wallet
      await exchange.connect(dispatcherWallet).liquidateWalletInMaintenance({
        counterpartyWallet: insuranceFundWallet.address,
        liquidatingWallet: managerWallet.address,
        liquidationQuoteQuantities: ['18040.00000000'].map(decimalToPips),
      });

      // 12. Validate NO transfer to MA provider (no pending deposits)
      const maProviderBalanceAfter = await usdc.balanceOf(
        await managedAccountProvider.getAddress(),
      );
      expect(maProviderBalanceAfter).to.equal(maProviderBalanceBefore);

      // 13. Validate pending deposit remains zero
      const pendingAfter = await exchange.pendingDepositQuantityByWallet(
        managerWallet.address,
      );
      expect(pendingAfter).to.equal(0);

      // 14. Validate liquidation event was emitted
      const events = await exchange.queryFilter(
        exchange.filters.LiquidatedWalletInMaintenance(),
      );
      expect(events.length).to.be.greaterThan(0);
      const lastEvent = events[events.length - 1];
      expect(lastEvent.args?.liquidatingWallet).to.equal(managerWallet.address);
    });
  });

  describe('liquidateWalletInMaintenanceDuringSystemRecovery', async function () {
    this.beforeEach(async () => {
      const newIndexPrice = await buildIndexPriceWithValue(
        await exchange.getAddress(),
        indexPriceServiceWallet,
        '2150.00000000',
        baseAssetSymbol,
      );

      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            newIndexPrice,
          ),
        ]);

      await exchange.connect(trader2Wallet).exitWallet(trader2Wallet.address);
    });

    it('should work for valid wallet', async function () {
      await exchange.withdrawExit(trader2Wallet.address);

      await exchange
        .connect(dispatcherWallet)
        .liquidateWalletInMaintenanceDuringSystemRecovery({
          counterpartyWallet: exitFundWallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
        });

      const events = await exchange.queryFilter(
        exchange.filters.LiquidatedWalletInMaintenanceDuringSystemRecovery(),
      );
      expect(events).to.have.lengthOf(1);
      expect(events[0].args?.liquidatingWallet).to.equal(trader1Wallet.address);
    });

    it('should work for valid wallet with multiple short positions one of which requires positive quote to close', async function () {
      const wallets = await ethers.getSigners();
      const trader3Wallet = wallets[10];
      const trader4Wallet = wallets[11];

      await setupSingleShortPositionRequiringPositiveQuoteToClose(
        exchange,
        governance,
        await indexPriceAdapter.getAddress(),
        usdc,
        dispatcherWallet,
        indexPriceServiceWallet,
        ownerWallet,
        trader3Wallet,
        trader4Wallet,
      );

      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
        '250.00000000',
      );

      await exchange.withdrawExit(trader2Wallet.address);

      await exchange
        .connect(dispatcherWallet)
        .liquidateWalletInMaintenanceDuringSystemRecovery({
          counterpartyWallet: exitFundWallet.address,
          liquidatingWallet: trader4Wallet.address,
          liquidationQuoteQuantities: ['0.00000000', '36.66666667'].map(
            decimalToPips,
          ),
        });

      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader4Wallet.address,
            quoteAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader4Wallet.address,
            baseAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
      expect(
        (
          await exchange.loadBalanceBySymbol(trader4Wallet.address, 'BTC')
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
    });

    it('should revert when EF has no open balances', async function () {
      await expect(
        exchange
          .connect(dispatcherWallet)
          .liquidateWalletInMaintenanceDuringSystemRecovery({
            counterpartyWallet: exitFundWallet.address,
            liquidatingWallet: trader1Wallet.address,
            liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
          }),
      ).to.be.revertedWithCustomError(exchange, 'ExitFundHasNoPositions');
    });

    it('should revert when liquidating EF', async function () {
      await exchange.withdrawExit(trader2Wallet.address);

      await expect(
        exchange
          .connect(dispatcherWallet)
          .liquidateWalletInMaintenanceDuringSystemRecovery({
            counterpartyWallet: exitFundWallet.address,
            liquidatingWallet: exitFundWallet.address,
            liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
          }),
      ).to.eventually.be.rejectedWith(/cannot liquidate EF/i);
    });

    it('should revert when liquidating IF', async function () {
      await exchange.withdrawExit(trader2Wallet.address);

      await expect(
        exchange
          .connect(dispatcherWallet)
          .liquidateWalletInMaintenanceDuringSystemRecovery({
            counterpartyWallet: exitFundWallet.address,
            liquidatingWallet: insuranceFundWallet.address,
            liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
          }),
      ).to.eventually.be.rejectedWith(/cannot liquidate IF/i);
    });

    it('should revert when counterparty is not EF', async function () {
      await exchange.withdrawExit(trader2Wallet.address);

      await expect(
        exchange
          .connect(dispatcherWallet)
          .liquidateWalletInMaintenanceDuringSystemRecovery({
            counterpartyWallet: trader2Wallet.address,
            liquidatingWallet: trader1Wallet.address,
            liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
          }),
      ).to.eventually.be.rejectedWith(/must liquidate to EF/i);
    });
  });

  describe('liquidateWalletExit', async function () {
    it('should work for valid wallet', async function () {
      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
      );

      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      await exchange.connect(dispatcherWallet).liquidateWalletExit({
        counterpartyWallet: insuranceFundWallet.address,
        liquidatingWallet: trader1Wallet.address,
        liquidationQuoteQuantities: ['20000.00000000'].map(decimalToPips),
      });

      const events = await exchange.queryFilter(
        exchange.filters.LiquidatedWalletExit(),
      );
      expect(events).to.have.lengthOf(1);
      expect(events[0].args?.liquidatingWallet).to.equal(trader1Wallet.address);
    });

    it('should work for valid wallet with negative EAV', async function () {
      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
        '10000.00000000',
      );

      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithValue(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              '3000.00000000',
              baseAssetSymbol,
            ),
          ),
        ]);

      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      await exchange.connect(dispatcherWallet).liquidateWalletExit({
        counterpartyWallet: insuranceFundWallet.address,
        liquidatingWallet: trader1Wallet.address,
        liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
      });
    });

    it('should work for valid wallet with multiple short positions one of which requires positive quote to close', async function () {
      const wallets = await ethers.getSigners();
      const trader3Wallet = wallets[10];
      const trader4Wallet = wallets[11];

      await setupSingleShortPositionRequiringPositiveQuoteToClose(
        exchange,
        governance,
        await indexPriceAdapter.getAddress(),
        usdc,
        dispatcherWallet,
        indexPriceServiceWallet,
        ownerWallet,
        trader3Wallet,
        trader4Wallet,
      );

      await fundWallets(
        [insuranceFundWallet],
        dispatcherWallet,
        exchange,
        usdc,
        '250.00000000',
      );

      await exchange.connect(trader4Wallet).exitWallet(trader4Wallet.address);

      await exchange.connect(dispatcherWallet).liquidateWalletExit({
        counterpartyWallet: insuranceFundWallet.address,
        liquidatingWallet: trader4Wallet.address,
        liquidationQuoteQuantities: ['0.00000000', '36.66666667'].map(
          decimalToPips,
        ),
      });

      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader4Wallet.address,
            quoteAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader4Wallet.address,
            baseAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
      expect(
        (
          await exchange.loadBalanceBySymbol(trader4Wallet.address, 'BTC')
        ).toString(),
      ).to.equal(decimalToPips('0.00000000'));
    });

    it('should revert when not sent by dispatcher', async function () {
      await expect(
        exchange.liquidateWalletExit({
          counterpartyWallet: insuranceFundWallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['20000.00000000'].map(decimalToPips),
        }),
      ).to.eventually.be.rejectedWith(/SenderMustBeDispatcher/i);
    });

    it('should revert when counterparty is not IF', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      await expect(
        exchange.connect(dispatcherWallet).liquidateWalletExit({
          counterpartyWallet: exitFundWallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['21980.00000000'].map(decimalToPips),
        }),
      ).to.eventually.be.rejectedWith(/must liquidate to IF/i);
    });

    it('should revert when wallet not exited', async function () {
      await expect(
        exchange.connect(dispatcherWallet).liquidateWalletExit({
          counterpartyWallet: insuranceFundWallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['20000.00000000'].map(decimalToPips),
        }),
      ).to.be.revertedWithCustomError(exchange, 'WalletMustBeExited');
    });

    it('should revert for inactive market', async function () {
      await exchange
        .connect(dispatcherWallet)
        .deactivateMarket(baseAssetSymbol);

      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      await expect(
        exchange.connect(dispatcherWallet).liquidateWalletExit({
          counterpartyWallet: insuranceFundWallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['20000.00000000'].map(decimalToPips),
        }),
      ).to.eventually.be.rejectedWith(
        /cannot liquidate position in inactive market/i,
      );
    });

    it('should revert on invalid quote quantity', async function () {
      await exchange.connect(trader1Wallet).exitWallet(trader1Wallet.address);

      await expect(
        exchange.connect(dispatcherWallet).liquidateWalletExit({
          counterpartyWallet: insuranceFundWallet.address,
          liquidatingWallet: trader1Wallet.address,
          liquidationQuoteQuantities: ['21500.00000000'].map(decimalToPips),
        }),
      ).to.eventually.be.rejectedWith(/invalid quote quantity/i);
    });
  });

  describe('validateDeactivatedMarketLiquidationQuoteQuantity', async function () {
    it('should work for zero expected quote quantity', async function () {
      await expect(
        liquidationValidationsMock.validateDeactivatedMarketLiquidationQuoteQuantity(
          decimalToPips('20000.00000000'),
          0,
          0,
        ),
      ).to.eventually.be.fulfilled;

      await expect(
        liquidationValidationsMock.validateDeactivatedMarketLiquidationQuoteQuantity(
          decimalToPips('20000.00000000'),
          0,
          1,
        ),
      ).to.eventually.be.fulfilled;

      await expect(
        liquidationValidationsMock.validateDeactivatedMarketLiquidationQuoteQuantity(
          decimalToPips('20000.00000000'),
          0,
          2,
        ),
      ).to.eventually.be.rejected;
    });
  });

  describe('validateQuoteQuantityAtExitPrice', async function () {
    it('should work for zero expected quote quantity', async function () {
      await expect(
        liquidationValidationsMock.validateQuoteQuantityAtExitPrice(
          0,
          decimalToPips('20000.00000000'),
          0,
          0,
        ),
      ).to.eventually.be.fulfilled;

      await expect(
        liquidationValidationsMock.validateQuoteQuantityAtExitPrice(
          0,
          decimalToPips('20000.00000000'),
          0,
          1,
        ),
      ).to.eventually.be.fulfilled;

      await expect(
        liquidationValidationsMock.validateQuoteQuantityAtExitPrice(
          0,
          decimalToPips('20000.00000000'),
          0,
          2,
        ),
      ).to.eventually.be.rejected;
    });
  });

  describe('validateInsuranceFundClosureQuoteQuantity', async function () {
    it('should work for zero expected quote quantity', async function () {
      await expect(
        liquidationValidationsMock.validateInsuranceFundClosureQuoteQuantity(
          0,
          0,
          decimalToPips('10.00000000'),
          0,
        ),
      ).to.eventually.be.fulfilled;

      await expect(
        liquidationValidationsMock.validateInsuranceFundClosureQuoteQuantity(
          0,
          0,
          decimalToPips('10.00000000'),
          1,
        ),
      ).to.eventually.be.fulfilled;

      await expect(
        liquidationValidationsMock.validateInsuranceFundClosureQuoteQuantity(
          0,
          0,
          decimalToPips('10.00000000'),
          2,
        ),
      ).to.eventually.be.rejected;
    });
  });

  describe('validateQuoteQuantityAtBankruptcyPrice', async function () {
    it('should work for zero expected quote quantity', async function () {
      await expect(
        liquidationValidationsMock.validateQuoteQuantityAtBankruptcyPrice(
          decimalToPips('2000.00000000'),
          0,
          0,
          0,
          0,
          0,
        ),
      ).to.eventually.be.fulfilled;

      await expect(
        liquidationValidationsMock.validateQuoteQuantityAtBankruptcyPrice(
          decimalToPips('2000.00000000'),
          0,
          1,
          0,
          0,
          0,
        ),
      ).to.eventually.be.fulfilled;

      await expect(
        liquidationValidationsMock.validateQuoteQuantityAtBankruptcyPrice(
          decimalToPips('2000.00000000'),
          0,
          2,
          0,
          0,
          0,
        ),
      ).to.eventually.be.rejected;
    });
  });
});
