import type { ProcurementTarget } from "../../../types/ora";
import { insertTargetAlert, readLatestTargetAlert } from "../../db/alerts";
import {
  alertStatusForPeriod,
  COOLDOWN_ALERT_STATUSES,
  cooldownReference,
  logReadyAlert,
  prepareReadyAlert,
  READY_ALERT_CHANNEL,
  type ReadyAlertPayload,
} from "./ready-alert";

export type ReadyAlertResult = {
  targetId: string;
  result: "pending" | "suppressed" | "skipped" | "duplicate" | "error";
  payload?: ReadyAlertPayload;
};

/**
 * Records one alert per READY period for targets the scheduler just moved
 * from WATCHING to READY. Each target is isolated; failures never propagate.
 */
export async function recordReadyAlerts(
  targets: ProcurementTarget[],
): Promise<ReadyAlertResult[]> {
  const results: ReadyAlertResult[] = [];
  for (const target of targets) {
    try {
      if (target.status !== "READY" || !target.readySince) {
        results.push({ targetId: target.id, result: "skipped" });
        continue;
      }
      const payload = prepareReadyAlert(target);
      const previous = payload
        ? await readLatestTargetAlert(
            target.id,
            READY_ALERT_CHANNEL,
            COOLDOWN_ALERT_STATUSES,
          )
        : null;
      const status = payload
        ? alertStatusForPeriod(
            target.readySince,
            previous ? cooldownReference(previous) : null,
          )
        : "skipped";
      const alert = await insertTargetAlert({
        targetId: target.id,
        walletAddress: target.walletAddress,
        channel: READY_ALERT_CHANNEL,
        readySince: target.readySince,
        status,
        lastError: payload ? null : "READY target is missing executable quote facts.",
      });
      if (!alert) {
        results.push({ targetId: target.id, result: "duplicate" });
        continue;
      }
      if (status === "pending" && payload) {
        results.push({
          targetId: target.id,
          result: "pending",
          payload: logReadyAlert(alert.id, payload),
        });
        continue;
      }
      results.push({ targetId: target.id, result: status });
    } catch (error) {
      console.error(
        `Ready alert for procurement target ${target.id} could not be recorded:`,
        error instanceof Error ? error.message : error,
      );
      results.push({ targetId: target.id, result: "error" });
    }
  }
  return results;
}
