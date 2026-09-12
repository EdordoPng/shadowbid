import { queryAwardById } from "@shadowbid/shared/arkiv";
import { buildEscrowCommitmentInput } from "@shadowbid/shared/commitment";
import { AVALANCHE_ESCROW_STATE, canFund, isFundedWithMatchingTerms } from "@shadowbid/shared/procurement";

import { readBackBuyerRequest } from "./buyer-request.js";

/** A RELEASED/REFUNDED escrow, or a FUNDED one with an unexpected termsHash
 * that isn't a safe retry-resume: no write is ever attempted in this case. */
export class EscrowFundingConflictError extends Error {
  constructor(message, { procurementId, escrowState }) {
    super(message);
    this.name = "EscrowFundingConflictError";
    this.procurementId = procurementId;
    this.escrowState = escrowState;
  }
}

/** The escrow is FUNDED but its stored termsHash does not match the
 * commitment computed from the real Award/RFQ — a hard invariant failure. */
export class EscrowTermsHashMismatchError extends Error {
  constructor(procurementId, { storedTermsHash, computedTermsHash }) {
    super(
      `Escrow ${procurementId} is FUNDED with termsHash ${storedTermsHash}, which does not match the computed commitment ${computedTermsHash}`,
    );
    this.name = "EscrowTermsHashMismatchError";
    this.procurementId = procurementId;
    this.storedTermsHash = storedTermsHash;
    this.computedTermsHash = computedTermsHash;
  }
}

/** Thrown when the approve or fund transaction itself fails. */
export class FundingError extends Error {
  constructor(message, { cause, procurementId }) {
    super(message, { cause });
    this.name = "FundingError";
    this.procurementId = procurementId;
  }
}

/**
 * Independently reconstructs the escrow commitment inputs (procurementId,
 * seller, token, amount, termsHash, deadline) from the real Arkiv Award and
 * its RFQ — never from a caller-supplied/hardcoded value. Uses the existing
 * shared `buildEscrowCommitmentInput` (which uses the existing
 * `deriveTermsHash`) unchanged: no ABI encoding here.
 */
export async function readAwardCommitmentInputs({ arkivPublicClient, awardId, token }) {
  const page = await queryAwardById(arkivPublicClient, { awardId });
  const awardEntity = page.entities[0];
  if (!awardEntity) {
    throw new Error(`Award ${awardId} could not be read back from Arkiv`);
  }

  const rfqId = awardEntity.attributes.rfq_id.value;
  const rfq = await readBackBuyerRequest({ arkivPublicClient, rfqId });
  if (!rfq) {
    throw new Error(`RFQ ${rfqId} referenced by Award ${awardId} could not be read back from Arkiv`);
  }
  if (rfq.specificationHash === undefined) {
    throw new Error(`RFQ ${rfqId} has no specificationHash linkage yet`);
  }

  const award = Object.freeze({
    awardId,
    rfqId,
    quoteId: awardEntity.attributes.quote_id.value,
    buyer: awardEntity.attributes.buyer.value,
    seller: awardEntity.attributes.seller.value,
    amount: awardEntity.attributes.amount.value,
    deadline: awardEntity.attributes.deadline.value,
    settlementAsset: awardEntity.attributes.settlement_asset.value,
  });

  return buildEscrowCommitmentInput({ award, token, specificationHash: rfq.specificationHash });
}

/**
 * Funds the real ShadowBidEscrow for a real Award commitment. Always reads
 * the escrow first — a retry (this function called again after any failure)
 * never blindly sends a second fund transaction:
 *
 * - NONE            → checks allowance, approves only if short, then funds.
 * - FUNDED (match)  → resumes successfully without writing anything.
 * - FUNDED (mismatch) → EscrowTermsHashMismatchError, no write.
 * - RELEASED/REFUNDED → EscrowFundingConflictError, no write.
 */
export async function fundAward({
  publicClient,
  walletClient,
  escrowAddress,
  escrowAbi,
  usdcAddress,
  usdcAbi,
  commitment,
}) {
  const buyerAddress = walletClient.account.address;

  const stored = await publicClient.readContract({
    address: escrowAddress,
    abi: escrowAbi,
    functionName: "getEscrow",
    args: [commitment.procurementId],
  });
  const state = Number(stored.state);

  if (state === AVALANCHE_ESCROW_STATE.FUNDED) {
    if (!isFundedWithMatchingTerms(state, stored.termsHash, commitment.termsHash)) {
      throw new EscrowTermsHashMismatchError(commitment.procurementId, {
        storedTermsHash: stored.termsHash,
        computedTermsHash: commitment.termsHash,
      });
    }

    return Object.freeze({
      procurementId: commitment.procurementId,
      computedTermsHash: commitment.termsHash,
      storedTermsHash: stored.termsHash,
      escrowState: state,
      resumedAlreadyFunded: true,
      allowanceBefore: undefined,
      allowanceAfter: undefined,
      approveTxHash: undefined,
      fundingTxHash: undefined,
      stored,
    });
  }

  if (!canFund(state)) {
    throw new EscrowFundingConflictError(
      `Escrow ${commitment.procurementId} is in state ${state} (RELEASED or REFUNDED); cannot fund`,
      { procurementId: commitment.procurementId, escrowState: state },
    );
  }

  const allowanceBefore = await publicClient.readContract({
    address: usdcAddress,
    abi: usdcAbi,
    functionName: "allowance",
    args: [buyerAddress, escrowAddress],
  });

  let approveTxHash;
  let allowanceAfter = allowanceBefore;
  if (allowanceBefore < commitment.amount) {
    try {
      const simulation = await publicClient.simulateContract({
        account: walletClient.account,
        address: usdcAddress,
        abi: usdcAbi,
        functionName: "approve",
        args: [escrowAddress, commitment.amount],
      });
      approveTxHash = await walletClient.writeContract(simulation.request);
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
      if (approveReceipt.status !== "success") {
        throw new Error("USDC approve transaction reverted");
      }
      allowanceAfter = await publicClient.readContract({
        address: usdcAddress,
        abi: usdcAbi,
        functionName: "allowance",
        args: [buyerAddress, escrowAddress],
        blockNumber: approveReceipt.blockNumber,
      });
    } catch (error) {
      throw new FundingError("USDC approve failed", { cause: error, procurementId: commitment.procurementId });
    }
  }
  if (allowanceAfter < commitment.amount) {
    throw new FundingError("Escrow allowance does not cover the Award amount", {
      procurementId: commitment.procurementId,
    });
  }

  let fundingTxHash;
  let fundingReceipt;
  try {
    const simulation = await publicClient.simulateContract({
      account: walletClient.account,
      address: escrowAddress,
      abi: escrowAbi,
      functionName: "fund",
      args: [
        commitment.procurementId,
        commitment.seller,
        commitment.token,
        commitment.amount,
        commitment.termsHash,
        commitment.deadline,
      ],
    });
    fundingTxHash = await walletClient.writeContract(simulation.request);
    fundingReceipt = await publicClient.waitForTransactionReceipt({ hash: fundingTxHash });
    if (fundingReceipt.status !== "success") {
      throw new Error("Fund transaction reverted");
    }
  } catch (error) {
    throw new FundingError("Escrow fund failed", { cause: error, procurementId: commitment.procurementId });
  }

  const storedAfterFunding = await publicClient.readContract({
    address: escrowAddress,
    abi: escrowAbi,
    functionName: "getEscrow",
    args: [commitment.procurementId],
    blockNumber: fundingReceipt.blockNumber,
  });

  return Object.freeze({
    procurementId: commitment.procurementId,
    computedTermsHash: commitment.termsHash,
    storedTermsHash: storedAfterFunding.termsHash,
    escrowState: Number(storedAfterFunding.state),
    resumedAlreadyFunded: false,
    allowanceBefore,
    allowanceAfter,
    approveTxHash,
    fundingTxHash,
    stored: storedAfterFunding,
  });
}
