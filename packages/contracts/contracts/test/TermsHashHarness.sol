// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract TermsHashHarness {
    function hashTerms(
        uint256 version,
        bytes32 rfqId,
        bytes32 quoteId,
        bytes32 awardId,
        address buyer,
        address seller,
        address token,
        uint256 amount,
        uint64 deadline,
        bytes32 specificationHash
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encode(
                version,
                rfqId,
                quoteId,
                awardId,
                buyer,
                seller,
                token,
                amount,
                deadline,
                specificationHash
            )
        );
    }
}
