import { time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers } from 'hardhat';

import {
  fieldUpgradeDelayInS,
  getDomainSeparator,
  hardhatChainId,
  uuidToUint128,
} from '../lib';

import {
  baseAssetSymbol,
  deployAndAssociateContracts,
  deployLibraryContracts,
  expect,
} from './helpers';

import type {
  BalanceMigrationSourceMock__factory,
  BridgeAdapterMock,
  Exchange_v1,
  Exchange_v1__factory,
  Governance,
  USDC,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('Exchange', function () {
  describe('deploy', async function () {
    let BalanceMigrationSourceMockFactory: BalanceMigrationSourceMock__factory;
    let ExchangeFactory: Exchange_v1__factory;
    let usdc: USDC;

    beforeEach(async () => {
      BalanceMigrationSourceMockFactory = await ethers.getContractFactory(
        'BalanceMigrationSourceMock',
      );
      ExchangeFactory = await deployLibraryContracts();
      usdc = await (await ethers.getContractFactory('USDC')).deploy();
    });

    it('should work for zero address migration source', async () => {
      const [ownerWallet] = await ethers.getSigners();

      await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );
    });

    it('should work for contract migration source', async () => {
      const [ownerWallet] = await ethers.getSigners();

      const balanceMigrationSourceMock =
        await BalanceMigrationSourceMockFactory.deploy(0);

      await ExchangeFactory.deploy(
        await balanceMigrationSourceMock.getAddress(),
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );
    });

    it('should revert for non-contract migration source', async () => {
      const [ownerWallet] = await ethers.getSigners();

      await expect(
        ExchangeFactory.deploy(
          ownerWallet.address,
          ownerWallet.address,
          ownerWallet.address,
          [await usdc.getAddress()],
          ownerWallet.address,
          await usdc.getAddress(),
          await usdc.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid migration source/i);
    });

    it('should revert for non-contract quote asset address', async () => {
      const [ownerWallet] = await ethers.getSigners();

      const balanceMigrationSourceMock =
        await BalanceMigrationSourceMockFactory.deploy(0);

      await expect(
        ExchangeFactory.deploy(
          await balanceMigrationSourceMock.getAddress(),
          ownerWallet.address,
          ownerWallet.address,
          [await usdc.getAddress()],
          ownerWallet.address,
          await usdc.getAddress(),
          ownerWallet.address,
        ),
      ).to.eventually.be.rejectedWith(/invalid quote asset address/i);
    });

    it('should revert for zero index price adapter address', async () => {
      const [ownerWallet] = await ethers.getSigners();

      const balanceMigrationSourceMock =
        await BalanceMigrationSourceMockFactory.deploy(0);

      await expect(
        ExchangeFactory.deploy(
          await balanceMigrationSourceMock.getAddress(),
          ownerWallet.address,
          ownerWallet.address,
          [ethers.ZeroAddress],
          ownerWallet.address,
          await usdc.getAddress(),
          await usdc.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid index price adapter address/i);
    });

    it('should revert for zero IF wallet', async () => {
      const [ownerWallet] = await ethers.getSigners();

      await expect(
        ExchangeFactory.deploy(
          ethers.ZeroAddress,
          ownerWallet.address,
          ownerWallet.address,
          [await usdc.getAddress()],
          ethers.ZeroAddress,
          await usdc.getAddress(),
          await usdc.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid IF wallet/i);
    });

    it('should revert for zero oracle price adapter address', async () => {
      const [ownerWallet] = await ethers.getSigners();

      const balanceMigrationSourceMock =
        await BalanceMigrationSourceMockFactory.deploy(0);

      await expect(
        ExchangeFactory.deploy(
          await balanceMigrationSourceMock.getAddress(),
          ownerWallet.address,
          ownerWallet.address,
          [await usdc.getAddress()],
          ownerWallet.address,
          ethers.ZeroAddress,
          await usdc.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid oracle price adapter address/i);
    });
  });

  describe('field upgrade governance setters', () => {
    let exchange: Exchange_v1;

    beforeEach(async () => {
      const [owner] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(owner);
      exchange = results.exchange;
    });

    describe('setBridgeAdapters', async function () {
      it('should revert when not called by Governance', async () => {
        await expect(
          exchange.setBridgeAdapters([]),
        ).to.be.revertedWithCustomError(exchange, 'SenderMustBeGovernance');
      });
    });

    describe('setIndexPriceServiceWallets', async function () {
      it('should revert when not called by Governance', async () => {
        await expect(
          exchange.setIndexPriceAdapters([]),
        ).to.be.revertedWithCustomError(exchange, 'SenderMustBeGovernance');
      });
    });

    describe('setInsuranceFundWallet', async function () {
      it('should revert when not called by Governance', async () => {
        await expect(
          exchange.setInsuranceFundWallet(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(exchange, 'SenderMustBeGovernance');
      });
    });

    describe('setManagedAccountProviders', async function () {
      it('should revert when not called by Governance', async () => {
        await expect(
          exchange.setManagedAccountProviders([]),
        ).to.be.revertedWithCustomError(exchange, 'SenderMustBeGovernance');
      });
    });

    describe('setOraclePriceAdapter', async function () {
      it('should revert when not called by Governance', async () => {
        await expect(
          exchange.setOraclePriceAdapter(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(exchange, 'SenderMustBeGovernance');
      });
    });

    describe('setMarketOverrides', async function () {
      it('should revert when not called by Governance', async () => {
        await expect(
          exchange.setMarketOverrides(
            baseAssetSymbol,
            {
              initialMarginFraction: '3000000',
              maintenanceMarginFraction: '1000000',
              incrementalInitialMarginFraction: '1000000',
              baselinePositionSize: '14000000000',
              incrementalPositionSize: '2800000000',
              maximumPositionSize: '1000000000000',
              minimumPositionSize: '10000000',
            },
            ethers.ZeroAddress,
          ),
        ).to.be.revertedWithCustomError(exchange, 'SenderMustBeGovernance');
      });
    });
  });

  describe('setCustodian', async function () {
    let exchange: Exchange_v1;
    let ExchangeFactory: Exchange_v1__factory;
    let governance: Governance;
    let usdc: USDC;

    beforeEach(async () => {
      const [owner] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(owner);
      exchange = results.exchange;
      ExchangeFactory = results.ExchangeFactory;
      governance = results.governance;
      usdc = results.usdc;
    });

    it('should work for valid Custodian', async () => {
      const [ownerWallet] = await ethers.getSigners();
      const newExchange = await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );

      const CustodianFactory = await ethers.getContractFactory('Custodian');
      const custodian = await CustodianFactory.deploy(
        await newExchange.getAddress(),
        await newExchange.getAddress(),
      );

      await newExchange.setCustodian(await custodian.getAddress());
    });

    it('should revert for zero address', async () => {
      const [ownerWallet] = await ethers.getSigners();
      const newExchange = await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );

      await expect(
        newExchange.setCustodian(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/InvalidContractAddress/i);
    });

    it('should revert for non-contract address', async () => {
      const [ownerWallet] = await ethers.getSigners();
      const newExchange = await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );

      await expect(
        newExchange.setCustodian((await ethers.getSigners())[1].address),
      ).to.eventually.be.rejectedWith(/InvalidContractAddress/i);
    });

    it('should revert when already set', async () => {
      await expect(
        exchange.setCustodian(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/ValueCanOnlyBetSetOnce/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setCustodian(await governance.getAddress()),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
    });
  });

  describe('removeDispatcher', async function () {
    let exchange: Exchange_v1;
    let ownerWallet: SignerWithAddress;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      exchange = results.exchange;
    });

    it('should work', async () => {
      await exchange.removeDispatcher();
      await expect(exchange.dispatcherWallet()).to.eventually.equal(
        ethers.ZeroAddress,
      );

      const events = await exchange.queryFilter(
        exchange.filters.DispatcherChanged(),
      );
      expect(events).to.have.lengthOf(2);
      expect(events[1].args?.previousValue).to.equal(ownerWallet.address);
      expect(events[1].args?.newValue).to.equal(ethers.ZeroAddress);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange.connect((await ethers.getSigners())[1]).removeDispatcher(),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
    });
  });

  describe('setDepositIndex', () => {
    let exchange: Exchange_v1;

    beforeEach(async () => {
      const [owner] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(owner);
      exchange = results.exchange;
    });

    it('should revert when called more than once', async () => {
      await expect(exchange.setDepositIndex()).to.eventually.be.rejectedWith(
        /ValueCanOnlyBetSetOnce/i,
      );
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange.connect((await ethers.getSigners())[10]).setDepositIndex(),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
    });
  });

  describe('applyPendingDepositToManagedAccount', () => {
    let exchange: Exchange_v1;

    beforeEach(async () => {
      const [owner] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(owner);
      exchange = results.exchange;
    });

    it('should revert when not called by dispatcher wallet', async () => {
      const nonDispatcherWallet = (await ethers.getSigners())[5];

      await expect(
        exchange
          .connect(nonDispatcherWallet)
          .applyPendingDepositToManagedAccount(
            1, // depositIndex
            100000000, // quantity in pips
            (
              await ethers.getSigners()
            )[10].address, // managerWallet
          ),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeDispatcher');
    });
  });

  describe('applyPendingWithdrawalFromManagedAccount', () => {
    let exchange: Exchange_v1;

    beforeEach(async () => {
      const [owner] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(owner);
      exchange = results.exchange;
    });

    it('should revert when not called by dispatcher wallet', async () => {
      const nonDispatcherWallet = (await ethers.getSigners())[5];

      await expect(
        exchange
          .connect(nonDispatcherWallet)
          .applyPendingWithdrawalFromManagedAccount({
            withdrawalType: 0,
            withdrawalByQuantity: {
              nonce: uuidToUint128('00000000-0000-0000-0000-000000000000'),
              managerWallet: (await ethers.getSigners())[10].address,
              depositorWallet: (await ethers.getSigners())[11].address,
              grossQuantity: 100000000,
              maxShares: 10000000,
              maximumGasFee: 1000000,
              managedAccountProvider: ethers.ZeroAddress,
              managedAccountProviderPayload: '0x',
              bridgeAdapter: ethers.ZeroAddress,
              bridgeAdapterPayload: '0x',
              gasFee: 1000000,
              walletSignature: '0x',
            },
            withdrawalByShares: {
              nonce: uuidToUint128('00000000-0000-0000-0000-000000000000'),
              managerWallet: (await ethers.getSigners())[10].address,
              depositorWallet: (await ethers.getSigners())[11].address,
              shares: 1000000,
              minimumQuantity: 100000000,
              maximumGasFee: 1000000,
              managedAccountProvider: ethers.ZeroAddress,
              managedAccountProviderPayload: '0x',
              bridgeAdapter: ethers.ZeroAddress,
              bridgeAdapterPayload: '0x',
              gasFee: 1000000,
              grossQuantity: 100000,
              walletSignature: '0x',
            },
          }),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeDispatcher');
    });
  });

  describe('cancelPendingWithdrawalFromManagedAccount', () => {
    let exchange: Exchange_v1;

    beforeEach(async () => {
      const [owner] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(owner);
      exchange = results.exchange;
    });

    it('should revert when not called by dispatcher wallet', async () => {
      const nonDispatcherWallet = (await ethers.getSigners())[5];

      await expect(
        exchange
          .connect(nonDispatcherWallet)
          .cancelPendingWithdrawalFromManagedAccount({
            withdrawalType: 0,
            withdrawalByQuantity: {
              nonce: uuidToUint128('00000000-0000-0000-0000-000000000000'),
              managerWallet: (await ethers.getSigners())[10].address,
              depositorWallet: (await ethers.getSigners())[11].address,
              grossQuantity: 100000000,
              maxShares: 10000000,
              maximumGasFee: 1000000,
              managedAccountProvider: ethers.ZeroAddress,
              managedAccountProviderPayload: '0x',
              bridgeAdapter: ethers.ZeroAddress,
              bridgeAdapterPayload: '0x',
              gasFee: 1000000,
              walletSignature: '0x',
            },
            withdrawalByShares: {
              nonce: uuidToUint128('00000000-0000-0000-0000-000000000000'),
              managerWallet: (await ethers.getSigners())[10].address,
              depositorWallet: (await ethers.getSigners())[11].address,
              shares: 1000000,
              minimumQuantity: 100000000,
              maximumGasFee: 1000000,
              managedAccountProvider: ethers.ZeroAddress,
              managedAccountProviderPayload: '0x',
              bridgeAdapter: ethers.ZeroAddress,
              bridgeAdapterPayload: '0x',
              gasFee: 1000000,
              grossQuantity: 100000,
              walletSignature: '0x',
            },
          }),
      ).to.be.revertedWithCustomError(exchange, 'SenderMustBeDispatcher');
    });
  });

  describe('loadBridgeAdaptersLength', () => {
    let exchange: Exchange_v1;
    let governance: Governance;

    beforeEach(async () => {
      const [owner] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(owner);
      exchange = results.exchange;
      governance = results.governance;
    });

    it('should return 0 for empty bridge adapters array', async () => {
      // Initially, no bridge adapters are whitelisted
      await expect(exchange.loadBridgeAdaptersLength()).to.eventually.equal(0);
    });

    it('should return correct length for non-empty bridge adapters array', async () => {
      // Deploy two BridgeAdapterMock instances
      const bridgeAdapter1: BridgeAdapterMock = await (
        await ethers.getContractFactory('BridgeAdapterMock')
      ).deploy();
      await bridgeAdapter1.setExchange(await exchange.getAddress());

      const bridgeAdapter2: BridgeAdapterMock = await (
        await ethers.getContractFactory('BridgeAdapterMock')
      ).deploy();
      await bridgeAdapter2.setExchange(await exchange.getAddress());

      // Whitelist both bridge adapters
      await governance.initiateBridgeAdaptersUpgrade([
        await bridgeAdapter1.getAddress(),
        await bridgeAdapter2.getAddress(),
      ]);
      await time.increase(fieldUpgradeDelayInS);
      await governance.finalizeBridgeAdaptersUpgrade([
        await bridgeAdapter1.getAddress(),
        await bridgeAdapter2.getAddress(),
      ]);

      // Verify length is 2
      await expect(exchange.loadBridgeAdaptersLength()).to.eventually.equal(2);

      // Verify we can load both adapters
      await expect(exchange.loadBridgeAdapter(0)).to.eventually.equal(
        await bridgeAdapter1.getAddress(),
      );
      await expect(exchange.loadBridgeAdapter(1)).to.eventually.equal(
        await bridgeAdapter2.getAddress(),
      );
    });
  });

  describe('domainSeparatorV4', () => {
    let exchange: Exchange_v1;

    beforeEach(async () => {
      const [owner] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(owner);
      exchange = results.exchange;
    });

    it('should return the correct EIP-712 domain separator', async () => {
      const domainSeparator = await exchange.domainSeparatorV4();

      // Verify it's a valid bytes32 value
      expect(domainSeparator).to.match(/^0x[0-9a-fA-F]{64}$/);

      // Verify it's not zero
      expect(domainSeparator).to.not.equal(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      );

      // Compute expected domain separator using ethers
      const expectedDomainSeparator = ethers.TypedDataEncoder.hashDomain(
        getDomainSeparator(await exchange.getAddress(), hardhatChainId),
      );

      // Verify it matches the expected value
      expect(domainSeparator).to.equal(expectedDomainSeparator);
    });
  });
});
