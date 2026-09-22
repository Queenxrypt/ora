export function classifyTxError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : "Transaction rejected or failed";
  const text = raw.toLowerCase();
  if (
    text.includes("user rejected") ||
    text.includes("user denied") ||
    text.includes("rejected the request") ||
    text.includes("denied transaction")
  ) {
    return "Transaction rejected in the wallet. No purchase was sent.";
  }
  if (text.includes("insufficient funds") && text.includes("gas")) {
    return "Insufficient ETH for gas on Robinhood Chain 4663.";
  }
  if (text.includes("insufficient funds")) {
    return "Insufficient funds in the connected wallet.";
  }
  if (text.includes("insufficient") && text.includes("usdg")) {
    return "Insufficient USDG in the connected wallet.";
  }
  if (
    text.includes("wrong network") ||
    text.includes("wallet_switchethereumchain") ||
    (text.includes("chain mismatch") && !text.includes("4663"))
  ) {
    return "Wallet is not on Robinhood Chain 4663.";
  }
  return raw;
}
