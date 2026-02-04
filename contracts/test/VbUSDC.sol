// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// solhint-disable-next-line contract-name-capwords
contract VbUSDC is ERC20 {
  address public asset;

  uint256 public redeemFee;

  constructor(address asset_) ERC20("vbUSDC", "vbUSDC") {
    asset = asset_;
  }

  function decimals() public view virtual override returns (uint8) {
    return 6;
  }

  function transfer(address recipient, uint256 amount) public virtual override returns (bool) {
    _transfer(_msgSender(), recipient, amount);

    return true;
  }

  function transferFrom(address sender, address recipient, uint256 amount) public virtual override returns (bool) {
    address spender = _msgSender();
    _spendAllowance(sender, spender, amount);
    _transfer(sender, recipient, amount - redeemFee);

    return true;
  }

  function setRedeemFee(uint256 redeemFee_) public {
    redeemFee = redeemFee_;
  }

  // ERC-4626

  function deposit(uint256 assets, address receiver) public returns (uint256) {
    IERC20(asset).transferFrom(msg.sender, address(this), assets);
    _mint(receiver, assets);

    return assets;
  }

  function redeem(uint256 shares, address receiver, address owner) public returns (uint256) {
    transferFrom(owner, address(this), shares);
    _burn(address(this), shares);

    IERC20(asset).transfer(receiver, shares);

    return shares;
  }

  function previewRedeem(uint256 shares) public view returns (uint256) {
    return shares - redeemFee;
  }
}
