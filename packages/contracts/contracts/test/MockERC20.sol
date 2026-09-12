// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockERC20 {
    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[sender][msg.sender];
        require(allowed >= amount, "insufficient allowance");
        allowance[sender][msg.sender] = allowed - amount;
        _transfer(sender, recipient, amount);
        return true;
    }

    function _transfer(address sender, address recipient, uint256 amount) private {
        uint256 balance = balanceOf[sender];
        require(balance >= amount, "insufficient balance");
        balanceOf[sender] = balance - amount;
        balanceOf[recipient] += amount;
    }
}
