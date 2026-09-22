export function formatCredit(value: number, digits = 2): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

export function formatPrice(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

export function formatTime(iso: string, withSeconds = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" as const } : {}),
    hour12: false,
  });
}

export function recordStage(status?: string, decision?: string): string {
  void decision;
  if (status === "success") return "Confirmed";
  if (
    status === "pending" ||
    status === "validating" ||
    status === "awaiting_signature"
  ) {
    return "Pending";
  }
  if (status === "review" || status === "quoting") return "Review";
  if (
    status === "failed" ||
    status === "stale_quote" ||
    status === "blocked_limit" ||
    status === "blocked_liquidity" ||
    status === "blocked_funds"
  ) {
    return "Failed";
  }
  return "Decision";
}

export function recordStageClass(status?: string, decision?: string): string {
  const stage = recordStage(status, decision).toLowerCase();
  return `lifecycle-status is-${stage}`;
}

export function executionLabel(status?: string, decision?: string): string {
  if (!status || status === "none") return "Decision";
  switch (status) {
    case "success":
      return "Confirmed";
    case "pending":
      return "Pending";
    case "review":
    case "quoting":
      return "Reviewed";
    case "validating":
    case "awaiting_signature":
      return "Awaiting confirmation";
    case "failed":
      return "Failed";
    case "stale_quote":
      return "Quote changed";
    case "blocked_limit":
      return "Blocked — limit";
    case "blocked_liquidity":
      return "Blocked — liquidity";
    case "blocked_funds":
      return "Blocked — funds";
    case "none":
    case undefined:
      return "None";
    default:
      return status;
  }
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
