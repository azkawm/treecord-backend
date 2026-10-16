// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 6-decimal test stablecoin with open minting. Used by tests and by the anvil deployment.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "USDC") {}

    /// @notice USDC uses 6 decimals.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints test tokens to anyone. Never deploy this outside local and test networks.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
