import { ethers } from 'hardhat';
import { beforeEach } from 'mocha';

import { decimalToPips } from '../lib';

import { buildComposeMessage } from './exchange-layer-zero-adapter';
import { expect, quoteAssetDecimals } from './helpers';

import type {
  KatanaPerpsStargateForwarder_v1,
  StargateV2PoolMock,
  USDC,
  VbUSDC,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// The actual values for the below are not important
const ethereumEndpointId = 9999999;
const katanaEndpointId = 88888888;
const katanaComposeGasLimit = 1000000;

describe.only('KatanaPerpsStargateForwarder_v1', function () {
  let forwarder: KatanaPerpsStargateForwarder_v1;
  let ownerWallet: SignerWithAddress;
  let stargatePoolMock: StargateV2PoolMock;
  let traderWallet: SignerWithAddress;
  let usdc: USDC;
  let vbUsdc: VbUSDC;
  let vbUsdcOftAdapterMock: StargateV2PoolMock;
  let forwarderComposingAddress: string;

  beforeEach(async () => {
    usdc = await (await ethers.getContractFactory('USDC')).deploy();
    vbUsdc = await (
      await ethers.getContractFactory('VbUSDC')
    ).deploy(await usdc.getAddress());
    stargatePoolMock = await (
      await ethers.getContractFactory('StargateV2PoolMock')
    ).deploy(0, 0, await usdc.getAddress());
    vbUsdcOftAdapterMock = await (
      await ethers.getContractFactory('StargateV2PoolMock')
    ).deploy(0, 0, await vbUsdc.getAddress());

    const kumaStargateForwarderComposing = await (
      await (
        await ethers.getContractFactory(
          'KatanaPerpsStargateForwarderComposing_v1',
        )
      ).deploy()
    ).waitForDeployment();
    forwarderComposingAddress =
      await kumaStargateForwarderComposing.getAddress();
    forwarder = await (
      await ethers.getContractFactory('KatanaPerpsStargateForwarder_v1', {
        libraries: {
          KatanaPerpsStargateForwarderComposing_v1: forwarderComposingAddress,
        },
      })
    ).deploy(
      ethereumEndpointId,
      await stargatePoolMock.getAddress(),
      katanaComposeGasLimit,
      katanaEndpointId,
      await stargatePoolMock.getAddress(),
      decimalToPips('0.99900000'),
      decimalToPips('0.80000000'),
      await stargatePoolMock.getAddress(),
      await usdc.getAddress(),
      await vbUsdc.getAddress(),
      await vbUsdcOftAdapterMock.getAddress(),
    );

    const wallets = await ethers.getSigners();
    ownerWallet = wallets[0];
    traderWallet = wallets[1];
  });

  describe('deploy', function () {
    it('reverts when exchangeLayerZeroAdapter_ is zero', async () => {
      const ForwarderFactory = await ethers.getContractFactory(
        'KatanaPerpsStargateForwarder_v1',
        {
          libraries: {
            KatanaPerpsStargateForwarderComposing_v1: forwarderComposingAddress,
          },
        },
      );

      await expect(
        ForwarderFactory.deploy(
          ethereumEndpointId,
          ethers.ZeroAddress,
          katanaComposeGasLimit,
          katanaEndpointId,
          await stargatePoolMock.getAddress(),
          decimalToPips('0.99900000'),
          decimalToPips('0.80000000'),
          await stargatePoolMock.getAddress(),
          await usdc.getAddress(),
          await vbUsdc.getAddress(),
          await stargatePoolMock.getAddress(),
        ),
      ).to.be.revertedWith(/invalid bridge adapter address/i);
    });

    it('reverts when lzEndpoint_ is not a valid contract', async () => {
      const ForwarderFactory = await ethers.getContractFactory(
        'KatanaPerpsStargateForwarder_v1',
        {
          libraries: {
            KatanaPerpsStargateForwarderComposing_v1: forwarderComposingAddress,
          },
        },
      );

      await expect(
        ForwarderFactory.deploy(
          ethereumEndpointId,
          await stargatePoolMock.getAddress(),
          katanaComposeGasLimit,
          katanaEndpointId,
          ethers.ZeroAddress,
          decimalToPips('0.99900000'),
          decimalToPips('0.80000000'),
          await stargatePoolMock.getAddress(),
          await usdc.getAddress(),
          await vbUsdc.getAddress(),
          await stargatePoolMock.getAddress(),
        ),
      ).to.be.revertedWith(/invalid lz endpoint address/i);
    });

    it('reverts when vbUSDCOFTAdapter_ is not a valid contract', async () => {
      const ForwarderFactory = await ethers.getContractFactory(
        'KatanaPerpsStargateForwarder_v1',
        {
          libraries: {
            KatanaPerpsStargateForwarderComposing_v1: forwarderComposingAddress,
          },
        },
      );

      await expect(
        ForwarderFactory.deploy(
          ethereumEndpointId,
          await stargatePoolMock.getAddress(),
          katanaComposeGasLimit,
          katanaEndpointId,
          await stargatePoolMock.getAddress(),
          decimalToPips('0.99900000'),
          decimalToPips('0.80000000'),
          await stargatePoolMock.getAddress(),
          await usdc.getAddress(),
          await vbUsdc.getAddress(),
          ownerWallet.address,
        ),
      ).to.be.revertedWith(/invalid oft address/i);
    });

    it('reverts when stargate_ is not a valid contract', async () => {
      const ForwarderFactory = await ethers.getContractFactory(
        'KatanaPerpsStargateForwarder_v1',
        {
          libraries: {
            KatanaPerpsStargateForwarderComposing_v1: forwarderComposingAddress,
          },
        },
      );

      await expect(
        ForwarderFactory.deploy(
          ethereumEndpointId,
          await stargatePoolMock.getAddress(),
          katanaComposeGasLimit,
          katanaEndpointId,
          await stargatePoolMock.getAddress(),
          decimalToPips('0.99900000'),
          decimalToPips('0.80000000'),
          ownerWallet.address,
          await usdc.getAddress(),
          await vbUsdc.getAddress(),
          await stargatePoolMock.getAddress(),
        ),
      ).to.be.revertedWith(/invalid stargate address/i);
    });

    it('reverts when usdc_ is not a valid contract', async () => {
      const ForwarderFactory = await ethers.getContractFactory(
        'KatanaPerpsStargateForwarder_v1',
        {
          libraries: {
            KatanaPerpsStargateForwarderComposing_v1: forwarderComposingAddress,
          },
        },
      );

      await expect(
        ForwarderFactory.deploy(
          ethereumEndpointId,
          await stargatePoolMock.getAddress(),
          katanaComposeGasLimit,
          katanaEndpointId,
          await stargatePoolMock.getAddress(),
          decimalToPips('0.99900000'),
          decimalToPips('0.80000000'),
          await stargatePoolMock.getAddress(),
          ownerWallet.address,
          await vbUsdc.getAddress(),
          await stargatePoolMock.getAddress(),
        ),
      ).to.be.revertedWith(/invalid USDC token address/i);
    });
  });

  describe('lzCompose ', function () {
    it('refunds owner and emits ForwardFailed when composeMessageType is invalid', async () => {
      const quantityInDecimal = '2.00000000';
      const quantityInAssetUnits = ethers.parseUnits(
        quantityInDecimal,
        quoteAssetDecimals,
      );

      // Encode an invalid composeMessageType = 3 (enum has only 0,1)
      const invalidPayload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint8', 'tuple(address,bytes)'],
        [
          3,
          [
            await stargatePoolMock.getAddress(), // Destination address (unused)
            '0x',
          ],
        ],
      );

      const message = buildComposeMessage(
        quantityInAssetUnits,
        traderWallet.address,
        invalidPayload,
      );

      await usdc.transfer(await forwarder.getAddress(), quantityInAssetUnits);

      const ownerAddress = await forwarder.owner();
      const ownerBalanceBefore = await usdc.balanceOf(ownerAddress);
      const startBlock = await ethers.provider.getBlockNumber();

      await stargatePoolMock.lzCompose(
        await forwarder.getAddress(),
        await stargatePoolMock.getAddress(), // from = stargate (decode will fail before this is checked)
        ethers.randomBytes(32),
        message,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      const ownerBalanceAfter = await usdc.balanceOf(ownerAddress);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(
        quantityInAssetUnits,
      );

      const events = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(events).to.have.lengthOf(1);
      const evt = events[0];
      expect(evt.args.destinationWallet).to.equal(ethers.ZeroAddress);
      expect(evt.args.quantity).to.equal(quantityInAssetUnits);
      expect(evt.args.payload).to.equal(message);
      // compose reverts without a reason; errorData should be empty bytes
      expect(evt.args.errorData).to.equal('0x');
    });

    it('reverts when called directly by non-endpoint', async () => {
      const quantityInAssetUnits = ethers.parseUnits(
        '1.00000000',
        quoteAssetDecimals,
      );
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint8', 'tuple(address,bytes)'],
        [0, [traderWallet.address, '0x']],
      );
      const message = buildComposeMessage(
        quantityInAssetUnits,
        traderWallet.address,
        payload,
      );

      await usdc.transfer(await forwarder.getAddress(), quantityInAssetUnits);

      await expect(
        forwarder.lzCompose(
          await stargatePoolMock.getAddress(),
          ethers.randomBytes(32),
          message,
          await stargatePoolMock.getAddress(),
          '0x',
        ),
      ).to.be.revertedWith(/caller must be lz endpoint/i);
    });
  });

  describe('lzCompose with deposit payload', function () {
    let composeMessage: string;

    const depositQuantityInDecimal = '5.00000000';
    const depositQuantityInAssetUnits = ethers.parseUnits(
      depositQuantityInDecimal,
      quoteAssetDecimals,
    );

    beforeEach(async () => {
      composeMessage = buildComposeMessage(
        depositQuantityInAssetUnits,
        await stargatePoolMock.getAddress(),
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint8', 'tuple(address,bytes)'],
          [
            0, //  ComposeMessageType.DepositToKatana
            [
              traderWallet.address, // destinationWallet
              '0x', // exchangeLayerZeroAdapterPayload
            ],
          ],
        ),
      );
    });
  });

  describe('setMinimumDepositNativeDropQuantityMultiplier', function () {
    it('reverts when caller is not the Owner wallet', async () => {
      await expect(
        forwarder
          .connect(traderWallet)
          .setMinimumDepositNativeDropQuantityMultiplier(1),
      ).to.be.revertedWithCustomError(forwarder, 'OwnableUnauthorizedAccount');
    });

    it('reverts when newMinimumDepositNativeDropQuantityMultiplier is too small', async () => {
      await expect(
        forwarder.setMinimumDepositNativeDropQuantityMultiplier(0),
      ).to.be.revertedWith(/value out of bounds/i);
    });

    it('reverts when newMinimumDepositNativeDropQuantityMultiplier is too large', async () => {
      // MAX_MULTIPLIER is 99,999,999; use 100,000,000
      await expect(
        forwarder.setMinimumDepositNativeDropQuantityMultiplier(100000000),
      ).to.be.revertedWith(/value out of bounds/i);
    });
  });

  describe('setMinimumForwardQuantityMultiplier', function () {
    it('reverts when caller is not the Owner wallet', async () => {
      await expect(
        forwarder.connect(traderWallet).setMinimumForwardQuantityMultiplier(1),
      ).to.be.revertedWithCustomError(forwarder, 'OwnableUnauthorizedAccount');
    });

    it('reverts when newMinimumForwardQuantityMultiplier is too small', async () => {
      await expect(
        forwarder.setMinimumForwardQuantityMultiplier(0),
      ).to.be.revertedWith(/value out of bounds/i);
    });

    it('reverts when newMinimumForwardQuantityMultiplier is too large', async () => {
      await expect(
        forwarder.setMinimumForwardQuantityMultiplier(100000000),
      ).to.be.revertedWith(/value out of bounds/i);
    });
  });

  describe('withdrawNativeAsset', function () {
    it('reverts when caller is not the Owner wallet', async () => {
      await expect(
        forwarder
          .connect(traderWallet)
          .withdrawNativeAsset(traderWallet.address, 1),
      ).to.be.revertedWithCustomError(forwarder, 'OwnableUnauthorizedAccount');
    });

    it('succeeds when the contract has the quantity on hand', async () => {
      const amount = ethers.parseEther('0.00005');
      await ownerWallet.sendTransaction({
        to: await forwarder.getAddress(),
        value: amount,
      });

      const before = await ethers.provider.getBalance(traderWallet.address);
      await forwarder.withdrawNativeAsset(traderWallet.address, amount);
      const after = await ethers.provider.getBalance(traderWallet.address);
      expect(after - before).to.equal(amount);
    });
  });

  describe('loadEstimatedForwardedQuantityInAssetUnits', function () {
    it('returns well-formed result for katanaEndpointId', async () => {
      const quantityPips = decimalToPips('100.00000000');

      const [estimated, minimum, poolDecimals] =
        await forwarder.loadEstimatedForwardedQuantityInAssetUnits(
          3, // katanaEndpointId
          quantityPips,
        );

      expect(poolDecimals).to.equal(quoteAssetDecimals);
      expect(estimated).to.be.greaterThan(0);
      expect(minimum).to.be.greaterThan(0);
      expect(minimum).to.be.lessThanOrEqual(estimated);
    });

    it('returns well-formed result for stargate endpoint', async () => {
      const quantityPips = decimalToPips('50.00000000');

      const [estimated, minimum, poolDecimals] =
        await forwarder.loadEstimatedForwardedQuantityInAssetUnits(
          1, // Different endpoint (not katanaEndpointId, so uses stargate)
          quantityPips,
        );

      expect(poolDecimals).to.equal(quoteAssetDecimals);
      expect(estimated).to.be.greaterThan(0);
      expect(minimum).to.be.greaterThan(0);
      expect(minimum).to.be.lessThanOrEqual(estimated);
    });
  });

  describe('loadDepositGasFeeInAssetUnits', function () {
    it('returns well-formed result', async () => {
      const gasFee = await forwarder.loadDepositGasFeeInAssetUnits();

      expect(gasFee).to.be.greaterThanOrEqual(0);
    });
  });

  describe('loadWithdrawalGasFeesInAssetUnits', function () {
    it('returns well-formed result for single endpoint', async () => {
      const destinationEndpointIds = [1];
      const gasFees = await forwarder.loadWithdrawalGasFeesInAssetUnits(
        destinationEndpointIds,
      );

      expect(gasFees).to.have.lengthOf(1);
      expect(gasFees[0]).to.be.greaterThanOrEqual(0);
    });

    it('returns well-formed result for multiple endpoints', async () => {
      const destinationEndpointIds = [1, 2, 3];
      const gasFees = await forwarder.loadWithdrawalGasFeesInAssetUnits(
        destinationEndpointIds,
      );

      expect(gasFees).to.have.lengthOf(3);
      gasFees.forEach((fee) => {
        expect(fee).to.be.greaterThanOrEqual(0);
      });
    });
  });
});
