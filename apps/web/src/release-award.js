import {
  AVALANCHE_ESCROW_STATE,
  assertVerifiedDeliveryBeforeRelease,
  canRelease,
  createProcurementContext,
  deriveProcurementStatus,
} from "@shadowbid/shared/procurement";

import { EscrowTermsHashMismatchError } from "./fund-award.js";

export { EscrowTermsHashMismatchError };

/** A NONE or REFUNDED escrow: no write is ever attempted in this case. */
export class EscrowReleaseConflictError extends Error {
  constructor(message, { procurementId, escrowState }) {
    super(message);
    this.name = "EscrowReleaseConflictError";
    this.procurementId = procurementId;
    this.escrowState = escrowState;
  }
}

/** Thrown when the release transaction itself fails. */
export class ReleaseError extends Error {
  constructor(message, { cause, procurementId }) {
    super(message, { cause });
    this.name = "ReleaseError";
    this.procurementId = procurementId;
  }
}

/**
 * Releases the real ShadowBidEscrow to the Seller for a verified-delivered
 * Award commitment. `commitment` is the same {procurementId, seller, token,
 * amount, termsHash, deadline} shape produced by fund-award.js's
 * readAwardCommitmentInputs — reused here rather than reconstructed again.
 * `context` is the Slice 4A ProcurementContext produced by Slice 4E's
 * buildDeliveredContext: its deliverableVerified flag gates release before
 * any network call happens at all.
 *
 * Always reads the escrow first — a retry (this function called again after
 * any failure) never blindly sends a second release transaction:
 *
 * - FUNDED (termsHash matches) → checks Seller balance, releases, verifies
 *   the exact delta, then reads the escrow back.
 * - FUNDED (termsHash mismatch) → EscrowTermsHashMismatchError, no write.
 * - RELEASED                    → resumes successfully without writing.
 * - NONE/REFUNDED                → EscrowReleaseConflictError, no write.
 */
export async function releaseAward({
  publicClient,
  walletClient,
  escrowAddress,
  escrowAbi,
  usdcAddress,
  usdcAbi,
  commitment,
  context,
  onStage = () => {},
}) {
  onStage("Preparing transaction");
  assertVerifiedDeliveryBeforeRelease(context);

  const stored = await publicClient.readContract({
    address: escrowAddress,
    abi: escrowAbi,
    functionName: "getEscrow",
    args: [commitment.procurementId],
  });
  const state = Number(stored.state);

  if (state === AVALANCHE_ESCROW_STATE.RELEASED) {
    onStage("Settled");
    return Object.freeze({
      procurementId: commitment.procurementId,
      escrowState: state,
      resumedAlreadyReleased: true,
      releaseTxHash: undefined,
      sellerBalanceBefore: undefined,
      sellerBalanceAfter: undefined,
      balanceDelta: undefined,
      stored,
      status: deriveProcurementStatus(
        createProcurementContext({
          ...context,
          token: commitment.token,
          amount: commitment.amount,
          deadline: commitment.deadline,
          termsHash: commitment.termsHash,
          escrowState: state,
        }),
      ),
    });
  }

  if (!canRelease(state)) {
    throw new EscrowReleaseConflictError(
      `Escrow ${commitment.procurementId} is in state ${state} (NONE or REFUNDED); cannot release`,
      { procurementId: commitment.procurementId, escrowState: state },
    );
  }

  if (stored.termsHash !== commitment.termsHash) {
    throw new EscrowTermsHashMismatchError(commitment.procurementId, {
      storedTermsHash: stored.termsHash,
      computedTermsHash: commitment.termsHash,
    });
  }

  const sellerBalanceBefore = await publicClient.readContract({
    address: usdcAddress,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [commitment.seller],
  });

  let releaseTxHash;
  let releaseReceipt;
  try {
    const simulation = await publicClient.simulateContract({
      account: walletClient.account,
      address: escrowAddress,
      abi: escrowAbi,
      functionName: "release",
      args: [commitment.procurementId],
    });
    onStage("Confirm in wallet");
    releaseTxHash = await walletClient.writeContract(simulation.request);
    onStage("Waiting for Fuji");
    releaseReceipt = await publicClient.waitForTransactionReceipt({ hash: releaseTxHash });
    if (releaseReceipt.status !== "success") {
      throw new Error("Release transaction reverted");
    }
  } catch (error) {
    throw new ReleaseError("Escrow release failed", { cause: error, procurementId: commitment.procurementId });
  }

  const [storedAfter, sellerBalanceAfter] = await Promise.all([
    publicClient.readContract({
      address: escrowAddress,
      abi: escrowAbi,
      functionName: "getEscrow",
      args: [commitment.procurementId],
      blockNumber: releaseReceipt.blockNumber,
    }),
    publicClient.readContract({
      address: usdcAddress,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [commitment.seller],
      blockNumber: releaseReceipt.blockNumber,
    }),
  ]);

  const escrowStateAfter = Number(storedAfter.state);

  onStage("Settled");

  return Object.freeze({
    procurementId: commitment.procurementId,
    escrowState: escrowStateAfter,
    resumedAlreadyReleased: false,
    releaseTxHash,
    sellerBalanceBefore,
    sellerBalanceAfter,
    balanceDelta: sellerBalanceAfter - sellerBalanceBefore,
    stored: storedAfter,
    status: deriveProcurementStatus(
      createProcurementContext({
        ...context,
        token: commitment.token,
        amount: commitment.amount,
        deadline: commitment.deadline,
        termsHash: commitment.termsHash,
        escrowState: escrowStateAfter,
      }),
    ),
  });
}
