// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

import { Address } from "../libraries/Address.sol";
import { AssetUnitConversions } from "../libraries/AssetUnitConversions.sol";
import { Owned } from "../Owned.sol";
import { String } from "../libraries/String.sol";
import { IExchange, IIndexPriceAdapter, IOraclePriceAdapter } from "../libraries/Interfaces.sol";
import { IndexPrice, Market } from "../libraries/Structs.sol";

struct ChainlinkDataStreamsMarket {
  bool exists;
  string baseAssetSymbol;
  uint8 decimals;
  bytes32 feedId;
  uint64 priceMultiplier;
}

/**
 * @dev Data Streams report schema v3 (Crypto Advanced)
 *
 * https://docs.chain.link/data-streams/reference/report-schema-v3
 */
struct ReportV3 {
  // Unique identifier for the data stream
  bytes32 feedId;
  // Start timestamp of price validity period (seconds)
  uint32 validFromTimestamp;
  // End timestamp of price validity period (seconds)
  uint32 observationsTimestamp;
  // Verification cost in native blockchain tokens
  uint192 nativeFee;
  // Verification cost in LINK tokens
  uint192 linkFee;
  // Timestamp when this report expires (seconds)
  uint32 expiresAt;
  // DON consensus median price
  int192 price;
  // Simulated buy impact price at X% liquidity depth
  int192 bid;
  // Simulated sell impact price at X% liquidity depth
  int192 ask;
}

/**
 * @dev Data Streams report schema v8 (RWA Standard)
 *
 * https://docs.chain.link/data-streams/reference/report-schema-v8
 */
struct ReportV8 {
  // Unique identifier for the Data Streams feed
  bytes32 feedId;
  // Earliest timestamp when the price is valid (seconds)
  uint32 validFromTimestamp;
  // Latest timestamp when the price is valid (seconds)
  uint32 observationsTimestamp;
  // Cost to verify report onchain (native token)
  uint192 nativeFee;
  // Cost to verify report onchain (LINK)
  uint192 linkFee;
  // Expiration date of the report (seconds)
  uint32 expiresAt;
  // Timestamp of the last valid price update (nanoseconds)
  uint64 lastUpdateTimestamp;
  // DON's consensus median price
  int192 midPrice;
  // Market status: 0 (Unknown), 1 (Closed), 2 (Open)
  uint32 marketStatus;
}

/**
 * @dev Data Streams report schema v10 (Tokenized Asset)
 *
 * https://docs.chain.link/data-streams/reference/report-schema-v10
 */
struct ReportV10 {
  // Unique identifier for the Data Streams feed
  bytes32 feedId;
  // Earliest timestamp when the price is valid (seconds)
  uint32 validFromTimestamp;
  // Latest timestamp when the price is valid (seconds)
  uint32 observationsTimestamp;
  // Cost to verify report onchain (native token)
  uint192 nativeFee;
  // Cost to verify report onchain (LINK)
  uint192 linkFee;
  // Expiration date of the report (seconds)
  uint32 expiresAt;
  // Timestamp of the last valid price update (nanoseconds)
  uint64 lastUpdateTimestamp;
  // Last traded price from the real-world equity market
  int192 price;
  // Market status: 0 (Unknown), 1 (Closed), 2 (Open)
  uint32 marketStatus;
  // Currently applied multiplier accounting for past corporate actions
  int192 currentMultiplier;
  // Multiplier to be applied at the activationDateTime (0 if none scheduled)
  int192 newMultiplier;
  // When the next corporate action takes effect (0 if none scheduled) (seconds)
  uint32 activationDateTime;
  // Aggregated price across centralized exchanges where the tokenized asset trades
  int192 tokenizedPrice;
}

/**
 * @dev Data Streams report schema v11 (RWA Advanced)
 *
 * https://docs.chain.link/data-streams/reference/report-schema-v11
 */
struct ReportV11 {
  // Unique identifier for the Data Streams feed
  bytes32 feedId;
  // Earliest timestamp when the price is valid (seconds)
  uint32 validFromTimestamp;
  // Latest timestamp when the price is valid (seconds)
  uint32 observationsTimestamp;
  // Cost to verify report onchain (native token)
  uint192 nativeFee;
  // Cost to verify report onchain (LINK)
  uint192 linkFee;
  // Expiration date of the report (seconds)
  uint32 expiresAt;
  // DON consensus mid-price
  int192 mid;
  // Timestamp of the last update for the mid price (nanoseconds)
  uint64 lastSeenTimestampNs;
  // Median bid price
  int192 bid;
  // Volume at bid price
  int192 bidVolume;
  // Median ask price
  int192 ask;
  // Volume at ask price
  int192 askVolume;
  // Last traded price
  int192 lastTradedPrice;
  // Market status: 0 (Unknown), 1 (Closed), 2 (Open)
  uint32 marketStatus;
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

  // solhint-disable-next-line func-name-mixedcase
  function s_feeManager() external view returns (address);
}

contract ChainlinkDataStreamsIndexAndOraclePriceAdapter is IIndexPriceAdapter, IOraclePriceAdapter, Owned {
  // Address whitelisted to call `setActive`
  address public immutable activator;
  // Mapping of Chainlink feed IDs to market structs. The IDs are constructed as bytes32
  // representations of the base asset symbol, e.g. bytes32("ETH")
  mapping(bytes32 => ChainlinkDataStreamsMarket) public marketsByFeedId;
  // Address of Exchange contract
  IExchange public exchange;
  // Mapping of base asset symbol => index price struct
  mapping(string => IndexPrice) public latestIndexPriceByBaseAssetSymbol;
  // Mapping of market base asset symbols to market structs
  mapping(string => ChainlinkDataStreamsMarket) public marketsByBaseAssetSymbol;
  // Address of Chainlink verifier contract
  IVerifierProxy public immutable verifier;

  /**
   * @notice Instantiate a new `ChainlinkDataStreamsIndexAndOraclePriceAdapter` contract
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
    require(_isActive(), "Exchange not set");
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
    // The first 2 bytes of the feed ID encode the report schema version
    uint16 reportVersion = uint16(bytes2(feedId));
    require(
      reportVersion == 3 || reportVersion == 8 || reportVersion == 10 || reportVersion == 11,
      "Unsupported report version"
    );
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
   * @notice Return latest price for base asset symbol in quote asset terms. Reverts if no price is available
   */
  function loadPriceForBaseAssetSymbol(string memory baseAssetSymbol) public view override returns (uint64 price) {
    IndexPrice memory indexPrice = latestIndexPriceByBaseAssetSymbol[baseAssetSymbol];
    require(indexPrice.price > 0, "Missing price");

    return indexPrice.price;
  }

  /**
   * @notice Sets adapter as active, indicating that it is now whitelisted by the Exchange
   */
  function setActive(IExchange exchange_) public override(IIndexPriceAdapter, IOraclePriceAdapter) onlyActivator {
    if (_isActive()) {
      // When used for both oracle and index price roles, this function will validly be called twice
      return;
    }

    require(Address.isContract(address(exchange_)), "Invalid Exchange contract address");
    exchange = exchange_;

    // Backfill latest prices for all markets
    Market memory market;
    for (uint8 i = 0; i < exchange.loadMarketsLength(); i++) {
      market = exchange.loadMarket(i);
      if (marketsByBaseAssetSymbol[market.baseAssetSymbol].exists) {
        latestIndexPriceByBaseAssetSymbol[market.baseAssetSymbol] = IndexPrice(
          market.baseAssetSymbol,
          market.lastIndexPriceTimestampInMs,
          market.lastIndexPrice
        );
      }
    }
  }

  /**
   * @notice Validate an encoded payload in order to set initial price for a new market
   *
   * @dev When adding a new market, `MarketAdmin` sets the initial price from the current oracle price adapter. This
   * contract sources oracle price data from index price payloads it has already seen, so to avoid reversion when
   * adding a new market a Chainlink report payload corresponding to the new market must first be provided to this
   * function
   */
  function validateInitialIndexPricePayloadAdmin(bytes calldata payload) public onlyAdmin {
    require(_isActive(), "Exchange not set");

    IndexPrice memory indexPrice = _validateIndexPricePayload(payload);

    require(
      latestIndexPriceByBaseAssetSymbol[indexPrice.baseAssetSymbol].timestampInMs == 0,
      "Price already exists for market"
    );

    latestIndexPriceByBaseAssetSymbol[indexPrice.baseAssetSymbol] = indexPrice;
  }

  /**
   * @notice Validate encoded payload and return `IndexPrice` struct
   *
   * https://docs.chain.link/data-streams/tutorials/evm-onchain-report-verification#examine-the-code
   */
  function validateIndexPricePayload(bytes calldata payload) public override onlyExchange returns (IndexPrice memory) {
    IndexPrice memory indexPrice = _validateIndexPricePayload(payload);

    latestIndexPriceByBaseAssetSymbol[indexPrice.baseAssetSymbol] = indexPrice;

    return indexPrice;
  }

  function _validateIndexPricePayload(bytes calldata payload) private returns (IndexPrice memory) {
    // Extract reportData and schema version
    (, bytes memory reportData) = abi.decode(payload, (bytes32[3], bytes));
    uint16 reportVersion = (uint16(uint8(reportData[0])) << 8) | uint16(uint8(reportData[1]));

    // Katana does not have a FeeManager and no funding is needed to verify
    // reports. Validate no FeeManager is set as a sanity check
    require(verifier.s_feeManager() == address(0), "FeeManager not supported");
    bytes memory verified = verifier.verify(payload, bytes(""));

    // Decode report by version-specific schema
    bytes32 feedId;
    uint32 validFromTimestamp;
    int192 price;
    if (reportVersion == 3) {
      // Crypto Advanced
      ReportV3 memory report = abi.decode(verified, (ReportV3));
      feedId = report.feedId;
      validFromTimestamp = report.validFromTimestamp;
      price = report.price;
    } else if (reportVersion == 8) {
      // RWA Standard
      ReportV8 memory report = abi.decode(verified, (ReportV8));
      feedId = report.feedId;
      validFromTimestamp = report.validFromTimestamp;
      price = report.midPrice;
    } else if (reportVersion == 10) {
      // Tokenized Asset
      ReportV10 memory report = abi.decode(verified, (ReportV10));
      feedId = report.feedId;
      validFromTimestamp = report.validFromTimestamp;
      price = report.tokenizedPrice;
    } else if (reportVersion == 11) {
      // RWA Advanced
      ReportV11 memory report = abi.decode(verified, (ReportV11));
      feedId = report.feedId;
      validFromTimestamp = report.validFromTimestamp;
      price = report.lastTradedPrice;
    } else {
      revert("Unsupported report version");
    }

    require(price > 0, "Unexpected non-positive price");

    ChainlinkDataStreamsMarket memory market = marketsByFeedId[feedId];
    require(market.exists, "Unknown feed ID");

    // Cross-validate that the report version matches the version encoded in the feed ID
    require(reportVersion == uint16(bytes2(feedId)), "Report version mismatch");

    uint64 priceInPips = AssetUnitConversions.assetUnitsToPips(SafeCast.toUint256(price), market.decimals) *
      market.priceMultiplier;

    return
      IndexPrice({
        baseAssetSymbol: market.baseAssetSymbol,
        timestampInMs: SafeCast.toUint64(validFromTimestamp) * 1000,
        price: priceInPips
      });
  }

  function _isActive() private view returns (bool) {
    return address(exchange) != address(0x0);
  }
}
