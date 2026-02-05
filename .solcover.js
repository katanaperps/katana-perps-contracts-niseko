module.exports = {
  istanbulReporter: ['json-summary', 'html', 'text'],
  mocha: {
    enableTimeouts: false,
  },
  matrixOutputPath: './coverage/testMatrix.json',
  mochaJsonOutputPath: './coverage/mochaOutput.json',
  skipFiles: [
    'test/',
    'util/ExchangeWalletStateAggregator.sol',
    'bridge-adapters/ExchangeLayerZeroAdapter_v1.sol',
    'bridge-adapters/libraries/ ExchangeAdapterComposing_v1.sol',
  ],
};
