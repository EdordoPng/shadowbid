import { AVALANCHE_ESCROW_STATE } from '@shadowbid/shared/procurement';

import { EscrowTermsHashMismatchError } from './fund-award.js';

export { EscrowTermsHashMismatchError };

/** A NONE or RELEASED escrow: no write is ever attempted in this case. */
export class EscrowRefundConflictError extends Error {
  constructor(message, { procurementId, escrowState }) {
    super(message);
    this.name = 'EscrowRefundConflictError';
    this.procurementId = procurementId;
    this.escrowState = escrowState;
  }
}

/** Thrown when the refund transaction itself fails. */
export class RefundError extends Error {
  constructor(message, { cause, procurementId }) {
    super(message, { cause });
    this.name = 'RefundError';
    this.procurementId = procurementId;
  }
}

/**
 * Refunds the real ShadowBidEscrow to the Buyer once its deadline has
 * passed. `commitment` is the same {procurementId, seller, token, amount,
 * termsHash, deadline} shape produced by fund-award.js's
 * readAwardCommitmentInputs / read back from a FUNDED escrow.
 *
 * The contract remains the sole authority on the deadline: this function
 * never gates on a locally computed "now" — it only simulates the call and
 * lets Fuji accept or revert it. UI-side deadline gating is a visibility
 * convenience only.
 *
 * Always reads the escrow first — a retry (this function called again after
 * any failure) never blindly sends a second refund transaction:
 *
 * - FUNDED (termsHash matches) → simulates, sends refundAfterDeadline,
 *   verifies the exact Buyer balance delta, then reads the escrow back.
 * - FUNDED (termsHash mismatch) → EscrowTermsHashMismatchError, no write.
 * - REFUNDED                    → resumes successfully without writing.
 * - NONE/RELEASED               → EscrowRefundConflictError, no write.
 */
export async function refundAward({
  publicClient,
  walletClient,
  escrowAddress,
  escrowAbi,
  usdcAddress,
  usdcAbi,
  commitment,
  onStage = () => {},
}) {
  onStage('Preparing transaction');

  const stored = await publicClient.readContract({
    address: escrowAddress,
    abi: escrowAbi,
    functionName: 'getEscrow',
    args: [commitment.procurementId],
  });
  const state = Number(stored.state);

  if (state === AVALANCHE_ESCROW_STATE.REFUNDED) {
    onStage('Refunded');
    return Object.freeze({
      procurementId: commitment.procurementId,
      escrowState: state,
      resumedAlreadyRefunded: true,
      refundTxHash: undefined,
      buyerBalanceBefore: undefined,
      buyerBalanceAfter: undefined,
      balanceDelta: undefined,
      stored,
    });
  }

  if (state !== AVALANCHE_ESCROW_STATE.FUNDED) {
    throw new EscrowRefundConflictError(
      `Escrow ${commitment.procurementId} is in state ${state} (NONE or RELEASED); cannot refund`,
      { procurementId: commitment.procurementId, escrowState: state },
    );
  }

  if (stored.termsHash !== commitment.termsHash) {
    throw new EscrowTermsHashMismatchError(commitment.procurementId, {
      storedTermsHash: stored.termsHash,
      computedTermsHash: commitment.termsHash,
    });
  }

  const buyerBalanceBefore = await publicClient.readContract({
    address: usdcAddress,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [stored.buyer],
  });

  let refundTxHash;
  let refundReceipt;
  try {
    const simulation = await publicClient.simulateContract({
      account: walletClient.account,
      address: escrowAddress,
      abi: escrowAbi,
      functionName: 'refundAfterDeadline',
      args: [commitment.procurementId],
    });
    onStage('Confirm in wallet');
    refundTxHash = await walletClient.writeContract(simulation.request);
    onStage('Waiting for Fuji');
    refundReceipt = await publicClient.waitForTransactionReceipt({ hash: refundTxHash });
    if (refundReceipt.status !== 'success') {
      throw new Error('Refund transaction reverted');
    }
  } catch (error) {
    throw new RefundError('Escrow refund failed', { cause: error, procurementId: commitment.procurementId });
  }

  const [storedAfter, buyerBalanceAfter] = await Promise.all([
    publicClient.readContract({
      address: escrowAddress,
      abi: escrowAbi,
      functionName: 'getEscrow',
      args: [commitment.procurementId],
      blockNumber: refundReceipt.blockNumber,
    }),
    publicClient.readContract({
      address: usdcAddress,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [stored.buyer],
      blockNumber: refundReceipt.blockNumber,
    }),
  ]);

  onStage('Refunded');

  return Object.freeze({
    procurementId: commitment.procurementId,
    escrowState: Number(storedAfter.state),
    resumedAlreadyRefunded: false,
    refundTxHash,
    buyerBalanceBefore,
    buyerBalanceAfter,
    balanceDelta: buyerBalanceAfter - buyerBalanceBefore,
    stored: storedAfter,
  });
}
