import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  parseAbiItem,
  toEventSelector,
  toFunctionSelector,
  type AbiEvent,
  type AbiFunction,
  type Hex,
} from "viem";
import { normalizeWalletAddress } from "../ora/wallet";
import { CONTRACTS } from "./contracts";
import { beneficiaryBytes32, exchangeAbi } from "./exchange";
import { atomsToUnits, unitsToAtoms } from "./market";

const buyAndActivateItem = exchangeAbi.find(
  (item): item is AbiFunction =>
    item.type === "function" && item.name === "buyAndActivate",
);
const boughtItem = exchangeAbi.find(
  (item): item is AbiEvent => item.type === "event" && item.name === "Bought",
);
if (!buyAndActivateItem || !boughtItem) {
  throw new Error("Exchange ABI is missing buyAndActivate or Bought.");
}

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export const BUY_AND_ACTIVATE_SELECTOR = toFunctionSelector(buyAndActivateItem);
export const BOUGHT_TOPIC = toEventSelector(boughtItem);
export const TRANSFER_TOPIC = toEventSelector(transferEvent);

export type ChainTransaction = {
  from: string;
  to: string | null;
  input: Hex;
};

export type ChainLog = {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  removed?: boolean;
};

export type ChainReceipt = {
  status: "success" | "reverted";
  from: string;
  to: string | null;
  logs: readonly ChainLog[];
};

export type ReceiptRejectionCode =
  | "sender"
  | "destination"
  | "selector"
  | "calldata"
  | "beneficiary"
  | "unvalidated"
  | "amount"
  | "block"
  | "reverted"
  | "event"
  | "empty"
  | "transfer";

export type ReceiptRejection = {
  ok: false;
  code: ReceiptRejectionCode;
  error: string;
};

export type BuyAndActivateCall = {
  usdgIn: bigint;
  minCreditOut: bigint;
  beneficiary: Hex;
  maxFills: bigint;
};

export type VerifiedExecution = {
  creditAtoms: bigint;
  usdgPaidAtoms: bigint;
  fills: bigint;
  creditAcquired: number;
  totalUsdgPaid: number;
  executionPrice: number;
};

function reject(code: ReceiptRejectionCode, error: string): ReceiptRejection {
  return { ok: false, code, error };
}

const exchange = normalizeWalletAddress(CONTRACTS.exchange)!;
const usdg = normalizeWalletAddress(CONTRACTS.usdg)!;

/** Proves the transaction is this wallet calling Orbio's buyAndActivate, and decodes it. */
export function verifyBuyAndActivateCall(
  tx: ChainTransaction,
  wallet: string,
): { ok: true; call: BuyAndActivateCall } | ReceiptRejection {
  const owner = normalizeWalletAddress(wallet);
  if (!owner || normalizeWalletAddress(tx.from) !== owner) {
    return reject("sender", "Transaction sender does not match this wallet.");
  }
  if (normalizeWalletAddress(tx.to) !== exchange) {
    return reject("destination", "Transaction is not sent to the Orbio exchange.");
  }
  const input = typeof tx.input === "string" ? tx.input.toLowerCase() as Hex : "0x";
  if (input.slice(0, 10) !== BUY_AND_ACTIVATE_SELECTOR) {
    return reject("selector", "Transaction is not a buyAndActivate call.");
  }

  let args: readonly unknown[];
  try {
    const decoded = decodeFunctionData({ abi: exchangeAbi, data: input });
    if (decoded.functionName !== "buyAndActivate" || !decoded.args) {
      return reject("selector", "Transaction is not a buyAndActivate call.");
    }
    args = decoded.args;
    const reencoded = encodeFunctionData({
      abi: exchangeAbi,
      functionName: "buyAndActivate",
      args,
    });
    if (reencoded.toLowerCase() !== input) {
      return reject("calldata", "buyAndActivate calldata is not canonical.");
    }
  } catch {
    return reject("calldata", "buyAndActivate calldata could not be decoded.");
  }

  const [usdgIn, minCreditOut, beneficiary, maxFills] = args as [
    bigint,
    bigint,
    Hex,
    bigint,
  ];
  return {
    ok: true,
    call: {
      usdgIn,
      minCreditOut,
      beneficiary: beneficiary.toLowerCase() as Hex,
      maxFills,
    },
  };
}

/** Ties the decoded call to the decision's wallet and its server-validated quote. */
export function checkCallMatchesDecision(
  call: BuyAndActivateCall,
  decision: { wallet: `0x${string}`; quotedUsdg?: number },
): { ok: true } | ReceiptRejection {
  if (call.beneficiary !== beneficiaryBytes32(decision.wallet)) {
    return reject("beneficiary", "buyAndActivate beneficiary is not this wallet.");
  }
  const quoted = decision.quotedUsdg;
  if (quoted == null || !Number.isFinite(quoted) || quoted <= 0) {
    return reject("unvalidated", "This decision has no validated quote to confirm against.");
  }
  if (call.usdgIn <= 0n || call.usdgIn !== unitsToAtoms(quoted)) {
    return reject("amount", "buyAndActivate USDG budget does not equal the validated quote.");
  }
  return { ok: true };
}

/** The purchase must be mined after the chain head Ora read when it validated the quote. */
export function checkMinedAfterValidation(
  blockNumber: bigint | null | undefined,
  validatedBlock: number | undefined,
): { ok: true } | ReceiptRejection {
  if (validatedBlock == null || !Number.isSafeInteger(validatedBlock) || validatedBlock < 0) {
    return reject("unvalidated", "This decision has no validated block to confirm against.");
  }
  if (blockNumber == null || blockNumber <= BigInt(validatedBlock)) {
    return reject("block", "Transaction was mined before this decision was validated.");
  }
  return { ok: true };
}

/**
 * Reads the purchase from the receipt: the exchange's single Bought event for this buyer,
 * cross-checked against the USDG actually debited from the wallet.
 */
export function deriveExecution(
  receipt: ChainReceipt,
  input: { wallet: `0x${string}`; call: BuyAndActivateCall },
): { ok: true; execution: VerifiedExecution } | ReceiptRejection {
  if (receipt.status !== "success") {
    return reject("reverted", "Transaction reverted or failed.");
  }
  const wallet = normalizeWalletAddress(input.wallet);
  if (!wallet || normalizeWalletAddress(receipt.from) !== wallet) {
    return reject("sender", "Receipt sender does not match this wallet.");
  }
  if (normalizeWalletAddress(receipt.to) !== exchange) {
    return reject("destination", "Receipt is not for the Orbio exchange.");
  }

  const live = receipt.logs.filter((log) => !log.removed);

  let bought: {
    buyer: string;
    recipient: string;
    creditOut: bigint;
    usdgSpent: bigint;
    feeAtoms: bigint;
    fills: bigint;
  }[];
  try {
    bought = live
      .filter(
        (log) =>
          normalizeWalletAddress(log.address) === exchange &&
          log.topics[0]?.toLowerCase() === BOUGHT_TOPIC,
      )
      .map(
        (log) =>
          decodeEventLog({
            abi: [boughtItem!],
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
            strict: true,
          }).args as unknown as (typeof bought)[number],
      );
  } catch {
    return reject("event", "Orbio Bought event could not be decoded.");
  }
  if (bought.length !== 1) {
    return reject("event", "Receipt does not contain exactly one Orbio Bought event.");
  }
  const purchase = bought[0];
  if (
    normalizeWalletAddress(purchase.buyer) !== wallet ||
    normalizeWalletAddress(purchase.recipient) !== exchange
  ) {
    return reject("event", "Bought event is not a buyAndActivate purchase by this wallet.");
  }
  if (purchase.creditOut <= 0n) {
    return reject("empty", "Transaction bought no CREDIT.");
  }
  if (purchase.creditOut < input.call.minCreditOut) {
    return reject("event", "Bought CREDIT is below the transaction's minimum.");
  }

  const usdgPaidAtoms = purchase.usdgSpent + purchase.feeAtoms;
  if (usdgPaidAtoms <= 0n || usdgPaidAtoms > input.call.usdgIn) {
    return reject("amount", "Bought USDG amount is outside the transaction's budget.");
  }

  let debited = 0n;
  try {
    for (const log of live) {
      if (normalizeWalletAddress(log.address) !== usdg) continue;
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      const { from, to, value } = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      }).args;
      if (normalizeWalletAddress(from) === wallet) debited += value;
      if (normalizeWalletAddress(to) === wallet) debited -= value;
    }
  } catch {
    return reject("transfer", "USDG Transfer log could not be decoded.");
  }
  if (debited !== usdgPaidAtoms) {
    return reject("transfer", "USDG debited from the wallet does not match the Bought event.");
  }

  const creditAcquired = atomsToUnits(purchase.creditOut);
  const totalUsdgPaid = atomsToUnits(usdgPaidAtoms);
  return {
    ok: true,
    execution: {
      creditAtoms: purchase.creditOut,
      usdgPaidAtoms,
      fills: purchase.fills,
      creditAcquired,
      totalUsdgPaid,
      executionPrice: Number((totalUsdgPaid / creditAcquired).toFixed(6)),
    },
  };
}
