// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import {
  PrimaryProdDataServiceConsumerBase
} from "@redstone-finance/evm-connector/contracts/data-services/PrimaryProdDataServiceConsumerBase.sol";

import { Address } from "../libraries/Address.sol";
import { IndexPrice } from "../libraries/Structs.sol";
import { Owned } from "../Owned.sol";
import { String } from "../libraries/String.sol";
import { IExchange, IIndexPriceAdapter } from "../libraries/Interfaces.sol";

struct RedStoneMarket {
  bool exists;
  string baseAssetSymbol;
  bytes32 dataFeedId;
  uint64 priceMultiplier;
}

contract RedStoneIndexPriceAdapter is IIndexPriceAdapter, Owned, PrimaryProdDataServiceConsumerBase {
  // Address whitelisted to call `setActive`
  address public immutable activator;
  // Mapping of Redstone data feed IDs to market structs. The IDs are constructed as bytes32
  // representations of the base asset symbol, e.g. bytes32("ETH")
  mapping(bytes32 => RedStoneMarket) public marketsByDataFeedId;
  // Address of Exchange contract
  IExchange public exchange;
  // Mapping of market base asset symbols to market structs
  mapping(string => RedStoneMarket) public marketsByBaseAssetSymbol;

  /**
   * @notice Instantiate a new `RedstoneIndexPriceAdapter` contract
   *
   * @param activator_ Address whitelisted to call `setActive`
   * @param baseAssetSymbols List of base asset symbols to associate with price IDs
   * @param dataFeedIds List of price IDs to associate with base asset symbols
   * @param priceMultipliers List of price multipliers to use when loading the price for a market
   */
  constructor(
    address activator_,
    string[] memory baseAssetSymbols,
    bytes32[] memory dataFeedIds,
    uint64[] memory priceMultipliers
  ) Owned() {
    require(activator_ != address(0x0), "Invalid activator address");
    activator = activator_;

    require(
      baseAssetSymbols.length == dataFeedIds.length && dataFeedIds.length == priceMultipliers.length,
      "Argument length mismatch"
    );

    for (uint8 i = 0; i < baseAssetSymbols.length; i++) {
      addMarket(baseAssetSymbols[i], dataFeedIds[i], priceMultipliers[i]);
    }
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
   * @param dataFeedId The RedStone data feed ID
   * @param priceMultiplier The price multiplier to use when loading the price for a market. If
   * greater than 1, the base asset symbol must include the price multiplier as a prefix
   */
  function addMarket(string memory baseAssetSymbol, bytes32 dataFeedId, uint64 priceMultiplier) public onlyAdmin {
    require(dataFeedId != bytes32(0x0), "Invalid data feed ID");
    require(!marketsByDataFeedId[dataFeedId].exists, "Already added data feed ID");

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

    RedStoneMarket memory redStoneMarket = RedStoneMarket({
      exists: true,
      baseAssetSymbol: baseAssetSymbol,
      dataFeedId: dataFeedId,
      priceMultiplier: priceMultiplier
    });

    marketsByDataFeedId[dataFeedId] = redStoneMarket;
    marketsByBaseAssetSymbol[baseAssetSymbol] = redStoneMarket;
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
   */
  function validateIndexPricePayload(
    bytes calldata payload
  ) public view override onlyExchange returns (IndexPrice memory) {
    // Decode data feed ID prefix and box in array
    bytes32 dataFeedId = abi.decode(payload, (bytes32));
    bytes32[] memory dataFeedIds = new bytes32[](1);
    dataFeedIds[0] = dataFeedId;

    RedStoneMarket memory market = marketsByDataFeedId[dataFeedId];
    require(market.exists, "Unknown price ID");

    (uint256[] memory values, uint256 timestamp) = getOracleNumericValuesAndTimestampFromTxMsg(dataFeedIds);
    // RedStone market feeds are always 8 decimals so no conversion necessary
    uint64 priceInPips = SafeCast.toUint64(values[0]) * market.priceMultiplier;

    return
      IndexPrice({
        baseAssetSymbol: market.baseAssetSymbol,
        timestampInMs: SafeCast.toUint64(timestamp),
        price: priceInPips
      });
  }

  function _isActive() private view returns (bool) {
    return address(exchange) != address(0x0);
  }
}
