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

describe('KatanaPerpsStargateForwarder_v1', function () {
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
    it('reverts when ethereumEndpointId_ is zero', async () => {
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
          0, // Invalid: ethereumEndpointId = 0
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
        ),
      ).to.be.revertedWith(/invalid ethereum lz endpoint id/i);
    });

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

    it('reverts when katanaEndpointId_ is zero', async () => {
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
          0, // Invalid: katanaEndpointId = 0
          await stargatePoolMock.getAddress(),
          decimalToPips('0.99900000'),
          decimalToPips('0.80000000'),
          await stargatePoolMock.getAddress(),
          await usdc.getAddress(),
          await vbUsdc.getAddress(),
          await vbUsdcOftAdapterMock.getAddress(),
        ),
      ).to.be.revertedWith(/invalid katana lz endpoint id/i);
    });

    it('reverts when katanaEndpointId_ equals ethereumEndpointId_', async () => {
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
          ethereumEndpointId, // Invalid: same as ethereumEndpointId_
          await stargatePoolMock.getAddress(),
          decimalToPips('0.99900000'),
          decimalToPips('0.80000000'),
          await stargatePoolMock.getAddress(),
          await usdc.getAddress(),
          await vbUsdc.getAddress(),
          await vbUsdcOftAdapterMock.getAddress(),
        ),
      ).to.be.revertedWith(/invalid katana lz endpoint id/i);
    });

    it('reverts when stargate_.token() does not match usdc_', async () => {
      const ForwarderFactory = await ethers.getContractFactory(
        'KatanaPerpsStargateForwarder_v1',
        {
          libraries: {
            KatanaPerpsStargateForwarderComposing_v1: forwarderComposingAddress,
          },
        },
      );

      // Create a new USDC that doesn't match the stargate pool's token
      const mismatchedUsdc = await (
        await ethers.getContractFactory('USDC')
      ).deploy();

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
          await mismatchedUsdc.getAddress(), // Doesn't match stargate_.token()
          await vbUsdc.getAddress(),
          await vbUsdcOftAdapterMock.getAddress(),
        ),
      ).to.be.revertedWith(/usdc token address does not match stargate/i);
    });

    it('reverts when vbUSDC_ is not a valid contract address', async () => {
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
          ownerWallet.address, // Invalid: not a contract
          await vbUsdcOftAdapterMock.getAddress(),
        ),
      ).to.be.revertedWith(/invalid vbusdc token address/i);
    });

    it('reverts when vbUSDC_.asset() does not match usdc_', async () => {
      const ForwarderFactory = await ethers.getContractFactory(
        'KatanaPerpsStargateForwarder_v1',
        {
          libraries: {
            KatanaPerpsStargateForwarderComposing_v1: forwarderComposingAddress,
          },
        },
      );

      // Create a vbUSDC with a different underlying asset
      const differentUsdc = await (
        await ethers.getContractFactory('USDC')
      ).deploy();
      const mismatchedVbUsdc = await (
        await ethers.getContractFactory('VbUSDC')
      ).deploy(await differentUsdc.getAddress());

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
          await mismatchedVbUsdc.getAddress(), // vbUSDC_.asset() != usdc_
          await vbUsdcOftAdapterMock.getAddress(),
        ),
      ).to.be.revertedWith(/vbusdc asset address does not match usdc/i);
    });

    it('reverts when vbUSDCOFTAdapter_.token() does not match vbUSDC_', async () => {
      const ForwarderFactory = await ethers.getContractFactory(
        'KatanaPerpsStargateForwarder_v1',
        {
          libraries: {
            KatanaPerpsStargateForwarderComposing_v1: forwarderComposingAddress,
          },
        },
      );

      // Create a vbUSDC OFT adapter that points to a different token
      const differentVbUsdc = await (
        await ethers.getContractFactory('VbUSDC')
      ).deploy(await usdc.getAddress());
      const mismatchedOftAdapter = await (
        await ethers.getContractFactory('StargateV2PoolMock')
      ).deploy(0, 0, await differentVbUsdc.getAddress());

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
          await mismatchedOftAdapter.getAddress(), // token() != vbUSDC_
        ),
      ).to.be.revertedWith(/vbusdc token address does not match oft adapter/i);
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

    it('should succeed with valid arguments and forward deposit to Katana', async () => {
      // Transfer USDC to the forwarder (simulating bridged tokens arriving)
      await usdc.transfer(
        await forwarder.getAddress(),
        depositQuantityInAssetUnits,
      );

      const forwarderAddress = await forwarder.getAddress();
      const vbUsdcAddress = await vbUsdc.getAddress();
      const vbUsdcOftAdapterAddress = await vbUsdcOftAdapterMock.getAddress();

      // Record balances before
      const vbUsdcVaultUsdcBefore = await usdc.balanceOf(vbUsdcAddress);
      const oftAdapterVbUsdcBefore = await vbUsdc.balanceOf(
        vbUsdcOftAdapterAddress,
      );

      const startBlock = await ethers.provider.getBlockNumber();

      // Call lzCompose via the stargate mock (simulating LZ endpoint callback)
      await stargatePoolMock.lzCompose(
        await forwarder.getAddress(),
        await stargatePoolMock.getAddress(), // from = stargate
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert no ForwardFailed event was emitted
      const forwardFailedEvents = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(forwardFailedEvents).to.have.lengthOf(0);

      // Assert forwarder USDC balance is now 0 (deposited to vault)
      const forwarderUsdcAfter = await usdc.balanceOf(forwarderAddress);
      expect(forwarderUsdcAfter).to.equal(0);

      // Assert vbUSDC vault received the USDC
      const vbUsdcVaultUsdcAfter = await usdc.balanceOf(vbUsdcAddress);
      expect(vbUsdcVaultUsdcAfter - vbUsdcVaultUsdcBefore).to.equal(
        depositQuantityInAssetUnits,
      );

      // Assert forwarder vbUSDC balance is 0 (sent via OFT adapter)
      const forwarderVbUsdcAfter = await vbUsdc.balanceOf(forwarderAddress);
      expect(forwarderVbUsdcAfter).to.equal(0);

      // Assert OFT adapter received the vbUSDC (via send call)
      const oftAdapterVbUsdcAfter = await vbUsdc.balanceOf(
        vbUsdcOftAdapterAddress,
      );
      // vbUSDC shares minted should equal USDC deposited (1:1 initially)
      expect(oftAdapterVbUsdcAfter - oftAdapterVbUsdcBefore).to.equal(
        depositQuantityInAssetUnits,
      );
    });

    it('should emit ForwardFailed and transfer USDC to owner when from is not the expected address', async () => {
      // Transfer USDC to the forwarder (simulating bridged tokens arriving)
      await usdc.transfer(
        await forwarder.getAddress(),
        depositQuantityInAssetUnits,
      );

      const otherStargatePoolMock = await (
        await ethers.getContractFactory('StargateV2PoolMock')
      ).deploy(0, 0, await usdc.getAddress());

      const ownerAddress = await forwarder.owner();
      const ownerUsdcBefore = await usdc.balanceOf(ownerAddress);
      const startBlock = await ethers.provider.getBlockNumber();

      // Call lzCompose with wrong from address (not stargate)
      await stargatePoolMock.lzCompose(
        await forwarder.getAddress(),
        await otherStargatePoolMock.getAddress(), // Wrong: should be stargatePoolMock address
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert ForwardFailed event was emitted
      const forwardFailedEvents = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(forwardFailedEvents).to.have.lengthOf(1);
      expect(forwardFailedEvents[0].args.destinationWallet).to.equal(
        ethers.ZeroAddress,
      );
      expect(forwardFailedEvents[0].args.quantity).to.equal(
        depositQuantityInAssetUnits,
      );
      // Verify errorData encodes the expected error string
      expect(
        Buffer.from(
          forwardFailedEvents[0].args.errorData.substring(2),
          'hex',
        ).toString('utf8'),
      ).to.match(/oapp must be stargate/i);

      // Assert USDC was transferred to owner as failsafe
      const ownerUsdcAfter = await usdc.balanceOf(ownerAddress);
      expect(ownerUsdcAfter - ownerUsdcBefore).to.equal(
        depositQuantityInAssetUnits,
      );
    });

    it('should emit ForwardFailed and transfer vbUSDC to destinationWallet when insufficient native drop', async () => {
      // Set a non-zero nativeFee on vbUsdcOftAdapterMock to trigger insufficient native drop
      const nativeFee = ethers.parseEther('0.1');
      await vbUsdcOftAdapterMock.setFees(nativeFee, 0);

      // Transfer USDC to the forwarder (simulating bridged tokens arriving)
      await usdc.transfer(
        await forwarder.getAddress(),
        depositQuantityInAssetUnits,
      );

      const traderVbUsdcBefore = await vbUsdc.balanceOf(traderWallet.address);
      const startBlock = await ethers.provider.getBlockNumber();

      // Call lzCompose without providing native value (insufficient for the fee)
      await stargatePoolMock.lzCompose(
        await forwarder.getAddress(),
        await stargatePoolMock.getAddress(), // from = stargate
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert ForwardFailed event was emitted
      const forwardFailedEvents = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(forwardFailedEvents).to.have.lengthOf(1);
      expect(forwardFailedEvents[0].args.destinationWallet).to.equal(
        traderWallet.address,
      );
      // vbUSDC amount should equal deposit amount (1:1 initially)
      expect(forwardFailedEvents[0].args.quantity).to.equal(
        depositQuantityInAssetUnits,
      );
      // Verify errorData encodes the expected error string
      expect(
        Buffer.from(
          forwardFailedEvents[0].args.errorData.substring(2),
          'hex',
        ).toString('utf8'),
      ).to.match(/insufficient native drop/i);

      // Assert vbUSDC was transferred to destinationWallet (traderWallet)
      const traderVbUsdcAfter = await vbUsdc.balanceOf(traderWallet.address);
      expect(traderVbUsdcAfter - traderVbUsdcBefore).to.equal(
        depositQuantityInAssetUnits,
      );
    });

    it('should emit ForwardFailed and transfer vbUSDC to destinationWallet when OFT send fails', async () => {
      // Disable send on vbUsdcOftAdapterMock to trigger the send failure fallback
      await vbUsdcOftAdapterMock.setSendDisabled(true);

      // Transfer USDC to the forwarder (simulating bridged tokens arriving)
      await usdc.transfer(
        await forwarder.getAddress(),
        depositQuantityInAssetUnits,
      );

      const traderVbUsdcBefore = await vbUsdc.balanceOf(traderWallet.address);
      const startBlock = await ethers.provider.getBlockNumber();

      // Call lzCompose - send will fail and trigger fallback
      await stargatePoolMock.lzCompose(
        await forwarder.getAddress(),
        await stargatePoolMock.getAddress(), // from = stargate
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert ForwardFailed event was emitted
      const forwardFailedEvents = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(forwardFailedEvents).to.have.lengthOf(1);
      expect(forwardFailedEvents[0].args.destinationWallet).to.equal(
        traderWallet.address,
      );
      // vbUSDC amount should equal deposit amount (1:1 initially)
      expect(forwardFailedEvents[0].args.quantity).to.equal(
        depositQuantityInAssetUnits,
      );
      // Verify errorData encodes the expected error string "Send disabled"
      expect(
        Buffer.from(
          forwardFailedEvents[0].args.errorData.substring(2),
          'hex',
        ).toString('utf8'),
      ).to.match(/send disabled/i);

      // Assert vbUSDC was transferred to destinationWallet (traderWallet)
      const traderVbUsdcAfter = await vbUsdc.balanceOf(traderWallet.address);
      expect(traderVbUsdcAfter - traderVbUsdcBefore).to.equal(
        depositQuantityInAssetUnits,
      );
    });
  });

  describe('lzCompose with withdrawal payload', function () {
    const withdrawQuantityInDecimal = '5.00000000';
    const withdrawQuantityInAssetUnits = ethers.parseUnits(
      withdrawQuantityInDecimal,
      quoteAssetDecimals,
    );

    it('should succeed with valid arguments and forward withdrawal to Ethereum', async () => {
      // Fund the vbUSDC vault with USDC so redeem works
      await usdc.transfer(
        await vbUsdc.getAddress(),
        withdrawQuantityInAssetUnits,
      );

      const forwarderAddress = await forwarder.getAddress();
      const exchangeLayerZeroAdapterAddress =
        await stargatePoolMock.getAddress();

      // Build withdrawal compose message with Ethereum as destination
      const composeMessage = buildComposeMessage(
        withdrawQuantityInAssetUnits,
        exchangeLayerZeroAdapterAddress, // composeFrom = exchangeLayerZeroAdapter
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint8', 'tuple(uint32,address)'],
          [
            1, // ComposeMessageType.WithdrawFromKatana
            [
              ethereumEndpointId, // destinationEndpointId
              traderWallet.address, // destinationWallet
            ],
          ],
        ),
      );

      // Mint vbUSDC to the forwarder (simulating tokens arriving from Katana)
      await usdc.approve(
        await vbUsdc.getAddress(),
        withdrawQuantityInAssetUnits,
      );
      await vbUsdc.deposit(
        withdrawQuantityInAssetUnits,
        await forwarder.getAddress(),
      );

      // Record balances before
      const traderUsdcBefore = await usdc.balanceOf(traderWallet.address);

      const startBlock = await ethers.provider.getBlockNumber();

      // Call lzCompose via stargatePoolMock (lzEndpoint) with from = vbUSDCOFTAdapter
      await stargatePoolMock.lzCompose(
        forwarderAddress,
        await vbUsdcOftAdapterMock.getAddress(), // from = vbUSDCOFTAdapter
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert no ForwardFailed event was emitted
      const forwardFailedEvents = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(forwardFailedEvents).to.have.lengthOf(0);

      // Assert forwarder vbUSDC balance is 0 (redeemed for USDC)
      const forwarderVbUsdcAfter = await vbUsdc.balanceOf(forwarderAddress);
      expect(forwarderVbUsdcAfter).to.equal(0);

      // Assert trader received USDC directly (Ethereum endpoint = direct transfer)
      const traderUsdcAfter = await usdc.balanceOf(traderWallet.address);
      expect(traderUsdcAfter - traderUsdcBefore).to.equal(
        withdrawQuantityInAssetUnits,
      );
    });

    it('should succeed with valid arguments and forward withdrawal via Stargate to non-Ethereum chain', async () => {
      const nonEthereumEndpointId = 12345; // Different from ethereumEndpointId

      // Fund the vbUSDC vault with USDC so redeem works
      await usdc.transfer(
        await vbUsdc.getAddress(),
        withdrawQuantityInAssetUnits,
      );

      // Mint vbUSDC to the forwarder (simulating tokens arriving from Katana)
      await usdc.approve(
        await vbUsdc.getAddress(),
        withdrawQuantityInAssetUnits,
      );
      await vbUsdc.deposit(
        withdrawQuantityInAssetUnits,
        await forwarder.getAddress(),
      );

      const forwarderAddress = await forwarder.getAddress();
      const exchangeLayerZeroAdapterAddress =
        await stargatePoolMock.getAddress();
      const stargateAddress = await stargatePoolMock.getAddress();

      // Build withdrawal compose message with non-Ethereum destination
      const composeMessage = buildComposeMessage(
        withdrawQuantityInAssetUnits,
        exchangeLayerZeroAdapterAddress, // composeFrom = exchangeLayerZeroAdapter
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint8', 'tuple(uint32,address)'],
          [
            1, // ComposeMessageType.WithdrawFromKatana
            [
              nonEthereumEndpointId, // destinationEndpointId (not Ethereum)
              traderWallet.address, // destinationWallet
            ],
          ],
        ),
      );

      // Record balances before
      const stargateUsdcBefore = await usdc.balanceOf(stargateAddress);

      const startBlock = await ethers.provider.getBlockNumber();

      // Call lzCompose via stargatePoolMock (lzEndpoint) with from = vbUSDCOFTAdapter
      await stargatePoolMock.lzCompose(
        await forwarder.getAddress(),
        await vbUsdcOftAdapterMock.getAddress(), // from = vbUSDCOFTAdapter
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert no ForwardFailed event was emitted
      const forwardFailedEvents = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(forwardFailedEvents).to.have.lengthOf(0);

      // Assert forwarder vbUSDC balance is 0 (redeemed for USDC)
      const forwarderVbUsdcAfter = await vbUsdc.balanceOf(forwarderAddress);
      expect(forwarderVbUsdcAfter).to.equal(0);

      // Assert Stargate received USDC (via send call for bridging)
      const stargateUsdcAfter = await usdc.balanceOf(stargateAddress);
      expect(stargateUsdcAfter - stargateUsdcBefore).to.equal(
        withdrawQuantityInAssetUnits,
      );
    });

    it('should emit ForwardFailed and transfer vbUSDC to owner when from is not the expected address', async () => {
      const forwarderAddress = await forwarder.getAddress();
      const exchangeLayerZeroAdapterAddress =
        await stargatePoolMock.getAddress();

      // Build withdrawal compose message with srcEid = katanaEndpointId
      const withdrawalPayload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint8', 'tuple(uint32,address)'],
        [
          1, // ComposeMessageType.WithdrawFromKatana
          [
            ethereumEndpointId, // destinationEndpointId
            traderWallet.address, // destinationWallet
          ],
        ],
      );
      // Build compose message with srcEid = katanaEndpointId (for withdrawal from Katana)
      const composeMessage = ethers.solidityPacked(
        ['uint64', 'uint32', 'uint256', 'bytes'],
        [
          0, // Nonce
          katanaEndpointId, // Source EID = katanaEndpointId for withdrawals
          withdrawQuantityInAssetUnits, // Amount
          ethers.solidityPacked(
            ['bytes', 'bytes'],
            [
              // Compose from
              ethers.AbiCoder.defaultAbiCoder().encode(
                ['address'],
                [exchangeLayerZeroAdapterAddress],
              ),
              // Compose message
              withdrawalPayload,
            ],
          ),
        ],
      );

      // Mint vbUSDC to the forwarder (simulating tokens arriving from Katana)
      await usdc.approve(
        await vbUsdc.getAddress(),
        withdrawQuantityInAssetUnits,
      );
      await vbUsdc.deposit(withdrawQuantityInAssetUnits, forwarderAddress);

      const otherStargatePoolMock = await (
        await ethers.getContractFactory('StargateV2PoolMock')
      ).deploy(0, 0, await vbUsdc.getAddress());

      const ownerAddress = await forwarder.owner();
      const ownerVbUsdcBefore = await vbUsdc.balanceOf(ownerAddress);
      const startBlock = await ethers.provider.getBlockNumber();

      // Call lzCompose with wrong from address (not vbUSDCOFTAdapter)
      await stargatePoolMock.lzCompose(
        forwarderAddress,
        await otherStargatePoolMock.getAddress(), // Wrong: should be vbUsdcOftAdapterMock address
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert ForwardFailed event was emitted
      const forwardFailedEvents = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(forwardFailedEvents).to.have.lengthOf(1);
      expect(forwardFailedEvents[0].args.destinationWallet).to.equal(
        ethers.ZeroAddress,
      );
      expect(forwardFailedEvents[0].args.quantity).to.equal(
        withdrawQuantityInAssetUnits,
      );
      // Verify errorData encodes the expected error string
      expect(
        Buffer.from(
          forwardFailedEvents[0].args.errorData.substring(2),
          'hex',
        ).toString('utf8'),
      ).to.match(/oapp must be vbusdc oftadapter/i);

      // Assert vbUSDC was transferred to owner as failsafe
      const ownerVbUsdcAfter = await vbUsdc.balanceOf(ownerAddress);
      expect(ownerVbUsdcAfter - ownerVbUsdcBefore).to.equal(
        withdrawQuantityInAssetUnits,
      );
    });

    it('should emit ForwardFailed and transfer vbUSDC to destinationWallet when composeFrom is invalid', async () => {
      const forwarderAddress = await forwarder.getAddress();

      // Build withdrawal compose message with invalid composeFrom (not exchangeLayerZeroAdapter)
      const withdrawalPayload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint8', 'tuple(uint32,address)'],
        [
          1, // ComposeMessageType.WithdrawFromKatana
          [
            ethereumEndpointId, // destinationEndpointId
            traderWallet.address, // destinationWallet
          ],
        ],
      );
      // Build compose message with wrong composeFrom (traderWallet instead of exchangeLayerZeroAdapter)
      const composeMessage = ethers.solidityPacked(
        ['uint64', 'uint32', 'uint256', 'bytes'],
        [
          0, // Nonce
          katanaEndpointId, // Source EID = katanaEndpointId for withdrawals
          withdrawQuantityInAssetUnits, // Amount
          ethers.solidityPacked(
            ['bytes', 'bytes'],
            [
              // Compose from - wrong address (not exchangeLayerZeroAdapter)
              ethers.AbiCoder.defaultAbiCoder().encode(
                ['address'],
                [traderWallet.address],
              ),
              // Compose message
              withdrawalPayload,
            ],
          ),
        ],
      );

      // Mint vbUSDC to the forwarder (simulating tokens arriving from Katana)
      await usdc.approve(
        await vbUsdc.getAddress(),
        withdrawQuantityInAssetUnits,
      );
      await vbUsdc.deposit(withdrawQuantityInAssetUnits, forwarderAddress);

      const traderVbUsdcBefore = await vbUsdc.balanceOf(traderWallet.address);
      const startBlock = await ethers.provider.getBlockNumber();

      // Call lzCompose with correct from (vbUSDCOFTAdapter) but wrong composeFrom in message
      await stargatePoolMock.lzCompose(
        forwarderAddress,
        await vbUsdcOftAdapterMock.getAddress(), // from = vbUSDCOFTAdapter (correct)
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert ForwardFailed event was emitted
      const forwardFailedEvents = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(forwardFailedEvents).to.have.lengthOf(1);
      expect(forwardFailedEvents[0].args.destinationWallet).to.equal(
        traderWallet.address,
      );
      expect(forwardFailedEvents[0].args.quantity).to.equal(
        withdrawQuantityInAssetUnits,
      );
      // Verify errorData encodes the expected error string
      expect(
        Buffer.from(
          forwardFailedEvents[0].args.errorData.substring(2),
          'hex',
        ).toString('utf8'),
      ).to.match(/invalid compose from/i);

      // Assert vbUSDC was transferred to destinationWallet (traderWallet) as failsafe
      const traderVbUsdcAfter = await vbUsdc.balanceOf(traderWallet.address);
      expect(traderVbUsdcAfter - traderVbUsdcBefore).to.equal(
        withdrawQuantityInAssetUnits,
      );
    });

    it('should emit ForwardFailed and transfer vbUSDC to destinationWallet when slippage exceeded', async () => {
      // Set a high redeem fee to trigger slippage check failure
      // minimumForwardQuantityMultiplier is 80%, so if previewRedeem returns < 80% of input, it fails
      // For 5 USDC input, minUsdcAmount = 5 * 0.80 = 4 USDC
      // Setting redeemFee to 1.5 USDC makes previewRedeem return 3.5 USDC < 4 USDC
      const highRedeemFee = ethers.parseUnits('1.5', quoteAssetDecimals);
      await vbUsdc.setRedeemFee(highRedeemFee);

      // Fund the vbUSDC vault with USDC so redeem works
      await usdc.transfer(
        await vbUsdc.getAddress(),
        withdrawQuantityInAssetUnits,
      );

      const forwarderAddress = await forwarder.getAddress();
      const exchangeLayerZeroAdapterAddress =
        await stargatePoolMock.getAddress();

      // Build withdrawal compose message
      const composeMessage = buildComposeMessage(
        withdrawQuantityInAssetUnits,
        exchangeLayerZeroAdapterAddress, // composeFrom = exchangeLayerZeroAdapter
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint8', 'tuple(uint32,address)'],
          [
            1, // ComposeMessageType.WithdrawFromKatana
            [
              ethereumEndpointId, // destinationEndpointId
              traderWallet.address, // destinationWallet
            ],
          ],
        ),
      );

      // Mint vbUSDC to the forwarder (simulating tokens arriving from Katana)
      await usdc.approve(
        await vbUsdc.getAddress(),
        withdrawQuantityInAssetUnits,
      );
      await vbUsdc.deposit(withdrawQuantityInAssetUnits, forwarderAddress);

      const traderVbUsdcBefore = await vbUsdc.balanceOf(traderWallet.address);
      const startBlock = await ethers.provider.getBlockNumber();

      // Call lzCompose - slippage check will fail
      await stargatePoolMock.lzCompose(
        forwarderAddress,
        await vbUsdcOftAdapterMock.getAddress(), // from = vbUSDCOFTAdapter
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert ForwardFailed event was emitted
      const forwardFailedEvents = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(forwardFailedEvents).to.have.lengthOf(1);
      expect(forwardFailedEvents[0].args.destinationWallet).to.equal(
        traderWallet.address,
      );
      expect(forwardFailedEvents[0].args.quantity).to.equal(
        withdrawQuantityInAssetUnits,
      );
      // Verify errorData encodes the expected error string
      expect(
        Buffer.from(
          forwardFailedEvents[0].args.errorData.substring(2),
          'hex',
        ).toString('utf8'),
      ).to.match(/slippage exceeded/i);

      // Assert vbUSDC was transferred to destinationWallet (traderWallet) as failsafe
      const traderVbUsdcAfter = await vbUsdc.balanceOf(traderWallet.address);
      expect(traderVbUsdcAfter - traderVbUsdcBefore).to.equal(
        withdrawQuantityInAssetUnits,
      );
    });

    it('should emit ForwardFailed and transfer USDC to destinationWallet when Stargate send fails', async () => {
      const nonEthereumEndpointId = 12345; // Different from ethereumEndpointId to use Stargate path

      // Disable send on stargatePoolMock to trigger the send failure fallback
      await stargatePoolMock.setSendDisabled(true);

      // Fund the vbUSDC vault with USDC so redeem works
      await usdc.transfer(
        await vbUsdc.getAddress(),
        withdrawQuantityInAssetUnits,
      );

      const forwarderAddress = await forwarder.getAddress();
      const exchangeLayerZeroAdapterAddress =
        await stargatePoolMock.getAddress();

      // Build withdrawal compose message with non-Ethereum destination (to use Stargate path)
      const composeMessage = buildComposeMessage(
        withdrawQuantityInAssetUnits,
        exchangeLayerZeroAdapterAddress, // composeFrom = exchangeLayerZeroAdapter
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint8', 'tuple(uint32,address)'],
          [
            1, // ComposeMessageType.WithdrawFromKatana
            [
              nonEthereumEndpointId, // destinationEndpointId (not Ethereum, so uses Stargate)
              traderWallet.address, // destinationWallet
            ],
          ],
        ),
      );

      // Mint vbUSDC to the forwarder (simulating tokens arriving from Katana)
      await usdc.approve(
        await vbUsdc.getAddress(),
        withdrawQuantityInAssetUnits,
      );
      await vbUsdc.deposit(withdrawQuantityInAssetUnits, forwarderAddress);

      const traderUsdcBefore = await usdc.balanceOf(traderWallet.address);
      const startBlock = await ethers.provider.getBlockNumber();

      // Call lzCompose - Stargate send will fail and trigger fallback
      await stargatePoolMock.lzCompose(
        forwarderAddress,
        await vbUsdcOftAdapterMock.getAddress(), // from = vbUSDCOFTAdapter
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert ForwardFailed event was emitted
      const forwardFailedEvents = await forwarder.queryFilter(
        forwarder.filters.ForwardFailed(),
        startBlock + 1,
      );
      expect(forwardFailedEvents).to.have.lengthOf(1);
      expect(forwardFailedEvents[0].args.destinationWallet).to.equal(
        traderWallet.address,
      );
      // Quantity is the USDC amount after redeem (same as vbUSDC amount for 1:1 ratio)
      expect(forwardFailedEvents[0].args.quantity).to.equal(
        withdrawQuantityInAssetUnits,
      );
      // Verify errorData encodes the expected error string "Send disabled"
      expect(
        Buffer.from(
          forwardFailedEvents[0].args.errorData.substring(2),
          'hex',
        ).toString('utf8'),
      ).to.match(/send disabled/i);

      // Assert USDC was transferred to destinationWallet (traderWallet) as failsafe
      const traderUsdcAfter = await usdc.balanceOf(traderWallet.address);
      expect(traderUsdcAfter - traderUsdcBefore).to.equal(
        withdrawQuantityInAssetUnits,
      );
    });
  });

  describe('setKatanaComposeGasLimit', function () {
    it('reverts when caller is not the Owner wallet', async () => {
      await expect(
        forwarder.connect(traderWallet).setKatanaComposeGasLimit(500000),
      ).to.be.revertedWithCustomError(forwarder, 'OwnableUnauthorizedAccount');
    });

    it('reverts when newKatanaComposeGasLimit is 0', async () => {
      await expect(forwarder.setKatanaComposeGasLimit(0)).to.be.revertedWith(
        /value out of bounds/i,
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
          katanaEndpointId,
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
