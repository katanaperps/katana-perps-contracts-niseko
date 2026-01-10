import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import { fieldUpgradeDelayInS } from '../lib';

import {
  baseAssetSymbol,
  bootstrapLiquidatedWallet,
  buildIndexPrice,
  deployAndAssociateContracts,
  executeTrade,
  fundWallets,
} from './helpers';

import type {
  ChainlinkOraclePriceAdapter,
  Custodian,
  Exchange_v1,
  Exchange_v1__factory,
  Governance,
  USDC,
  KatanaPerpsIndexAndOraclePriceAdapter,
  BridgeAdapterMock,
  ManagedAccountProviderMock,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('Governance', function () {
  let custodian: Custodian;
  let dispatcherWallet: SignerWithAddress;
  let exchange: Exchange_v1;
  let ExchangeFactory: Exchange_v1__factory;
  let indexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;
  let indexPriceServiceWallet: SignerWithAddress;
  let insuranceFundWallet: SignerWithAddress;
  let governance: Governance;
  let ownerWallet: SignerWithAddress;
  let usdc: USDC;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    const wallets = await ethers.getSigners();
    ownerWallet = wallets[0];
    dispatcherWallet = wallets[1];
    indexPriceServiceWallet = wallets[4];
    insuranceFundWallet = wallets[5];
    const [, , exitFundWallet, feeWallet] = wallets;

    const results = await deployAndAssociateContracts(
      ownerWallet,
      dispatcherWallet,
      exitFundWallet,
      feeWallet,
      indexPriceServiceWallet,
      insuranceFundWallet,
    );

    custodian = results.custodian;
    exchange = results.exchange;
    ExchangeFactory = results.ExchangeFactory;
    governance = results.governance;
    indexPriceAdapter = results.indexPriceAdapter;
    usdc = results.usdc;
  });

  describe('bridge adapters upgrade', () => {
    let bridgeAdapter: BridgeAdapterMock;

    beforeEach(async () => {
      const BridgeAdapterMockFactory = await ethers.getContractFactory(
        'BridgeAdapterMock',
      );
      bridgeAdapter = await BridgeAdapterMockFactory.deploy();
    });

    describe('initiateBridgeAdaptersUpgrade', () => {
      it('should work for valid contract address', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);
        expect(
          governance.queryFilter(
            governance.filters.BridgeAdaptersUpgradeInitiated(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert for invalid address', async () => {
        await expect(
          governance.initiateBridgeAdaptersUpgrade([
            (await ethers.getSigners())[0].address,
          ]),
        ).to.eventually.be.rejectedWith(/invalid adapter address/i);
      });

      it('should revert when already in progress', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await expect(
          governance.initiateBridgeAdaptersUpgrade([
            await bridgeAdapter.getAddress(),
          ]),
        ).to.eventually.be.rejectedWith(/already in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[5])
            .initiateBridgeAdaptersUpgrade([await bridgeAdapter.getAddress()]),
        ).to.be.revertedWithCustomError(governance, 'SenderMustBeAdmin');
      });
    });

    describe('cancelBridgeAdaptersUpgrade', () => {
      it('should work when in progress', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);
        await governance.cancelBridgeAdaptersUpgrade();
        expect(
          governance.queryFilter(
            governance.filters.BridgeAdaptersUpgradeCanceled(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.cancelBridgeAdaptersUpgrade(),
        ).to.eventually.be.rejectedWith(/no adapter upgrade in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[5])
            .cancelBridgeAdaptersUpgrade(),
        ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
      });
    });

    describe('finalizeBridgeAdaptersUpgrade', async () => {
      it('should work after block delay when upgrade was initiated', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);
        expect(
          governance.queryFilter(
            governance.filters.BridgeAdaptersUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should be applied to current Exchange contract following an upgrade', async () => {
        const newExchange = await ExchangeFactory.deploy(
          ethers.ZeroAddress,
          ownerWallet.address,
          ownerWallet.address,
          [await usdc.getAddress()],
          ownerWallet.address,
          await usdc.getAddress(),
          await usdc.getAddress(),
        );
        await newExchange.setCustodian(await custodian.getAddress());

        await governance.initiateExchangeUpgrade(
          await newExchange.getAddress(),
        );
        await governance.finalizeExchangeUpgrade(
          await newExchange.getAddress(),
        );

        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await expect(newExchange.loadBridgeAdapter(0)).to.eventually.equal(
          await bridgeAdapter.getAddress(),
        );
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.finalizeBridgeAdaptersUpgrade([
            await bridgeAdapter.getAddress(),
          ]),
        ).to.eventually.be.rejectedWith(/no adapter upgrade in progress/i);
      });

      it('should revert before block delay', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await expect(
          governance.finalizeBridgeAdaptersUpgrade([
            await bridgeAdapter.getAddress(),
          ]),
        ).to.eventually.be.rejectedWith(
          /block timestamp threshold not yet reached/i,
        );
      });

      it('should revert on address length mismatch', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeBridgeAdaptersUpgrade([
            await bridgeAdapter.getAddress(),
            ownerWallet.address,
          ]),
        ).to.eventually.be.rejectedWith(/address mismatch/i);
      });

      it('should revert on address mismatch', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeBridgeAdaptersUpgrade([ownerWallet.address]),
        ).to.eventually.be.rejectedWith(/address mismatch/i);
      });

      it('should revert when not called by admin or dispatcher', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await expect(
          governance
            .connect((await ethers.getSigners())[10])
            .finalizeBridgeAdaptersUpgrade([await bridgeAdapter.getAddress()]),
        ).to.eventually.be.rejectedWith(
          /caller must be admin or dispatcher wallet/i,
        );
      });
    });

    describe('Index Price Adapter upgrade', () => {
      let newIndexPriceAdapter: KatanaPerpsIndexAndOraclePriceAdapter;

      beforeEach(async () => {
        newIndexPriceAdapter = await (
          await (
            await ethers.getContractFactory(
              'KatanaPerpsIndexAndOraclePriceAdapter',
            )
          ).deploy(await governance.getAddress(), [
            indexPriceServiceWallet.address,
          ])
        ).waitForDeployment();
      });

      describe('initiateIndexPriceAdaptersUpgrade', () => {
        it('should work for valid wallet address', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);
          expect(
            governance.queryFilter(
              governance.filters.IndexPriceAdaptersUpgradeInitiated(),
            ),
          )
            .to.eventually.be.an('array')
            .with.lengthOf(1);
        });

        it('should revert for invalid address', async () => {
          await expect(
            governance.initiateIndexPriceAdaptersUpgrade([ethers.ZeroAddress]),
          ).to.eventually.be.rejectedWith(
            /invalid index price adapter address/i,
          );
        });

        it('should revert when already in progress', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await expect(
            governance.initiateIndexPriceAdaptersUpgrade([
              await newIndexPriceAdapter.getAddress(),
            ]),
          ).to.eventually.be.rejectedWith(/already in progress/i);
        });

        it('should revert when not called by admin', async () => {
          await expect(
            governance
              .connect((await ethers.getSigners())[5])
              .initiateIndexPriceAdaptersUpgrade([
                await newIndexPriceAdapter.getAddress(),
              ]),
          ).to.be.revertedWithCustomError(governance, 'SenderMustBeAdmin');
        });
      });

      describe('cancelIndexPriceAdaptersUpgrade', () => {
        it('should work when in progress', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);
          await governance.cancelIndexPriceAdaptersUpgrade();
          expect(
            governance.queryFilter(
              governance.filters.IndexPriceAdaptersUpgradeCanceled(),
            ),
          )
            .to.eventually.be.an('array')
            .with.lengthOf(1);
        });

        it('should revert when not in progress', async () => {
          await expect(
            governance.cancelIndexPriceAdaptersUpgrade(),
          ).to.eventually.be.rejectedWith(
            /no index price adapter upgrade in progress/i,
          );
        });

        it('should revert when not called by admin', async () => {
          await expect(
            governance
              .connect((await ethers.getSigners())[5])
              .cancelIndexPriceAdaptersUpgrade(),
          ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
        });
      });

      describe('finalizeIndexPriceAdaptersUpgrade', async () => {
        it('should work when in progress', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await time.increase(fieldUpgradeDelayInS);

          await governance.finalizeIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);
          expect(
            governance.queryFilter(
              governance.filters.IndexPriceAdaptersUpgradeFinalized(),
            ),
          )
            .to.eventually.be.an('array')
            .with.lengthOf(1);

          await expect(
            exchange.loadIndexPriceAdaptersLength(),
          ).to.eventually.equal(1);
          await expect(exchange.loadIndexPriceAdapter(0)).to.eventually.equal(
            await newIndexPriceAdapter.getAddress(),
          );
        });

        it('should revert when not in progress', async () => {
          await expect(
            governance.finalizeIndexPriceAdaptersUpgrade([
              await newIndexPriceAdapter.getAddress(),
            ]),
          ).to.eventually.be.rejectedWith(
            /no index price adapter upgrade in progress/i,
          );
        });

        it('should revert before block delay', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await expect(
            governance.finalizeIndexPriceAdaptersUpgrade([
              await newIndexPriceAdapter.getAddress(),
            ]),
          ).to.eventually.be.rejectedWith(
            /block timestamp threshold not yet reached/i,
          );
        });

        it('should revert on address length mismatch', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await time.increase(fieldUpgradeDelayInS);

          await expect(
            governance.finalizeIndexPriceAdaptersUpgrade([
              await newIndexPriceAdapter.getAddress(),
              await newIndexPriceAdapter.getAddress(),
            ]),
          ).to.eventually.be.rejectedWith(/address mismatch/i);
        });

        it('should revert on address mismatch', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await time.increase(fieldUpgradeDelayInS);

          await expect(
            governance.finalizeIndexPriceAdaptersUpgrade([ownerWallet.address]),
          ).to.eventually.be.rejectedWith(/address mismatch/i);
        });

        it('should revert when not called by admin or dispatcher', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await expect(
            governance
              .connect((await ethers.getSigners())[10])
              .finalizeIndexPriceAdaptersUpgrade([
                await newIndexPriceAdapter.getAddress(),
              ]),
          ).to.eventually.be.rejectedWith(
            /caller must be admin or dispatcher wallet/i,
          );
        });
      });
    });
  });

  describe('Oracle Price Adapter upgrade', () => {
    let newOraclePriceAdapter: ChainlinkOraclePriceAdapter;

    beforeEach(async () => {
      const [ChainlinkAggregatorFactory, ChainlinkOraclePriceAdapter] =
        await Promise.all([
          ethers.getContractFactory('ChainlinkAggregatorMock'),
          ethers.getContractFactory('ChainlinkOraclePriceAdapter'),
        ]);

      const chainlinkAggregator = await (
        await ChainlinkAggregatorFactory.deploy()
      ).waitForDeployment();

      newOraclePriceAdapter = await (
        await ChainlinkOraclePriceAdapter.deploy(
          [baseAssetSymbol],
          [await chainlinkAggregator.getAddress()],
        )
      ).waitForDeployment();
    });

    describe('initiateOraclePriceAdapterUpgrade', () => {
      it('should work for valid wallet address', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );
        expect(
          governance.queryFilter(
            governance.filters.OraclePriceAdapterUpgradeInitiated(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert for invalid address', async () => {
        await expect(
          governance.initiateOraclePriceAdapterUpgrade(ethers.ZeroAddress),
        ).to.be.revertedWith(/invalid oracle price adapter address/i);
      });

      it('should revert when already in progress', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );

        await expect(
          governance.initiateOraclePriceAdapterUpgrade(
            await newOraclePriceAdapter.getAddress(),
          ),
        ).to.be.revertedWith(/already in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[5])
            .initiateOraclePriceAdapterUpgrade(
              await newOraclePriceAdapter.getAddress(),
            ),
        ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
      });
    });

    describe('cancelOraclePriceAdapterUpgrade', () => {
      it('should work when in progress', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );
        await governance.cancelOraclePriceAdapterUpgrade();
        expect(
          governance.queryFilter(
            governance.filters.OraclePriceAdapterUpgradeCanceled(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.cancelOraclePriceAdapterUpgrade(),
        ).to.eventually.be.rejectedWith(
          /no oracle price adapter upgrade in progress/i,
        );
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[5])
            .cancelOraclePriceAdapterUpgrade(),
        ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
      });
    });

    describe('finalizeOraclePriceAdapterUpgrade', async () => {
      it('should work when in progress', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );
        expect(
          governance.queryFilter(
            governance.filters.OraclePriceAdapterUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.finalizeOraclePriceAdapterUpgrade(
            await newOraclePriceAdapter.getAddress(),
          ),
        ).to.eventually.be.rejectedWith(
          /no oracle price adapter upgrade in progress/i,
        );
      });

      it('should revert before block delay', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );

        await expect(
          governance.finalizeOraclePriceAdapterUpgrade(
            await newOraclePriceAdapter.getAddress(),
          ),
        ).to.eventually.be.rejectedWith(
          /block timestamp threshold not yet reached/i,
        );
      });

      it('should revert on address mismatch', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeOraclePriceAdapterUpgrade(ownerWallet.address),
        ).to.eventually.be.rejectedWith(/address mismatch/i);
      });

      it('should revert when not called by admin or dispatcher', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance
            .connect((await ethers.getSigners())[10])
            .finalizeOraclePriceAdapterUpgrade(ownerWallet.address),
        ).to.eventually.be.rejectedWith(
          /caller must be admin or dispatcher wallet/i,
        );
      });
    });
  });

  describe('IF wallet upgrade', () => {
    describe('initiateInsuranceFundWalletUpgrade', () => {
      let newInsuranceFundWallet: SignerWithAddress;

      beforeEach(async () => {
        [newInsuranceFundWallet] = await ethers.getSigners();
      });

      it('should work for valid wallet address', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        expect(
          governance.queryFilter(
            governance.filters.InsuranceFundWalletUpgradeInitiated(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert for zero address', async () => {
        await expect(
          governance.initiateInsuranceFundWalletUpgrade(ethers.ZeroAddress),
        ).to.eventually.be.rejectedWith(/invalid IF wallet address/i);
      });

      it('should revert if new IF is same as current', async () => {
        await expect(
          governance.initiateInsuranceFundWalletUpgrade(
            insuranceFundWallet.address,
          ),
        ).to.eventually.be.rejectedWith(/must be different from current/i);
      });

      it('should revert when upgrade already in progress', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );
        await expect(
          governance.initiateInsuranceFundWalletUpgrade(
            newInsuranceFundWallet.address,
          ),
        ).to.be.revertedWith(/upgrade already in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[1])
            .initiateInsuranceFundWalletUpgrade(newInsuranceFundWallet.address),
        ).to.be.revertedWithCustomError(governance, 'SenderMustBeAdmin');
      });
    });

    describe('cancelInsuranceFundWalletUpgrade', () => {
      let newInsuranceFundWallet: SignerWithAddress;

      beforeEach(async () => {
        [newInsuranceFundWallet] = await ethers.getSigners();
      });

      it('should work when in progress', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );
        await governance.cancelInsuranceFundWalletUpgrade();
        expect(
          governance.queryFilter(
            governance.filters.InsuranceFundWalletUpgradeCanceled(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.cancelInsuranceFundWalletUpgrade(),
        ).to.eventually.be.rejectedWith(/no IF wallet upgrade in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[5])
            .cancelInsuranceFundWalletUpgrade(),
        ).to.be.revertedWithCustomError(exchange, 'SenderMustBeAdmin');
      });
    });

    describe('finalizeInsuranceFundWalletUpgrade', () => {
      let newInsuranceFundWallet: SignerWithAddress;

      before(async () => {
        newInsuranceFundWallet = (await ethers.getSigners())[10];
      });

      it('should work after block delay when upgrade was initiated', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await expect(exchange.insuranceFundWallet()).to.eventually.equal(
          newInsuranceFundWallet.address,
        );
        expect(
          governance.queryFilter(
            governance.filters.InsuranceFundWalletUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.finalizeInsuranceFundWalletUpgrade(
            newInsuranceFundWallet.address,
          ),
        ).to.eventually.be.rejectedWith(/no IF wallet upgrade in progress/i);
      });

      it('should revert on address  mismatch', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeInsuranceFundWalletUpgrade(ownerWallet.address),
        ).to.eventually.be.rejectedWith(/address mismatch/i);
      });

      it('should revert before block delay', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await expect(
          governance.finalizeInsuranceFundWalletUpgrade(
            newInsuranceFundWallet.address,
          ),
        ).to.eventually.be.rejectedWith(
          /block timestamp threshold not yet reached/i,
        );
      });

      it('should revert when current IF has open position', async () => {
        const results = await bootstrapLiquidatedWallet();

        await results.governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          results.governance.finalizeInsuranceFundWalletUpgrade(
            newInsuranceFundWallet.address,
          ),
        ).to.eventually.be.rejectedWith(
          /current IF cannot have open positions/i,
        );
      });

      it('should revert when new IF has open position', async () => {
        const trader1Wallet = (await ethers.getSigners())[6];
        const trader2Wallet = (await ethers.getSigners())[7];
        await fundWallets(
          [trader1Wallet, trader2Wallet],
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
          trader1Wallet,
          trader2Wallet,
        );

        await governance.initiateInsuranceFundWalletUpgrade(
          trader1Wallet.address,
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeInsuranceFundWalletUpgrade(trader1Wallet.address),
        ).to.be.revertedWith(/new IF cannot have open positions/i);
      });

      it('should revert when new IF is exited', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await time.increase(fieldUpgradeDelayInS);

        await exchange
          .connect(newInsuranceFundWallet)
          .exitWallet(newInsuranceFundWallet.address);

        await expect(
          governance.finalizeInsuranceFundWalletUpgrade(
            newInsuranceFundWallet.address,
          ),
        ).to.be.revertedWithCustomError(
          exchange,
          'NewInsuranceFundWalletCannotBeExited',
        );
      });

      it('should revert when not called by admin or dispatcher', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[10])
            .finalizeInsuranceFundWalletUpgrade(newInsuranceFundWallet.address),
        ).to.eventually.be.rejectedWith(
          /caller must be admin or dispatcher wallet/i,
        );
      });
    });
  });

  describe('Managed Account Provider upgrade', () => {
    let managedAccountProvider: ManagedAccountProviderMock;

    beforeEach(async () => {
      managedAccountProvider = await (
        await ethers.getContractFactory('ManagedAccountProviderMock')
      ).deploy(await exchange.getAddress());
    });

    describe('initiateManagedAccountProvidersUpgrade', () => {
      it('should succeed when called with valid arguments and sender wallet', async () => {
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);
        await expect(
          governance.queryFilter(
            governance.filters.ManagedAccountProvidersUpgradeInitiated(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when an upgrade is already in progress', async () => {
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);

        await expect(
          governance.initiateManagedAccountProvidersUpgrade([
            await managedAccountProvider.getAddress(),
          ]),
        ).to.be.revertedWith(
          'Managed Account Providers upgrade already in progress',
        );
      });

      it('should revert when one of the addresses passed in is not a valid contract address', async () => {
        await expect(
          governance.initiateManagedAccountProvidersUpgrade([
            ownerWallet.address,
          ]),
        ).to.be.revertedWith('Invalid Managed Account Provider address');
      });

      it('should revert when the function is called by a wallet that is not admin', async () => {
        const nonAdminWallet = (await ethers.getSigners())[5];
        await expect(
          governance
            .connect(nonAdminWallet)
            .initiateManagedAccountProvidersUpgrade([
              await managedAccountProvider.getAddress(),
            ]),
        ).to.be.revertedWithCustomError(governance, 'SenderMustBeAdmin');
      });

      it('should revert when existing MA providers are not included in matching order', async () => {
        // 1. First, whitelist an initial MA provider
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);
        await time.increase(fieldUpgradeDelayInS);
        await governance.finalizeManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);

        // 2. Create a second MA provider
        const vault2 = await (
          await ethers.getContractFactory('ManagedAccountProviderMock')
        ).deploy(await exchange.getAddress());

        // 3. Attempt to upgrade without including the existing provider (should fail)
        await expect(
          governance.initiateManagedAccountProvidersUpgrade([
            await vault2.getAddress(),
          ]),
        ).to.be.revertedWith(
          /current managed account provider addresses must be included/i,
        );

        // 4. Attempt to upgrade with providers in wrong order (should fail)
        await expect(
          governance.initiateManagedAccountProvidersUpgrade([
            await vault2.getAddress(),
            await managedAccountProvider.getAddress(),
          ]),
        ).to.be.revertedWith(
          /current managed account provider addresses must be included/i,
        );

        // 5. Verify correct order works
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
          await vault2.getAddress(),
        ]);
        await expect(
          governance.queryFilter(
            governance.filters.ManagedAccountProvidersUpgradeInitiated(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(2); // One from earlier, one from this successful upgrade
      });
    });

    describe('cancelManagedAccountProvidersUpgrade', () => {
      it('should succeed when called by admin', async () => {
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);
        await governance.cancelManagedAccountProvidersUpgrade();
        await expect(
          governance.queryFilter(
            governance.filters.ManagedAccountProvidersUpgradeCanceled(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when called by a non-admin wallet', async () => {
        const nonAdminWallet = (await ethers.getSigners())[5];
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);
        await expect(
          governance
            .connect(nonAdminWallet)
            .cancelManagedAccountProvidersUpgrade(),
        ).to.be.revertedWithCustomError(governance, 'SenderMustBeAdmin');
      });

      it('should revert when no upgrade is in progress', async () => {
        await expect(
          governance.cancelManagedAccountProvidersUpgrade(),
        ).to.be.revertedWith(
          'No Managed Account Providers upgrade in progress',
        );
      });
    });

    describe('finalizeManagedAccountProvidersUpgrade', () => {
      it('should succeed when upgrade is in progress and called by admin with correct arguments', async () => {
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);
        await expect(
          governance.queryFilter(
            governance.filters.ManagedAccountProvidersUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when called by a wallet that is not admin or dispatcher', async () => {
        const nonAdminWallet = (await ethers.getSigners())[10];
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance
            .connect(nonAdminWallet)
            .finalizeManagedAccountProvidersUpgrade([
              await managedAccountProvider.getAddress(),
            ]),
        ).to.be.revertedWith('Caller must be Admin or Dispatcher wallet');
      });

      it('should revert when no upgrade is in progress', async () => {
        await expect(
          governance.finalizeManagedAccountProvidersUpgrade([
            await managedAccountProvider.getAddress(),
          ]),
        ).to.be.revertedWith(
          'No Managed Account Providers upgrade in progress',
        );
      });

      it('should revert before block delay', async () => {
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);

        await expect(
          governance.finalizeManagedAccountProvidersUpgrade([
            await managedAccountProvider.getAddress(),
          ]),
        ).to.be.revertedWith('Block timestamp threshold not yet reached');
      });

      it('should revert on address mismatch', async () => {
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeManagedAccountProvidersUpgrade([
            ownerWallet.address,
          ]),
        ).to.be.revertedWith('Address mismatch');
      });

      it('should revert when stored and argument arrays are different lengths', async () => {
        await governance.initiateManagedAccountProvidersUpgrade([
          await managedAccountProvider.getAddress(),
          await managedAccountProvider.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeManagedAccountProvidersUpgrade([
            await managedAccountProvider.getAddress(),
          ]),
        ).to.be.revertedWith('Address mismatch');
      });
    });
  });

  describe('market overrides upgrade', () => {
    const marketOverrides = {
      initialMarginFraction: '3000000',
      maintenanceMarginFraction: '1000000',
      incrementalInitialMarginFraction: '1000000',
      baselinePositionSize: '14000000000',
      incrementalPositionSize: '2800000000',
      maximumPositionSize: '1000000000000',
      minimumPositionSize: '10000000',
    };
    let walletToOverride: string;

    before(async () => {
      walletToOverride = (await ethers.getSigners())[10].address;
    });

    describe('initiateMarketOverridesUpgrade', () => {
      it('should work for valid wallet address', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        expect(
          governance.queryFilter(
            governance.filters.MarketOverridesUpgradeInitiated(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when upgrade already in progress', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await expect(
          governance.initiateMarketOverridesUpgrade(
            baseAssetSymbol,
            marketOverrides,
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(/upgrade already in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[1])
            .initiateMarketOverridesUpgrade(
              baseAssetSymbol,
              marketOverrides,
              walletToOverride,
            ),
        ).to.be.revertedWithCustomError(governance, 'SenderMustBeAdmin');
      });
    });

    describe('cancelMarketOverridesUpgrade', () => {
      it('should work when in progress', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );
        await governance.cancelMarketOverridesUpgrade(
          baseAssetSymbol,
          walletToOverride,
        );
        expect(
          governance.queryFilter(
            governance.filters.MarketOverridesUpgradeCanceled(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.cancelMarketOverridesUpgrade(
            baseAssetSymbol,
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(
          /no market override upgrade in progress/i,
        );
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[10])
            .cancelMarketOverridesUpgrade(baseAssetSymbol, walletToOverride),
        ).to.be.revertedWithCustomError(governance, 'SenderMustBeAdmin');
      });
    });

    describe('finalizeMarketOverridesUpgrade', () => {
      it('should work after block delay when upgrade was initiated', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        expect(
          governance.queryFilter(
            governance.filters.MarketOverridesUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should work when wallet is zero', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          ethers.ZeroAddress,
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          ethers.ZeroAddress,
        );

        expect(
          governance.queryFilter(
            governance.filters.MarketOverridesUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert for invalid market ', async () => {
        await governance.initiateMarketOverridesUpgrade(
          'XYZ',
          marketOverrides,
          ethers.ZeroAddress,
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeMarketOverridesUpgrade(
            'XYZ',
            marketOverrides,
            ethers.ZeroAddress,
          ),
        ).to.eventually.be.rejectedWith(/UnknownBaseAssetSymbol/i);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.finalizeMarketOverridesUpgrade(
            baseAssetSymbol,
            marketOverrides,
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(
          /no market override upgrade in progress for wallet/i,
        );
      });

      it('should revert before block delay', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await expect(
          governance.finalizeMarketOverridesUpgrade(
            baseAssetSymbol,
            marketOverrides,
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(
          /block timestamp threshold not yet reached/i,
        );
      });

      it('should revert on field mismatch', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeMarketOverridesUpgrade(
            baseAssetSymbol,
            { ...marketOverrides, initialMarginFraction: '5000000' },
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(/overrides mismatch/i);
      });

      it('should revert when not called by admin or dispatcher', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[10])
            .finalizeMarketOverridesUpgrade(
              baseAssetSymbol,
              marketOverrides,
              walletToOverride,
            ),
        ).to.eventually.be.rejectedWith(
          /caller must be admin or dispatcher wallet/i,
        );
      });
    });

    describe('unsetMarketOverridesForWallet', () => {
      it('should work for valid market and wallet when called by admin', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await exchange.unsetMarketOverridesForWallet(
          baseAssetSymbol,
          walletToOverride,
        );

        await expect(
          exchange.queryFilter(exchange.filters.MarketOverridesUnset()),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should work for valid market and wallet when called by dispatcher', async () => {
        await exchange.setDispatcher((await ethers.getSigners())[5].address);

        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await exchange
          .connect((await ethers.getSigners())[5])
          .unsetMarketOverridesForWallet(baseAssetSymbol, walletToOverride);

        await expect(
          exchange.queryFilter(exchange.filters.MarketOverridesUnset()),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert for invalid market ', async () => {
        await expect(
          exchange.unsetMarketOverridesForWallet('XYZ', walletToOverride),
        ).to.eventually.be.rejectedWith(/UnknownBaseAssetSymbol/i);
      });

      it('should revert for zero wallet address ', async () => {
        await expect(
          exchange.unsetMarketOverridesForWallet(
            baseAssetSymbol,
            ethers.ZeroAddress,
          ),
        ).to.eventually.be.rejectedWith(/InvalidWalletAddress/i);
      });

      it('should revert for wallet with no overrides ', async () => {
        await expect(
          exchange.unsetMarketOverridesForWallet(
            baseAssetSymbol,
            walletToOverride,
          ),
        ).to.be.revertedWithCustomError(
          exchange,
          'WalletHasNoOverridesForMarket',
        );
      });

      it('should revert when not called by admin', async () => {
        await expect(
          exchange
            .connect((await ethers.getSigners())[5])
            .unsetMarketOverridesForWallet(baseAssetSymbol, walletToOverride),
        ).to.be.revertedWithCustomError(
          exchange,
          'SenderMustBeAdminOrDispatcher',
        );
      });
    });
  });

  describe('initiateMarketOverridesUpgradeForInsuranceFundWallet', () => {
    const marketOverrides = {
      initialMarginFraction: '3000000',
      maintenanceMarginFraction: '1000000',
      incrementalInitialMarginFraction: '1000000',
      baselinePositionSize: '14000000000',
      incrementalPositionSize: '2800000000',
      maximumPositionSize: '1000000000000',
      minimumPositionSize: '10000000',
    };
    let exchangeAdminWallet: SignerWithAddress;
    let governanceAdminWallet: SignerWithAddress;

    beforeEach(async () => {
      // Set different admins for Exchange and Governance to properly test authorization
      const wallets = await ethers.getSigners();
      exchangeAdminWallet = wallets[8];
      governanceAdminWallet = ownerWallet; // This is the current Governance admin

      // Transfer Exchange admin to a different wallet
      await exchange.setAdmin(exchangeAdminWallet.address);
    });

    it('should work when called by Exchange admin with correct IF wallet', async () => {
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      expect(
        governance.queryFilter(
          governance.filters.MarketOverridesUpgradeInitiated(),
        ),
      )
        .to.eventually.be.an('array')
        .with.lengthOf(1);
    });

    it('should revert when called by Governance admin instead of Exchange admin', async () => {
      await expect(
        governance
          .connect(governanceAdminWallet)
          .initiateMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(/Caller must be Exchange Admin/i);
    });

    it('should revert when wallet does not match current IF wallet', async () => {
      const randomWallet = (await ethers.getSigners())[9];

      await expect(
        governance
          .connect(exchangeAdminWallet)
          .initiateMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            randomWallet.address,
          ),
      ).to.be.revertedWith(/Wallet must be currently whitelisted IF wallet/i);
    });

    it('should revert when wallet is zero address', async () => {
      await expect(
        governance
          .connect(exchangeAdminWallet)
          .initiateMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            ethers.ZeroAddress,
          ),
      ).to.be.revertedWith(/Wallet must be currently whitelisted IF wallet/i);
    });

    it('should revert when upgrade already in progress for IF wallet', async () => {
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      await expect(
        governance
          .connect(exchangeAdminWallet)
          .initiateMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(
        /Market override upgrade already in progress for IF wallet/i,
      );
    });

    it('should revert when called by non-admin wallet', async () => {
      const nonAdminWallet = (await ethers.getSigners())[10];

      await expect(
        governance
          .connect(nonAdminWallet)
          .initiateMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(/Caller must be Exchange Admin/i);
    });

    it('should allow both Governance admin and Exchange admin to set overrides for different wallets', async () => {
      const regularWallet = (await ethers.getSigners())[11];

      // Governance admin can set overrides for regular wallet
      await governance
        .connect(governanceAdminWallet)
        .initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          regularWallet.address,
        );

      // Exchange admin can set overrides for IF wallet
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      const events = await governance.queryFilter(
        governance.filters.MarketOverridesUpgradeInitiated(),
      );

      expect(events).to.be.an('array').with.lengthOf(2);
    });
  });

  describe('cancelMarketOverridesUpgradeForInsuranceFundWallet', () => {
    const marketOverrides = {
      initialMarginFraction: '3000000',
      maintenanceMarginFraction: '1000000',
      incrementalInitialMarginFraction: '1000000',
      baselinePositionSize: '14000000000',
      incrementalPositionSize: '2800000000',
      maximumPositionSize: '1000000000000',
      minimumPositionSize: '10000000',
    };
    let exchangeAdminWallet: SignerWithAddress;
    let governanceAdminWallet: SignerWithAddress;

    beforeEach(async () => {
      // Set different admins for Exchange and Governance to properly test authorization
      const wallets = await ethers.getSigners();
      exchangeAdminWallet = wallets[8];
      governanceAdminWallet = ownerWallet; // This is the current Governance admin

      // Transfer Exchange admin to a different wallet
      await exchange.setAdmin(exchangeAdminWallet.address);
    });

    it('should work when called by Exchange admin with correct IF wallet', async () => {
      // First initiate an upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Then cancel it
      await governance
        .connect(exchangeAdminWallet)
        .cancelMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          insuranceFundWallet.address,
        );

      expect(
        governance.queryFilter(
          governance.filters.MarketOverridesUpgradeCanceled(),
        ),
      )
        .to.eventually.be.an('array')
        .with.lengthOf(1);
    });

    it('should revert when called by Governance admin instead of Exchange admin', async () => {
      // First initiate an upgrade with Exchange admin
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Try to cancel with Governance admin (should fail)
      await expect(
        governance
          .connect(governanceAdminWallet)
          .cancelMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(/Caller must be Exchange Admin/i);
    });

    it('should revert when wallet does not match current IF wallet', async () => {
      const randomWallet = (await ethers.getSigners())[9];

      // First initiate an upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Try to cancel with wrong wallet address
      await expect(
        governance
          .connect(exchangeAdminWallet)
          .cancelMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            randomWallet.address,
          ),
      ).to.be.revertedWith(/Wallet must be currently whitelisted IF wallet/i);
    });

    it('should revert when wallet is zero address', async () => {
      // First initiate an upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Try to cancel with zero address
      await expect(
        governance
          .connect(exchangeAdminWallet)
          .cancelMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            ethers.ZeroAddress,
          ),
      ).to.be.revertedWith(/Wallet must be currently whitelisted IF wallet/i);
    });

    it('should revert when no upgrade is in progress', async () => {
      await expect(
        governance
          .connect(exchangeAdminWallet)
          .cancelMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(
        /No market override upgrade in progress for wallet/i,
      );
    });

    it('should revert when called by non-admin wallet', async () => {
      const nonAdminWallet = (await ethers.getSigners())[10];

      // First initiate an upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Try to cancel with non-admin wallet
      await expect(
        governance
          .connect(nonAdminWallet)
          .cancelMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(/Caller must be Exchange Admin/i);
    });

    it('should allow cancellation after upgrade was initiated', async () => {
      // Initiate upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Verify upgrade is in progress by checking the stored upgrade
      const upgrade =
        await governance.currentMarketOverridesUpgradesByBaseAssetSymbolAndWallet(
          baseAssetSymbol,
          insuranceFundWallet.address,
        );
      expect(upgrade.exists).to.be.true;

      // Cancel the upgrade
      await governance
        .connect(exchangeAdminWallet)
        .cancelMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          insuranceFundWallet.address,
        );

      // Verify upgrade is no longer in progress
      const upgradeAfterCancel =
        await governance.currentMarketOverridesUpgradesByBaseAssetSymbolAndWallet(
          baseAssetSymbol,
          insuranceFundWallet.address,
        );
      expect(upgradeAfterCancel.exists).to.be.false;
    });

    it('should allow re-initiation after cancellation', async () => {
      // Initiate upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Cancel the upgrade
      await governance
        .connect(exchangeAdminWallet)
        .cancelMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          insuranceFundWallet.address,
        );

      // Should be able to initiate again
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      expect(
        governance.queryFilter(
          governance.filters.MarketOverridesUpgradeInitiated(),
        ),
      )
        .to.eventually.be.an('array')
        .with.lengthOf(2); // Two initiations
    });
  });

  describe('finalizeMarketOverridesUpgradeForInsuranceFundWallet', () => {
    const marketOverrides = {
      initialMarginFraction: '3000000',
      maintenanceMarginFraction: '1000000',
      incrementalInitialMarginFraction: '1000000',
      baselinePositionSize: '14000000000',
      incrementalPositionSize: '2800000000',
      maximumPositionSize: '1000000000000',
      minimumPositionSize: '10000000',
    };
    let exchangeAdminWallet: SignerWithAddress;
    let governanceAdminWallet: SignerWithAddress;

    beforeEach(async () => {
      // Set different admins for Exchange and Governance to properly test authorization
      const wallets = await ethers.getSigners();
      exchangeAdminWallet = wallets[8];
      governanceAdminWallet = ownerWallet; // This is the current Governance admin

      // Transfer Exchange admin to a different wallet
      await exchange.setAdmin(exchangeAdminWallet.address);
    });

    it('should work when called by Exchange admin with correct IF wallet after delay', async () => {
      // Initiate upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Wait for delay
      await time.increase(fieldUpgradeDelayInS);

      // Finalize upgrade
      await governance
        .connect(exchangeAdminWallet)
        .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      expect(
        governance.queryFilter(
          governance.filters.MarketOverridesUpgradeFinalized(),
        ),
      )
        .to.eventually.be.an('array')
        .with.lengthOf(1);
    });

    it('should work when called by dispatcher with correct IF wallet after delay', async () => {
      // Initiate upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Wait for delay
      await time.increase(fieldUpgradeDelayInS);

      // Finalize upgrade with dispatcher
      await governance
        .connect(dispatcherWallet)
        .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      expect(
        governance.queryFilter(
          governance.filters.MarketOverridesUpgradeFinalized(),
        ),
      )
        .to.eventually.be.an('array')
        .with.lengthOf(1);
    });

    it('should revert when called by Governance admin instead of Exchange admin', async () => {
      // Initiate upgrade with Exchange admin
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Wait for delay
      await time.increase(fieldUpgradeDelayInS);

      // Try to finalize with Governance admin (should fail)
      await expect(
        governance
          .connect(governanceAdminWallet)
          .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(
        /Caller must be Exchange Admin or Dispatcher wallet/i,
      );
    });

    it('should revert when wallet does not match current IF wallet', async () => {
      const randomWallet = (await ethers.getSigners())[9];

      // Initiate upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Wait for delay
      await time.increase(fieldUpgradeDelayInS);

      // Try to finalize with wrong wallet address
      await expect(
        governance
          .connect(exchangeAdminWallet)
          .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            randomWallet.address,
          ),
      ).to.be.revertedWith(/Wallet must be currently whitelisted IF wallet/i);
    });

    it('should revert when wallet is zero address', async () => {
      // Initiate upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Wait for delay
      await time.increase(fieldUpgradeDelayInS);

      // Try to finalize with zero address
      await expect(
        governance
          .connect(exchangeAdminWallet)
          .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            ethers.ZeroAddress,
          ),
      ).to.be.revertedWith(/Wallet must be currently whitelisted IF wallet/i);
    });

    it('should revert when no upgrade is in progress', async () => {
      await expect(
        governance
          .connect(exchangeAdminWallet)
          .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(
        /No market override upgrade in progress for wallet/i,
      );
    });

    it('should revert before block delay', async () => {
      // Initiate upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Try to finalize immediately without waiting for delay
      await expect(
        governance
          .connect(exchangeAdminWallet)
          .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(/Block timestamp threshold not yet reached/i);
    });

    it('should revert on field mismatch', async () => {
      // Initiate upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Wait for delay
      await time.increase(fieldUpgradeDelayInS);

      // Try to finalize with different overrides
      await expect(
        governance
          .connect(exchangeAdminWallet)
          .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            { ...marketOverrides, initialMarginFraction: '5000000' },
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(/Overrides mismatch/i);
    });

    it('should revert when called by non-admin/non-dispatcher wallet', async () => {
      const nonAdminWallet = (await ethers.getSigners())[10];

      // Initiate upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Wait for delay
      await time.increase(fieldUpgradeDelayInS);

      // Try to finalize with non-admin/non-dispatcher wallet
      await expect(
        governance
          .connect(nonAdminWallet)
          .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
            baseAssetSymbol,
            marketOverrides,
            insuranceFundWallet.address,
          ),
      ).to.be.revertedWith(
        /Caller must be Exchange Admin or Dispatcher wallet/i,
      );
    });

    it('should properly apply overrides to the Exchange', async () => {
      // Initiate upgrade
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Wait for delay
      await time.increase(fieldUpgradeDelayInS);

      // Finalize upgrade
      await governance
        .connect(exchangeAdminWallet)
        .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Verify the upgrade was cleared from storage
      const upgradeAfterFinalize =
        await governance.currentMarketOverridesUpgradesByBaseAssetSymbolAndWallet(
          baseAssetSymbol,
          insuranceFundWallet.address,
        );
      expect(upgradeAfterFinalize.exists).to.be.false;

      // Verify event was emitted
      const events = await governance.queryFilter(
        governance.filters.MarketOverridesUpgradeFinalized(),
      );
      expect(events).to.be.an('array').with.lengthOf(1);
      expect(events[0].args?.baseAssetSymbol).to.equal(baseAssetSymbol);
      expect(events[0].args?.wallet).to.equal(insuranceFundWallet.address);
    });

    it('should allow both Governance admin and Exchange admin to finalize overrides for different wallets', async () => {
      const regularWallet = (await ethers.getSigners())[11];

      // Governance admin initiates for regular wallet
      await governance
        .connect(governanceAdminWallet)
        .initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          regularWallet.address,
        );

      // Exchange admin initiates for IF wallet
      await governance
        .connect(exchangeAdminWallet)
        .initiateMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      // Wait for delay
      await time.increase(fieldUpgradeDelayInS);

      // Governance admin finalizes for regular wallet
      await governance
        .connect(governanceAdminWallet)
        .finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          regularWallet.address,
        );

      // Exchange admin finalizes for IF wallet
      await governance
        .connect(exchangeAdminWallet)
        .finalizeMarketOverridesUpgradeForInsuranceFundWallet(
          baseAssetSymbol,
          marketOverrides,
          insuranceFundWallet.address,
        );

      const events = await governance.queryFilter(
        governance.filters.MarketOverridesUpgradeFinalized(),
      );
      expect(events).to.be.an('array').with.lengthOf(2);
    });
  });
});
