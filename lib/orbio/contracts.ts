export const ROBINHOOD_CHAIN_ID = 4663;

const DEFAULT_ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";

export function robinhoodRpcUrl(): string {
  const configured = process.env.ROBINHOOD_RPC_URL?.trim();
  return configured || DEFAULT_ROBINHOOD_RPC;
}

export const ORBIO_MARKET_ORIGIN =
  process.env.ORBIO_MARKET_ORIGIN ?? "https://www.orbio.so";

export const CONTRACTS = {
  credit: "0xe33322da1380e61e5ae5dfb21e7f62924c73004c",
  staking: "0xe0710011278bfb63e57c5f227e5980984b1eddca",
  exchange: "0x6951ffd32630b05e06f50062aea801625a58ebc0",
  payout: "0x4cbbbf652b11ed1294df0ac49d8322394310cfc5",
  orbio: "0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3",
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  nvda: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
} as const;

export const TOKEN_DECIMALS = 6;
export const ATOMS = 1_000_000;
