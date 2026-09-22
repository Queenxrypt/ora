import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  type Abi,
  type Hex,
} from "viem";
import type { ExecutableQuote } from "../../types/ora";
import exchangeAbiJson from "./abi/exchange.json";
import { atomsToUnits, unitsToAtoms } from "./market";
import {
  CONTRACTS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC,
  TOKEN_DECIMALS,
} from "./contracts";

export const exchangeAbi = exchangeAbiJson as Abi;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [ROBINHOOD_RPC] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

export const erc20Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export function publicClient() {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(ROBINHOOD_RPC),
  });
}

export type ChainQuote = {
  creditOut: bigint;
  usdgSpent: bigint;
  feeAtoms: bigint;
  fills: bigint;
  reason: number;
};

export async function quoteForCredit(
  requestedCredit: number,
): Promise<ExecutableQuote> {
  const client = publicClient();
  const [maxFills, quote] = await Promise.all([
    client.readContract({
      address: CONTRACTS.exchange,
      abi: exchangeAbi,
      functionName: "MAX_FILLS",
    }) as Promise<bigint>,
    client.readContract({
      address: CONTRACTS.exchange,
      abi: exchangeAbi,
      functionName: "getQuoteForCredit",
      args: [unitsToAtoms(requestedCredit), 32n],
    }) as Promise<ChainQuote>,
  ]);

  const creditOut = atomsToUnits(quote.creditOut);
  const usdgSpent = atomsToUnits(quote.usdgSpent);
  const feeAtoms = atomsToUnits(quote.feeAtoms);
  const totalUsdg = Number((usdgSpent + feeAtoms).toFixed(6));
  const quotePrice =
    creditOut > 0 ? Number((totalUsdg / creditOut).toFixed(6)) : 0;
  const discountPercent = Number(((1 - quotePrice) * 100).toFixed(4));
  const usdgIn = unitsToAtoms(totalUsdg);

  return {
    quotedAt: new Date().toISOString(),
    requestedCredit,
    creditOut,
    usdgSpent,
    feeAtoms,
    totalUsdg,
    fills: Number(quote.fills),
    reason: Number(quote.reason),
    quotePrice,
    discountPercent,
    minCreditOut: unitsToAtoms(creditOut * 0.98) > 0n
      ? Number(unitsToAtoms(creditOut * 0.98))
      : Number(quote.creditOut),
    usdgIn: Number(usdgIn),
    maxFills: Number(maxFills > 32n ? 32n : maxFills),
  };
}

export function beneficiaryBytes32(address: `0x${string}`): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
}

export function decimals(): number {
  return TOKEN_DECIMALS;
}

export { decodeEventLog };
