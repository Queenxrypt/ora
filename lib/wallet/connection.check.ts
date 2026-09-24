import { readFileSync } from "node:fs";
import { ROBINHOOD_CHAIN_ID } from "../orbio/contracts";
import {
  CONNECTION_CANCELLED,
  INJECTED_WALLET_MISSING,
  WALLET_CONNECT_UNCONFIGURED,
  WALLET_UNAVAILABLE,
  isEvmAddress,
  isUserRejection,
  normalizeChainId,
  selectConnectionMethod,
  shouldApplyWalletConnectSession,
  walletErrorMessage,
} from "./connection";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(
  selectConnectionMethod({
    hasInjectedProvider: true,
    hasWalletConnect: true,
  }) === "injected",
  "desktop injected wallet must stay on the injected path",
);
assert(
  selectConnectionMethod({
    hasInjectedProvider: false,
    hasWalletConnect: true,
  }) === "walletconnect",
  "mobile without an injected provider must use WalletConnect",
);
assert(
  selectConnectionMethod({
    hasInjectedProvider: false,
    hasWalletConnect: false,
  }) === "unavailable",
  "missing both paths is unavailable",
);
assert(
  WALLET_UNAVAILABLE !== INJECTED_WALLET_MISSING &&
    WALLET_CONNECT_UNCONFIGURED !== INJECTED_WALLET_MISSING,
  "the mobile dead-end must not reuse the injected-wallet error",
);

assert(
  shouldApplyWalletConnectSession({
    connectionKind: "injected",
    localDisconnect: false,
    armed: false,
    hasInjectedProvider: true,
  }) === false,
  "WalletConnect must not replace an injected session",
);
assert(
  shouldApplyWalletConnectSession({
    connectionKind: null,
    localDisconnect: true,
    armed: false,
    hasInjectedProvider: false,
  }) === false,
  "a local disconnect must block silent WalletConnect restore",
);
assert(
  shouldApplyWalletConnectSession({
    connectionKind: null,
    localDisconnect: false,
    armed: false,
    hasInjectedProvider: false,
  }) === true,
  "a returning mobile session can restore",
);
assert(
  shouldApplyWalletConnectSession({
    connectionKind: null,
    localDisconnect: true,
    armed: true,
    hasInjectedProvider: false,
  }) === true,
  "an explicit connect can accept the next WalletConnect session",
);

assert(normalizeChainId("0x1237") === ROBINHOOD_CHAIN_ID, "hex chain id");
assert(normalizeChainId(4663) === ROBINHOOD_CHAIN_ID, "numeric chain id");
assert(normalizeChainId("eip155:4663") === ROBINHOOD_CHAIN_ID, "caip chain id");
assert(normalizeChainId("eip155:1") === 1, "other caip chain stays wrong-network");
assert(normalizeChainId("nope") === undefined, "invalid chain id");

assert(isEvmAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168"), "address");
assert(!isEvmAddress("0x123"), "short address");
assert(isUserRejection({ code: 4001 }), "eip-1193 rejection");
assert(
  isUserRejection(new Error("User rejected the request.")),
  "rejection message",
);
assert(
  walletErrorMessage(new Error("Proposal expired"), "fallback") ===
    "Proposal expired",
  "session failure message is preserved",
);
assert(
  walletErrorMessage({ code: 4001 }, "fallback") === CONNECTION_CANCELLED,
  "rejection maps to a clear cancellation",
);

const purchase = readFileSync(new URL("../../components/OraDeskPage.tsx", import.meta.url), "utf8");
const confirmStart = purchase.indexOf("async function confirmPurchase");
assert(confirmStart >= 0, "confirmPurchase exists");
const confirmEnd = purchase.indexOf("setConfirming(false);", confirmStart);
assert(confirmEnd > confirmStart, "confirmPurchase end");
const confirm = purchase.slice(confirmStart, confirmEnd);
for (const step of [
  "/api/execute/validate",
  "createWalletClient",
  "custom(",
  'functionName: "approve"',
  'functionName: "buyAndActivate"',
  "/api/execute/confirm",
  "/api/execute/receipt",
]) {
  assert(confirm.includes(step), `purchase flow kept ${step}`);
}
assert(
  confirm.indexOf("/api/execute/validate") < confirm.indexOf("createWalletClient") &&
    confirm.indexOf("createWalletClient") < confirm.indexOf('functionName: "approve"') &&
    confirm.indexOf('functionName: "approve"') <
      confirm.indexOf('functionName: "buyAndActivate"') &&
    confirm.indexOf('functionName: "buyAndActivate"') <
      confirm.indexOf("/api/execute/confirm") &&
    confirm.indexOf("/api/execute/confirm") < confirm.indexOf("/api/execute/receipt"),
  "purchase order changed",
);
assert(!confirm.includes("window.ethereum"), "purchase must sign through the active provider");
assert(confirm.includes("ethereumProvider"), "purchase uses the wallet-context provider");

const wallet = readFileSync(new URL("./wallet.tsx", import.meta.url), "utf8");
assert(wallet.includes("wallet_switchEthereumChain"), "injected network switch remains");
assert(wallet.includes("wallet_requestPermissions"), "injected account switch remains");
assert(wallet.includes("eth_accounts"), "injected silent restore remains");

console.log("wallet connection ok");
