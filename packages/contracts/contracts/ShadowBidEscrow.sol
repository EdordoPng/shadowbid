// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract ShadowBidEscrow {
    enum EscrowState {
        NONE,
        FUNDED,
        RELEASED,
        REFUNDED
    }

    struct Escrow {
        address buyer;
        address seller;
        address token;
        uint256 amount;
        bytes32 termsHash;
        uint64 deadline;
        EscrowState state;
    }

    error InvalidProcurementId();
    error InvalidSeller();
    error InvalidToken();
    error InvalidAmount();
    error InvalidTermsHash();
    error InvalidDeadline();
    error EscrowAlreadyExists(bytes32 procurementId);
    error EscrowNotFunded(bytes32 procurementId);
    error OnlyBuyer(address caller, address buyer);
    error TokenHasNoCode(address token);
    error TokenTransferFailed(address token);

    event Funded(
        bytes32 indexed procurementId,
        address indexed buyer,
        address indexed seller,
        address token,
        uint256 amount,
        bytes32 termsHash,
        uint64 deadline
    );
    event Released(
        bytes32 indexed procurementId,
        address indexed buyer,
        address indexed seller,
        address token,
        uint256 amount
    );
    event Refunded(
        bytes32 indexed procurementId,
        address indexed buyer,
        address indexed caller,
        address token,
        uint256 amount
    );

    mapping(bytes32 procurementId => Escrow escrow) private _escrows;

    function fund(
        bytes32 procurementId,
        address seller,
        address token,
        uint256 amount,
        bytes32 termsHash,
        uint64 deadline
    ) external {
        if (procurementId == bytes32(0)) revert InvalidProcurementId();
        if (seller == address(0)) revert InvalidSeller();
        if (token == address(0)) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();
        if (termsHash == bytes32(0)) revert InvalidTermsHash();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        if (_escrows[procurementId].state != EscrowState.NONE) {
            revert EscrowAlreadyExists(procurementId);
        }
        if (token.code.length == 0) revert TokenHasNoCode(token);

        _escrows[procurementId] = Escrow({
            buyer: msg.sender,
            seller: seller,
            token: token,
            amount: amount,
            termsHash: termsHash,
            deadline: deadline,
            state: EscrowState.FUNDED
        });

        _safeTransferFrom(token, msg.sender, address(this), amount);

        emit Funded(procurementId, msg.sender, seller, token, amount, termsHash, deadline);
    }

    function release(bytes32 procurementId) external {
        Escrow storage escrow = _escrows[procurementId];
        if (escrow.state != EscrowState.FUNDED) revert EscrowNotFunded(procurementId);
        if (msg.sender != escrow.buyer) revert OnlyBuyer(msg.sender, escrow.buyer);

        escrow.state = EscrowState.RELEASED;
        _safeTransfer(escrow.token, escrow.seller, escrow.amount);

        emit Released(
            procurementId,
            escrow.buyer,
            escrow.seller,
            escrow.token,
            escrow.amount
        );
    }

    function refundAfterDeadline(bytes32 procurementId) external {
        Escrow storage escrow = _escrows[procurementId];
        if (escrow.state != EscrowState.FUNDED) revert EscrowNotFunded(procurementId);
        if (block.timestamp < escrow.deadline) revert InvalidDeadline();

        escrow.state = EscrowState.REFUNDED;
        _safeTransfer(escrow.token, escrow.buyer, escrow.amount);

        emit Refunded(procurementId, escrow.buyer, msg.sender, escrow.token, escrow.amount);
    }

    function getEscrow(bytes32 procurementId) external view returns (Escrow memory) {
        return _escrows[procurementId];
    }

    function _safeTransfer(address token, address recipient, uint256 amount) private {
        _callToken(token, abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), recipient, amount));
    }

    function _safeTransferFrom(address token, address sender, address recipient, uint256 amount) private {
        _callToken(
            token,
            abi.encodeWithSelector(
                bytes4(keccak256("transferFrom(address,address,uint256)")),
                sender,
                recipient,
                amount
            )
        );
    }

    function _callToken(address token, bytes memory callData) private {
        (bool success, bytes memory returnData) = token.call(callData);
        if (
            !success ||
            (returnData.length != 0 &&
                (returnData.length != 32 || !abi.decode(returnData, (bool))))
        ) {
            revert TokenTransferFailed(token);
        }
    }
}
