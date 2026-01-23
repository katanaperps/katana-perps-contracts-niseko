// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

import { Address } from "../libraries/Address.sol";
import { AssetUnitConversions } from "../libraries/AssetUnitConversions.sol";
import { IndexPrice } from "../libraries/Structs.sol";
import { Owned } from "../Owned.sol";
import { String } from "../libraries/String.sol";
import { IExchange, IIndexPriceAdapter } from "../libraries/Interfaces.sol";

struct ChainlinkDataStreamsMarket {
  bool exists;
  string baseAssetSymbol;
  uint8 decimals;
  bytes32 feedId;
  uint64 priceMultiplier;
}

/**
 * @dev Data Streams report schema v3 (crypto streams). Prices, bids and asks use 8 or 18 decimals
 * depending on the stream.
 *
 * https://docs.chain.link/data-streams/reference/report-schema-v3
 */
struct ReportV3 {
  bytes32 feedId;
  uint32 validFromTimestamp;
  uint32 observationsTimestamp;
  uint192 nativeFee;
  uint192 linkFee;
  uint32 expiresAt;
  int192 price;
  int192 bid;
  int192 ask;
}

interface IVerifierProxy {
  /**
   * @notice Route a report to the correct verifier and (optionally) bill fees.
   * @param payload Full report payload (header + signed report).
   * @param parameterPayload ABI-encoded fee metadata.
   */
  function verify(
    bytes calldata payload,
    bytes calldata parameterPayload
  ) external payable returns (bytes memory verifierResponse);

  function s_feeManager() external view returns (address);
}

contract ChainlinkDataStreamsIndexPriceAdapter is IIndexPriceAdapter, Owned {
  // Address whitelisted to call `setActive`
  address public immutable activator;
  // Mapping of Chainlink feed IDs to market structs. The IDs are constructed as bytes32
  // representations of the base asset symbol, e.g. bytes32("ETH")
  mapping(bytes32 => ChainlinkDataStreamsMarket) public marketsByFeedId;
  // Address of Exchange contract
  IExchange public exchange;
  // Mapping of market base asset symbols to market structs
  mapping(string => ChainlinkDataStreamsMarket) public marketsByBaseAssetSymbol;
  // Address of Chainling verifier contract
  IVerifierProxy public immutable verifier;

  /**
   * @notice Instantiate a new `ChainlinkDataStreamsIndexPriceAdapter` contract
   *
   * @param activator_ Address whitelisted to call `setActive`
   * @param baseAssetSymbols List of base asset symbols to associate with price IDs
   * @param decimals List of decimal points to use when loading the price for a market
   * @param feedIds List of price IDs to associate with base asset symbols
   * @param priceMultipliers List of price multipliers to use when loading the price for a market
   * @param verifier_ Address of Chainlink verifier contract

   */
  constructor(
    address activator_,
    string[] memory baseAssetSymbols,
    uint8[] memory decimals,
    bytes32[] memory feedIds,
    uint64[] memory priceMultipliers,
    address verifier_
  ) Owned() {
    require(activator_ != address(0x0), "Invalid activator address");
    activator = activator_;

    require(
      baseAssetSymbols.length == decimals.length &&
        decimals.length == feedIds.length &&
        feedIds.length == priceMultipliers.length,
      "Argument length mismatch"
    );

    for (uint8 i = 0; i < baseAssetSymbols.length; i++) {
      addMarket(baseAssetSymbols[i], decimals[i], feedIds[i], priceMultipliers[i]);
    }

    require(Address.isContract(verifier_), "Invalid Chainlink verifier contract address");
    verifier = IVerifierProxy(verifier_);
  }

  modifier onlyActivator() {
    require(msg.sender == activator, "Caller must be activator");
    _;
  }

  modifier onlyExchange() {
    require(msg.sender == address(exchange), "Caller must be Exchange contract");
    _;
  }

  /*
   * @notice Adds a new data feed ID to base asset symbol mapping for use by
   * `validateIndexPricePayload`. Neither the symbol nor corresponding ID can already have been
   * added
   *
   * @param baseAssetSymbol The symbol of the base asset symbol
   * @param feedId The ChainlinkDataStreams data feed ID
   * @param priceMultiplier The price multiplier to use when loading the price for a market. If
   * greater than 1, the base asset symbol must include the price multiplier as a prefix
   */
  function addMarket(
    string memory baseAssetSymbol,
    uint8 decimals,
    bytes32 feedId,
    uint64 priceMultiplier
  ) public onlyAdmin {
    require(decimals <= 18, "Asset cannot have more than 18 decimals");

    require(feedId != bytes32(0x0), "Invalid feed ID");
    require(!marketsByFeedId[feedId].exists, "Already added feed ID");

    require(bytes(baseAssetSymbol).length > 0, "Invalid base asset symbol");
    require(!marketsByBaseAssetSymbol[baseAssetSymbol].exists, "Already added base asset symbol");

    require(priceMultiplier > 0, "Invalid price multiplier");

    if (priceMultiplier > 1) {
      string memory priceMultiplierAsString = Strings.toString(priceMultiplier);
      require(
        String.startsWith(baseAssetSymbol, priceMultiplierAsString),
        "Base asset symbol does not start with price multiplier"
      );
    }

    ChainlinkDataStreamsMarket memory chainlinkMarket = ChainlinkDataStreamsMarket({
      exists: true,
      baseAssetSymbol: baseAssetSymbol,
      decimals: decimals,
      feedId: feedId,
      priceMultiplier: priceMultiplier
    });

    marketsByFeedId[feedId] = chainlinkMarket;
    marketsByBaseAssetSymbol[baseAssetSymbol] = chainlinkMarket;
  }

  /**
   * @notice Sets adapter as active, indicating that it is now whitelisted by the Exchange
   */
  function setActive(IExchange exchange_) public override onlyActivator {
    require(!_isActive(), "Adapter already active");

    require(Address.isContract(address(exchange_)), "Invalid Exchange contract address");

    exchange = exchange_;
  }

  /**
   * @notice Validate encoded payload and return `IndexPrice` struct
   *
   * https://docs.chain.link/data-streams/tutorials/evm-onchain-report-verification#examine-the-code
   */
  function validateIndexPricePayload(bytes calldata payload) public override onlyExchange returns (IndexPrice memory) {
    // Extract reportData and schema version
    (, bytes memory reportData) = abi.decode(payload, (bytes32[3], bytes));
    uint16 reportVersion = (uint16(uint8(reportData[0])) << 8) | uint16(uint8(reportData[1]));
    require(reportVersion == 3, "Report version must be 3");

    // Katana does not have a FeeManager and no funding is needed to verify
    // reports. Validate no FeeManager is set as a sanity check
    require(verifier.s_feeManager() == address(0), "FeeManager not supported");
    bytes memory verified = verifier.verify(payload, bytes(""));
    ReportV3 memory report = abi.decode(verified, (ReportV3));

    ChainlinkDataStreamsMarket memory market = marketsByFeedId[report.feedId];
    require(market.exists, "Unknown feed ID");

    uint64 priceInPips = AssetUnitConversions.assetUnitsToPips(SafeCast.toUint256(report.price), market.decimals) *
      market.priceMultiplier;

    return
      IndexPrice({
        baseAssetSymbol: market.baseAssetSymbol,
        timestampInMs: SafeCast.toUint64(report.validFromTimestamp) * 1000,
        price: priceInPips
      });
  }

  function _isActive() private view returns (bool) {
    return address(exchange) != address(0x0);
  }
}
