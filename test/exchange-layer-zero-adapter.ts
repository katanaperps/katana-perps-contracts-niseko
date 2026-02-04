import { time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, network } from 'hardhat';
import { v1 as uuidv1 } from 'uuid';

import {
  decimalToAssetUnits,
  decimalToPips,
  fieldUpgradeDelayInS,
  getWithdrawArguments,
  getWithdrawalSignatureTypedData,
} from '../lib';

import {
  deployAndAssociateContracts,
  expect,
  quoteAssetDecimals,
  quoteAssetSymbol,
} from './helpers';

import type { Withdrawal } from '../lib';
import type {
  Exchange_v1,
  ExchangeLayerZeroAdapter_v1,
  ExchangeLayerZeroAdapter_v1__factory,
  Governance,
  StargateV2PoolMock,
  USDC,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// The actual values for the below are not important
const ethereumEndpointId = 9999999;
const ethereumComposeGasLimit = 1000000;

export function buildComposeMessage(
  amount: bigint,
  fromAddress: string,
  payload: string,
) {
  return ethers.solidityPacked(
    ['uint64', 'uint32', 'uint256', 'bytes'],
    [
      0, // Nonce
      1, // Source EID
      amount, // Amount
      ethers.solidityPacked(
        ['bytes', 'bytes'],
        [
          // Compose from
          ethers.AbiCoder.defaultAbiCoder().encode(['address'], [fromAddress]),
          // Compose message
          payload,
        ],
      ),
    ],
  );
}

describe('ExchangeLayerZeroAdapter_v1', function () {
  let dispatcherWallet: SignerWithAddress;
  let exchange: Exchange_v1;
  let feeWallet: SignerWithAddress;
  let ExchangeLayerZeroAdapterFactory: ExchangeLayerZeroAdapter_v1__factory;
  let governance: Governance;
  let ownerWallet: SignerWithAddress;
  let stargatePoolMock: StargateV2PoolMock;
  let traderWallet: SignerWithAddress;
  let usdc: USDC;

  const oftNativeFee = ethers.parseEther('0.0001');
  const oftTokenFee = decimalToAssetUnits('0.0001', quoteAssetDecimals);

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    const wallets = await ethers.getSigners();

    ownerWallet = wallets[0];
    dispatcherWallet = wallets[1];
    feeWallet = wallets[3];
    traderWallet = wallets[6];
    const results = await deployAndAssociateContracts(
      ownerWallet,
      dispatcherWallet,
      wallets[2],
      feeWallet,
      wallets[4],
      wallets[5],
    );
    exchange = results.exchange;
    governance = results.governance;
    usdc = results.usdc;

    await usdc.transfer(
      traderWallet.address,
      decimalToAssetUnits('1000.00000000', quoteAssetDecimals),
    );

    stargatePoolMock = await (
      await ethers.getContractFactory('StargateV2PoolMock')
    ).deploy(oftNativeFee, oftTokenFee, await usdc.getAddress());
    const exchangeAdapterComposing = await (
      await (
        await ethers.getContractFactory('ExchangeAdapterComposing_v1')
      ).deploy()
    ).waitForDeployment();
    ExchangeLayerZeroAdapterFactory = await ethers.getContractFactory(
      'ExchangeLayerZeroAdapter_v1',
      {
        libraries: {
          ExchangeAdapterComposing_v1:
            await exchangeAdapterComposing.getAddress(),
        },
      },
    );
  });

  describe('deploy', async function () {
    it('should work for valid arguments', async () => {
      await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $10
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );
    });

    it('should revert for invalid Exchange address', async () => {
      await expect(
        ExchangeLayerZeroAdapterFactory.deploy(
          decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $10
          decimalToAssetUnits('0.1', 18), // 0.1 ETH
          ethereumComposeGasLimit,
          ethereumEndpointId,
          decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
          ethers.ZeroAddress,
          await stargatePoolMock.getAddress(),
          decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
          decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
          decimalToPips('0.99900000'), // 99%
          await stargatePoolMock.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid exchange address/i);
    });

    it('should revert for invalid LZ endpoint address', async () => {
      await expect(
        ExchangeLayerZeroAdapterFactory.deploy(
          decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $10
          decimalToAssetUnits('0.1', 18), // 0.1 ETH
          ethereumComposeGasLimit,
          ethereumEndpointId,
          decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
          await exchange.getAddress(),
          ethers.ZeroAddress,
          decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
          decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
          decimalToPips('0.99900000'), // 99%
          await stargatePoolMock.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid lz endpoint address/i);
    });

    it('should revert for invalid OFT address', async () => {
      await expect(
        ExchangeLayerZeroAdapterFactory.deploy(
          decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $10
          decimalToAssetUnits('0.1', 18), // 0.1 ETH
          ethereumComposeGasLimit,
          ethereumEndpointId,
          decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
          await exchange.getAddress(),
          await stargatePoolMock.getAddress(),
          decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
          decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
          decimalToPips('0.99900000'), // 99%
          ethers.ZeroAddress,
        ),
      ).to.eventually.be.rejectedWith(/invalid oft address/i);
    });

    it('should revert for mismatched quote asset address', async () => {
      usdc = await (
        await (await ethers.getContractFactory('USDC')).deploy()
      ).waitForDeployment();
      stargatePoolMock = await (
        await ethers.getContractFactory('StargateV2PoolMock')
      ).deploy(oftNativeFee, oftTokenFee, await usdc.getAddress());

      await expect(
        ExchangeLayerZeroAdapterFactory.deploy(
          decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $10
          decimalToAssetUnits('0.1', 18), // 0.1 ETH
          ethereumComposeGasLimit,
          ethereumEndpointId,
          decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
          await exchange.getAddress(),
          await stargatePoolMock.getAddress(),
          decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
          decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
          decimalToPips('0.99900000'), // 99%
          await stargatePoolMock.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(
        /quote asset address does not match oft/i,
      );
    });
  });

  describe('lzCompose with deposit to wallet payload', async function () {
    let bridgeAdapter: ExchangeLayerZeroAdapter_v1;

    beforeEach(async () => {
      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $10
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );
      await bridgeAdapter.setDepositEnabled(true);
      await bridgeAdapter.setWithdrawEnabled(true);
    });

    it('should work for valid arguments', async () => {
      const depositQuantityInDecimal = '5.00000000';
      const depositQuantityInAssetUnits = ethers.parseUnits(
        depositQuantityInDecimal,
        quoteAssetDecimals,
      );
      const composeMessage = buildComposeMessage(
        depositQuantityInAssetUnits,
        traderWallet.address,
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint8', 'tuple(uint32,address)'],
          [
            2, // PayloadType.DepositToWallet,
            [
              0, // sourceEndpointId
              traderWallet.address, // depositorWallet
            ],
          ],
        ),
      );

      await usdc.transfer(
        await bridgeAdapter.getAddress(),
        depositQuantityInAssetUnits,
      );

      await stargatePoolMock.lzCompose(
        await bridgeAdapter.getAddress(),
        await stargatePoolMock.getAddress(),
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      const composeFailedEvents = await bridgeAdapter.queryFilter(
        bridgeAdapter.filters.ComposeFailed(),
      );
      expect(composeFailedEvents).to.have.lengthOf(0);

      const depositedEvents = await exchange.queryFilter(
        exchange.filters.Deposited(),
      );

      expect(depositedEvents).to.have.lengthOf(1);
      expect(depositedEvents[0].args?.index).to.equal(1);
      expect(depositedEvents[0].args?.quantity).to.equal(
        decimalToPips(depositQuantityInDecimal),
      );
    });

    it('should return tokens to destination wallet when deposits are disabled in adapter', async () => {
      const depositQuantityInDecimal = '5.00000000';
      const depositQuantityInAssetUnits = ethers.parseUnits(
        depositQuantityInDecimal,
        quoteAssetDecimals,
      );
      const composeMessage = buildComposeMessage(
        depositQuantityInAssetUnits,
        traderWallet.address,
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint8', 'tuple(uint32,address)'],
          [
            2, // PayloadType.DepositToWallet,
            [
              0, // sourceEndpointId
              traderWallet.address, // depositorWallet
            ],
          ],
        ),
      );

      await bridgeAdapter.setDepositEnabled(false);

      await usdc.transfer(
        await bridgeAdapter.getAddress(),
        depositQuantityInAssetUnits,
      );

      await stargatePoolMock.lzCompose(
        await bridgeAdapter.getAddress(),
        await stargatePoolMock.getAddress(),
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      const composeFailedEvents = await bridgeAdapter.queryFilter(
        bridgeAdapter.filters.ComposeFailed(),
      );
      expect(composeFailedEvents).to.have.lengthOf(1);
      expect(composeFailedEvents[0].args?.depositorWallet).to.equal(
        traderWallet.address,
      );
      expect(composeFailedEvents[0].args?.quantity).to.equal(
        depositQuantityInAssetUnits,
      );
      expect(
        ethers.toUtf8String(composeFailedEvents[0].args?.errorData),
      ).to.match(/deposits disabled/i);

      const transferEvents = await usdc.queryFilter(usdc.filters.Transfer());
      const lastTransferEvent = transferEvents[transferEvents.length - 1];
      expect(lastTransferEvent.args?.from).to.equal(
        await bridgeAdapter.getAddress(),
      );
      expect(lastTransferEvent.args?.to).to.equal(traderWallet.address);
      expect(lastTransferEvent.args?.value).to.equal(
        depositQuantityInAssetUnits,
      );

      await expect(usdc.balanceOf(bridgeAdapter)).to.eventually.equal(
        BigInt(0),
      );
    });

    it('should emit ComposeFailed and transfer tokens to owner when depositor wallet is zero address', async () => {
      const depositQuantityInDecimal = '5.00000000';
      const depositQuantityInAssetUnits = ethers.parseUnits(
        depositQuantityInDecimal,
        quoteAssetDecimals,
      );
      const composeMessage = buildComposeMessage(
        depositQuantityInAssetUnits,
        ethers.ZeroAddress, // fromAddress payload encoded as zero depositor
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint8', 'tuple(uint32,address)'],
          [
            2, // PayloadType.DepositToWallet,
            [
              0, // sourceEndpointId
              ethers.ZeroAddress, // depositorWallet zero
            ],
          ],
        ),
      );

      // Fund adapter with tokens to be transferred to owner on failure
      await usdc.transfer(
        await bridgeAdapter.getAddress(),
        depositQuantityInAssetUnits,
      );

      const startBlock = await ethers.provider.getBlockNumber();

      await stargatePoolMock.lzCompose(
        await bridgeAdapter.getAddress(),
        await stargatePoolMock.getAddress(),
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      const composeFailedEvents = await bridgeAdapter.queryFilter(
        bridgeAdapter.filters.ComposeFailed(),
        startBlock + 1,
      );
      expect(composeFailedEvents).to.have.lengthOf(1);
      expect(
        Buffer.from(
          composeFailedEvents[0].args?.errorData.substring(2),
          'hex',
        ).toString('utf8'),
      ).to.match(/invalid depositor wallet/i);

      const transferEvents = await usdc.queryFilter(usdc.filters.Transfer());
      const lastTransferEvent = transferEvents[transferEvents.length - 1];
      expect(lastTransferEvent.args?.from).to.equal(
        await bridgeAdapter.getAddress(),
      );
      expect(lastTransferEvent.args?.to).to.equal(ownerWallet.address);
      expect(lastTransferEvent.args?.value).to.equal(
        depositQuantityInAssetUnits,
      );
    });

    it('should return tokens to destination wallet when deposits are disabled in Exchange', async () => {
      const depositQuantityInDecimal = '5.00000000';
      const depositQuantityInAssetUnits = ethers.parseUnits(
        depositQuantityInDecimal,
        quoteAssetDecimals,
      );
      const composeMessage = buildComposeMessage(
        depositQuantityInAssetUnits,
        traderWallet.address,
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint8', 'tuple(uint32,address)'],
          [
            2, // PayloadType.DepositToWallet,
            [
              0, // sourceEndpointId
              traderWallet.address, // depositorWallet
            ],
          ],
        ),
      );

      await exchange.setDepositEnabled(false);

      await usdc.transfer(
        await bridgeAdapter.getAddress(),
        depositQuantityInAssetUnits,
      );

      await stargatePoolMock.lzCompose(
        await bridgeAdapter.getAddress(),
        await stargatePoolMock.getAddress(),
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      const composeFailedEvents = await bridgeAdapter.queryFilter(
        bridgeAdapter.filters.ComposeFailed(),
      );
      expect(composeFailedEvents).to.have.lengthOf(1);
      expect(composeFailedEvents[0].args?.depositorWallet).to.equal(
        traderWallet.address,
      );
      expect(composeFailedEvents[0].args?.quantity).to.equal(
        depositQuantityInAssetUnits,
      );

      const transferEvents = await usdc.queryFilter(usdc.filters.Transfer());
      const lastTransferEvent = transferEvents[transferEvents.length - 1];
      expect(lastTransferEvent.args?.from).to.equal(
        await bridgeAdapter.getAddress(),
      );
      expect(lastTransferEvent.args?.to).to.equal(traderWallet.address);
      expect(lastTransferEvent.args?.value).to.equal(
        depositQuantityInAssetUnits,
      );

      await expect(usdc.balanceOf(bridgeAdapter)).to.eventually.equal(
        BigInt(0),
      );
    });

    it('should revert when lzCompose is called by a non-LZ Endpoint sender', async () => {
      // Call lzCompose directly from a non-endpoint wallet and expect revert
      await expect(
        bridgeAdapter.lzCompose(
          await stargatePoolMock.getAddress(),
          ethers.randomBytes(32),
          '0x',
          await stargatePoolMock.getAddress(),
          '0x',
        ),
      ).to.be.revertedWith(/caller must be lz endpoint/i);
    });

    it('should revert when the from address is not the expected OFT', async () => {
      // Call lzCompose directly from a non-endpoint wallet and expect revert
      await expect(
        stargatePoolMock.lzCompose(
          await bridgeAdapter.getAddress(),
          ethers.ZeroAddress,
          ethers.randomBytes(32),
          '0x',
          await stargatePoolMock.getAddress(),
          '0x',
        ),
      ).to.be.revertedWith(/oapp must be oft/i);
    });

    it('should transfer tokens to owner and emit ComposeFailed when payload is malformed', async () => {
      const depositQuantityInDecimal = '7.00000000';
      const depositQuantityInAssetUnits = ethers.parseUnits(
        depositQuantityInDecimal,
        quoteAssetDecimals,
      );

      // Malformed payload: first byte maps to an unknown PayloadType
      const malformedPayload = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint8'],
        [255],
      );

      const composeMessage = buildComposeMessage(
        depositQuantityInAssetUnits,
        traderWallet.address,
        malformedPayload,
      );

      // Fund adapter with tokens that will be transferred to owner on failure
      await usdc.transfer(
        await bridgeAdapter.getAddress(),
        depositQuantityInAssetUnits,
      );

      // Trigger lzCompose via the mock endpoint (valid sender and from address)
      await stargatePoolMock.lzCompose(
        await bridgeAdapter.getAddress(),
        await stargatePoolMock.getAddress(),
        ethers.randomBytes(32),
        composeMessage,
        await stargatePoolMock.getAddress(),
        '0x',
      );

      // Assert event emitted by adapter with depositorWallet = 0x0 and amount = depositQuantity
      const composeFailedEvents = await bridgeAdapter.queryFilter(
        bridgeAdapter.filters.ComposeFailed(),
      );
      expect(composeFailedEvents.length).to.be.greaterThan(0);
      const lastComposeFailed =
        composeFailedEvents[composeFailedEvents.length - 1];
      expect(lastComposeFailed.args?.depositorWallet).to.equal(
        ownerWallet.address,
      );
      expect(lastComposeFailed.args?.quantity).to.equal(
        depositQuantityInAssetUnits,
      );

      // Assert tokens were transferred from adapter to owner
      const transferEvents = await usdc.queryFilter(usdc.filters.Transfer());
      const lastTransferEvent = transferEvents[transferEvents.length - 1];
      expect(lastTransferEvent.args?.from).to.equal(
        await bridgeAdapter.getAddress(),
      );
      expect(lastTransferEvent.args?.to).to.equal(ownerWallet.address);
      expect(lastTransferEvent.args?.value).to.equal(
        depositQuantityInAssetUnits,
      );
    });
  });

  describe('withdrawQuoteAsset', async function () {
    let bridgeAdapter: ExchangeLayerZeroAdapter_v1;
    let signature: string;
    let withdrawal: Withdrawal;

    beforeEach(async () => {
      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $10
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );

      await governance.initiateBridgeAdaptersUpgrade([
        await bridgeAdapter.getAddress(),
      ]);
      await time.increase(fieldUpgradeDelayInS);
      await governance.finalizeBridgeAdaptersUpgrade([
        await bridgeAdapter.getAddress(),
      ]);

      await bridgeAdapter.setWithdrawEnabled(true);

      const depositQuantity = ethers.parseUnits('5.0', quoteAssetDecimals);
      await usdc.transfer(traderWallet.address, depositQuantity);
      await usdc
        .connect(traderWallet)
        .approve(await exchange.getAddress(), depositQuantity);
      await exchange
        .connect(traderWallet)
        .deposit(depositQuantity, ethers.ZeroAddress);
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
        bridgeAdapter: await bridgeAdapter.getAddress(),
        bridgeAdapterPayload: ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint32'],
          [1],
        ),
      };
      signature = await traderWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );
    });

    it('should work for valid arguments to Berachain endpoint ID when adapter is funded', async () => {
      withdrawal = {
        ...withdrawal,
        bridgeAdapterPayload: ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint32'],
          [ethereumEndpointId],
        ),
      };
      signature = await traderWallet.signTypedData(
        ...getWithdrawalSignatureTypedData(
          withdrawal,
          await exchange.getAddress(),
        ),
      );

      await ownerWallet.sendTransaction({
        to: await bridgeAdapter.getAddress(),
        value: oftNativeFee,
      });

      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00000000', signature));
    });

    it('should work for valid arguments to non-Berachain endpoint ID when adapter is funded', async () => {
      await ownerWallet.sendTransaction({
        to: await bridgeAdapter.getAddress(),
        value: oftNativeFee,
      });

      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00000000', signature));
    });

    it('should work with fallback for valid arguments when adapter is not funded', async () => {
      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00000000', signature));
    });

    it('should work when multiple adapters are whitelisted', async () => {
      await ownerWallet.sendTransaction({
        to: await bridgeAdapter.getAddress(),
        value: oftNativeFee,
      });

      const bridgebridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $10
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );

      await governance.initiateBridgeAdaptersUpgrade([
        await bridgebridgeAdapter.getAddress(),
        await bridgeAdapter.getAddress(),
      ]);
      await time.increase(fieldUpgradeDelayInS);
      await governance.finalizeBridgeAdaptersUpgrade([
        await bridgebridgeAdapter.getAddress(),
        await bridgeAdapter.getAddress(),
      ]);

      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00000000', signature));
    });

    it('should revert when caller is neither Exchange nor a whitelisted provider', async () => {
      await expect(
        bridgeAdapter
          // Not exchange, not a whitelisted MA provider
          .connect(traderWallet)
          .withdrawQuoteAsset(
            traderWallet.address,
            ethers.parseUnits('1.0', quoteAssetDecimals),
            ethers.AbiCoder.defaultAbiCoder().encode(['uint32'], [1]),
          ),
      ).to.be.revertedWith(
        'Caller must be Exchange or Managed Account provider contract',
      );
    });

    it('should fallback to deposit and emit WithdrawQuoteAssetFailed when withdraws are disabled', async () => {
      await bridgeAdapter.connect(ownerWallet).setWithdrawEnabled(false);

      const balanceBefore = await exchange.loadBalanceBySymbol(
        traderWallet.address,
        quoteAssetSymbol,
      );

      const startBlock = await ethers.provider.getBlockNumber();

      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00000000', signature));

      // Assert WithdrawQuoteAssetFailed event emitted
      const failedEvents = await bridgeAdapter.queryFilter(
        bridgeAdapter.filters.WithdrawQuoteAssetFailed(),
        startBlock + 1,
      );
      expect(failedEvents).to.have.lengthOf(1);
      expect(failedEvents[0].args?.depositorWallet).to.equal(
        traderWallet.address,
      );
      expect(failedEvents[0].args?.quantity).to.equal(
        decimalToAssetUnits(withdrawal.quantity, quoteAssetDecimals),
      );
      expect(failedEvents[0].args?.payload).to.equal(
        withdrawal.bridgeAdapterPayload,
      );
      expect(
        Buffer.from(
          failedEvents[0].args?.errorData.substring(2),
          'hex',
        ).toString('utf8'),
      ).to.equal('Withdraw disabled');

      // Assert fallback deposit occurred
      const balanceAfter = await exchange.loadBalanceBySymbol(
        traderWallet.address,
        quoteAssetSymbol,
      );
      expect(balanceAfter).to.equal(balanceBefore); // Balance unchanged due to re-deposit
    });

    it('should fallback to transfer and emit WithdrawQuoteAssetFailed when withdraws and deposits are both disabled', async () => {
      await bridgeAdapter.connect(ownerWallet).setWithdrawEnabled(false);
      await exchange.setDepositEnabled(false);

      const traderUsdcBalanceBefore = await usdc.balanceOf(
        traderWallet.address,
      );
      const startBlock = await ethers.provider.getBlockNumber();

      await exchange
        .connect(dispatcherWallet)
        .withdraw(...getWithdrawArguments(withdrawal, '0.00000000', signature));

      // Assert WithdrawQuoteAssetFailed event emitted
      const failedEvents = await bridgeAdapter.queryFilter(
        bridgeAdapter.filters.WithdrawQuoteAssetFailed(),
        startBlock + 1,
      );
      expect(failedEvents).to.have.lengthOf(1);
      expect(failedEvents[0].args?.depositorWallet).to.equal(
        traderWallet.address,
      );
      expect(failedEvents[0].args?.quantity).to.equal(
        decimalToAssetUnits(withdrawal.quantity, quoteAssetDecimals),
      );
      expect(failedEvents[0].args?.payload).to.equal(
        withdrawal.bridgeAdapterPayload,
      );
      expect(
        Buffer.from(
          failedEvents[0].args?.errorData.substring(2),
          'hex',
        ).toString('utf8'),
      ).to.match(/deposit.*disabled/i);

      // Assert fallback transfer occurred (not deposit)
      const traderUsdcBalanceAfter = await usdc.balanceOf(traderWallet.address);
      expect(traderUsdcBalanceAfter - traderUsdcBalanceBefore).to.equal(
        decimalToAssetUnits(withdrawal.quantity, quoteAssetDecimals),
      );
    });
  });

  describe('setComposeParameters', async function () {
    let bridgeAdapter: ExchangeLayerZeroAdapter_v1;

    beforeEach(async () => {
      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );
    });

    it('should revert when called by a non-owner wallet', async () => {
      await expect(
        bridgeAdapter
          .connect(traderWallet)
          .setComposeParameters(
            decimalToAssetUnits('1.00000000', quoteAssetDecimals),
            decimalToAssetUnits('0.01', 18),
            decimalToAssetUnits('0.50000000', quoteAssetDecimals),
            decimalToAssetUnits('1.00000000', quoteAssetDecimals),
            decimalToAssetUnits('1.00000000', quoteAssetDecimals),
            decimalToPips('0.99900000'),
          ),
      ).to.be.revertedWithCustomError(
        bridgeAdapter,
        'OwnableUnauthorizedAccount',
      );
    });

    it('should revert when addManagedAccountDepositFee exceeds minimum', async () => {
      await expect(
        bridgeAdapter.connect(ownerWallet).setComposeParameters(
          // Fee higher than minimum => revert
          decimalToAssetUnits('2.00000000', quoteAssetDecimals),
          decimalToAssetUnits('0.01', 18),
          decimalToAssetUnits('0.50000000', quoteAssetDecimals),
          decimalToAssetUnits('1.00000000', quoteAssetDecimals),
          decimalToAssetUnits('1.00000000', quoteAssetDecimals),
          decimalToPips('0.99900000'),
        ),
      ).to.be.revertedWith(/add ma deposit fee exceeds minimum/i);
    });

    it('should revert when depositToManagedAccountFee exceeds minimum', async () => {
      await expect(
        bridgeAdapter.connect(ownerWallet).setComposeParameters(
          decimalToAssetUnits('1.00000000', quoteAssetDecimals),
          decimalToAssetUnits('0.01', 18),
          // Fee higher than minimum => revert
          decimalToAssetUnits('2.00000000', quoteAssetDecimals),
          decimalToAssetUnits('1.00000000', quoteAssetDecimals),
          decimalToAssetUnits('1.00000000', quoteAssetDecimals),
          decimalToPips('0.99900000'),
        ),
      ).to.be.revertedWith(/deposit to ma fee must be less than minimum/i);
    });
  });

  describe('setStargateForwarder', async function () {
    let bridgeAdapter: ExchangeLayerZeroAdapter_v1;

    beforeEach(async () => {
      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );
    });

    it('should set the stargateForwarder when called by owner', async () => {
      const newForwarder = dispatcherWallet.address;

      await bridgeAdapter
        .connect(ownerWallet)
        .setStargateForwarder(newForwarder);

      expect(await bridgeAdapter.stargateForwarder()).to.equal(newForwarder);
    });

    it('should revert when called by a non-owner wallet', async () => {
      const newForwarder = dispatcherWallet.address;

      await expect(
        bridgeAdapter.connect(traderWallet).setStargateForwarder(newForwarder),
      ).to.be.revertedWithCustomError(
        bridgeAdapter,
        'OwnableUnauthorizedAccount',
      );
    });

    it('should revert when attempting to set stargateForwarder more than once', async () => {
      const firstForwarder = dispatcherWallet.address;
      const secondForwarder = ownerWallet.address;

      await bridgeAdapter
        .connect(ownerWallet)
        .setStargateForwarder(firstForwarder);

      await expect(
        bridgeAdapter
          .connect(ownerWallet)
          .setStargateForwarder(secondForwarder),
      ).to.be.revertedWith(/stargate forwarder can only be set once/i);
    });
  });

  describe('withdrawNativeAsset', async function () {
    let bridgeAdapter: ExchangeLayerZeroAdapter_v1;

    beforeEach(async () => {
      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );

      // Fund adapter with native asset
      await ownerWallet.sendTransaction({
        to: await bridgeAdapter.getAddress(),
        value: ethers.parseEther('0.01'),
      });
    });

    it('should withdraw native asset to destination wallet when called by owner', async () => {
      const destination = dispatcherWallet.address;
      const quantity = ethers.parseEther('0.004');
      const adapterAddress = await bridgeAdapter.getAddress();

      const contractBalanceBefore = await ethers.provider.getBalance(
        adapterAddress,
      );
      const destinationBalanceBefore = await ethers.provider.getBalance(
        destination,
      );

      await bridgeAdapter
        .connect(ownerWallet)
        .withdrawNativeAsset(destination, quantity);

      const contractBalanceAfter = await ethers.provider.getBalance(
        adapterAddress,
      );
      const destinationBalanceAfter = await ethers.provider.getBalance(
        destination,
      );

      expect(contractBalanceBefore - contractBalanceAfter).to.equal(quantity);
      expect(destinationBalanceAfter - destinationBalanceBefore).to.equal(
        quantity,
      );
    });

    it('should revert when called by a non-owner wallet', async () => {
      const destination = dispatcherWallet.address;
      const quantity = ethers.parseEther('0.001');

      await expect(
        bridgeAdapter
          .connect(traderWallet)
          .withdrawNativeAsset(destination, quantity),
      ).to.be.revertedWithCustomError(
        bridgeAdapter,
        'OwnableUnauthorizedAccount',
      );
    });

    it('should revert with "Native asset transfer failed" when underfunded', async () => {
      const destination = dispatcherWallet.address;
      // Attempt to withdraw more than contract balance
      const adapterAddress = await bridgeAdapter.getAddress();
      const contractBalance = await ethers.provider.getBalance(adapterAddress);
      const excessiveAmount = contractBalance + BigInt(1);

      await expect(
        bridgeAdapter
          .connect(ownerWallet)
          .withdrawNativeAsset(destination, excessiveAmount),
      ).to.be.revertedWith(/native asset transfer failed/i);
    });
  });

  describe('setDepositEnabled', async function () {
    let bridgeAdapter: ExchangeLayerZeroAdapter_v1;

    beforeEach(async () => {
      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );
    });

    it('should revert when called by a non-owner wallet', async () => {
      await expect(
        bridgeAdapter.connect(traderWallet).setDepositEnabled(true),
      ).to.be.revertedWithCustomError(
        bridgeAdapter,
        'OwnableUnauthorizedAccount',
      );
    });
  });

  describe('setWithdrawEnabled', async function () {
    let bridgeAdapter: ExchangeLayerZeroAdapter_v1;

    beforeEach(async () => {
      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );
    });

    it('should revert when called by a non-owner wallet', async () => {
      await expect(
        bridgeAdapter.connect(traderWallet).setWithdrawEnabled(true),
      ).to.be.revertedWithCustomError(
        bridgeAdapter,
        'OwnableUnauthorizedAccount',
      );
    });
  });

  describe('setMinimumWithdrawQuantityMultiplier', async function () {
    let bridgeAdapter: ExchangeLayerZeroAdapter_v1;

    beforeEach(async () => {
      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );
    });

    it('should set the new multiplier when called by owner', async () => {
      const newMultiplier = decimalToPips('0.95000000');

      await bridgeAdapter
        .connect(ownerWallet)
        .setMinimumWithdrawQuantityMultiplier(newMultiplier);

      expect(await bridgeAdapter.minimumWithdrawQuantityMultiplier()).to.equal(
        newMultiplier,
      );
    });

    it('should revert when called by a non-owner wallet', async () => {
      const newMultiplier = decimalToPips('0.90000000');

      await expect(
        bridgeAdapter
          .connect(traderWallet)
          .setMinimumWithdrawQuantityMultiplier(newMultiplier),
      ).to.be.revertedWithCustomError(
        bridgeAdapter,
        'OwnableUnauthorizedAccount',
      );
    });

    it('should revert when new value is too large', async () => {
      const tooLargeMultiplier = decimalToPips('1.00000001'); // > 100%

      await expect(
        bridgeAdapter
          .connect(ownerWallet)
          .setMinimumWithdrawQuantityMultiplier(tooLargeMultiplier),
      ).to.be.revertedWith(/new value out of range/i);
    });

    it('should revert when new value is too small', async () => {
      const tooSmallMultiplier = decimalToPips('0.89999999'); // < 90%

      await expect(
        bridgeAdapter
          .connect(ownerWallet)
          .setMinimumWithdrawQuantityMultiplier(tooSmallMultiplier),
      ).to.be.revertedWith(/new value out of range/i);
    });
  });

  describe('estimateWithdrawQuantityInAssetUnits', async function () {
    let bridgeAdapter: ExchangeLayerZeroAdapter_v1;

    beforeEach(async () => {
      // Deploy with non-zero fee (sendFee already set in suite)
      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );
    });

    it('should return correct estimates with non-zero fee in Stargate pool', async () => {
      const quantityDecimal = '100.00000000';
      const quantityPips = decimalToPips(quantityDecimal);
      const expectedAssetUnits =
        BigInt(decimalToAssetUnits(quantityDecimal, quoteAssetDecimals)) -
        BigInt(oftTokenFee);

      const [estimated, minimum, poolDecimals] =
        await bridgeAdapter.estimateWithdrawQuantityInAssetUnits(
          ethereumEndpointId,
          quantityPips,
        );

      expect(poolDecimals).to.equal(quoteAssetDecimals);
      expect(minimum).to.equal(BigInt(99900000));
      expect(estimated).to.equal(expectedAssetUnits);
    });
  });

  describe('loadEthereumWithdrawalGasFeeInAssetUnits', async function () {
    let bridgeAdapter: ExchangeLayerZeroAdapter_v1;

    beforeEach(async () => {
      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        decimalToAssetUnits('10.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('0.1', 18), // 0.1 ETH
        ethereumComposeGasLimit,
        ethereumEndpointId,
        decimalToAssetUnits('0.05', quoteAssetDecimals), // $0.05
        await exchange.getAddress(),
        await stargatePoolMock.getAddress(),
        decimalToAssetUnits('100.00000000', quoteAssetDecimals), // $100
        decimalToAssetUnits('1.00000000', quoteAssetDecimals), // $1
        decimalToPips('0.99900000'), // 99%
        await stargatePoolMock.getAddress(),
      );
    });

    it('should return gas fees equal to the configured native fee when compose is empty', async () => {
      const gasFee =
        await bridgeAdapter.loadEthereumWithdrawalGasFeeInAssetUnits();

      // Gas fee should equal the mock's native fee
      expect(gasFee).to.equal(oftNativeFee);
    });
  });
});
