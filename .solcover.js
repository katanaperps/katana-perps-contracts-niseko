module.exports = {
  istanbulReporter: ['json-summary', 'html', 'text'],
  mocha: {
    enableTimeouts: false,
  },
  matrixOutputPath: './coverage/testMatrix.json',
  mochaJsonOutputPath: './coverage/mochaOutput.json',
  skipFiles: ['test/', 'util/ExchangeWalletStateAggregator.sol'],
};
