import type { DecisionAction, OraDecision, OraReasoning } from "../../types/ora";

const MAX_RATIONALE = 800;
const MAX_RISK = 240;
const MAX_RISKS = 5;

function asText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return asText((part as { text?: unknown }).text);
      }
      return "";
    })
    .join("");
}

export function parseReasoningOutput(
  raw: unknown,
  deterministicAction: DecisionAction,
): OraReasoning | null {
  let value = raw;
  if (typeof raw === "string") {
    value = extractJsonObject(raw);
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const recommendationRaw = asText(record.recommendation).toUpperCase();
  if (recommendationRaw !== "BUY" && recommendationRaw !== "WAIT") {
    return null;
  }
  const recommendation = recommendationRaw as DecisionAction;
  const rationale = asText(record.rationale).slice(0, MAX_RATIONALE);
  if (!rationale) return null;

  const risks = Array.isArray(record.risks)
    ? record.risks
        .map((item) => asText(item).slice(0, MAX_RISK))
        .filter(Boolean)
        .slice(0, MAX_RISKS)
    : [];

  return {
    recommendation,
    rationale,
    risks,
    agreesWithRule: recommendation === deterministicAction,
  };
}

export function reasoningPayload(decision: OraDecision) {
  const depth = decision.market.depth.slice(0, 8).map((level) => ({
    discountPercent: level.discountPercent,
    availableCredit: level.availableCredit,
  }));
  return {
    creditPrice: decision.market.creditPrice,
    bestDiscount: decision.market.bestDiscount,
    depth,
    requestedCredit:
      decision.requestedAmount ?? decision.params.requestedCredit,
    minimumDiscount: decision.params.minDiscountPercent,
    spendingLimitUsdg: decision.params.spendingLimitUsdg,
    deterministicDecision: decision.action,
    ...(decision.executable
      ? {
          executableDiscountPercent: decision.executable.discountPercent,
          executableTotalUsdg: decision.executable.totalUsdg,
        }
      : {}),
  };
}

export function finalDecisionAction(
  decision: OraDecision,
  _reasoning: OraReasoning | null,
): DecisionAction {
  void _reasoning;
  return decision.action;
}

/** Reasoning is advisory. A failure or disagreement must not block or alter the decision. */
export async function resolveAdvisoryReasoning(
  decision: OraDecision,
  reason: (decision: OraDecision) => Promise<OraReasoning | null>,
): Promise<OraReasoning | null> {
  try {
    return await reason(decision);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error("Orbio reasoning unavailable:", message);
    return null;
  }
}
