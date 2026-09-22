import { OpenRouter } from "@openrouter/sdk";
import type { OraDecision, OraReasoning } from "../../types/ora";
import {
  messageContentText,
  parseReasoningOutput,
  reasoningPayload,
} from "../ora/reasoning";

const ORBIO_API_ORIGIN = "https://api.orbio.so/api/v1";
const DEFAULT_MODEL = "google/gemini-3.8-flash";
const TIMEOUT_MS = 8_000;

const REASONING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    recommendation: { type: "string", enum: ["BUY", "WAIT"] },
    rationale: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    agreesWithRule: { type: "boolean" },
  },
  required: ["recommendation", "rationale", "risks", "agreesWithRule"],
};

function logReasoningError(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error("Orbio reasoning unavailable:", message);
}

export async function reasonAboutDecision(
  decision: OraDecision,
): Promise<OraReasoning | null> {
  const apiKey = process.env.ORBIO_API_KEY?.trim();
  if (!apiKey) {
    console.error("Orbio reasoning unavailable: missing ORBIO_API_KEY");
    return null;
  }

  try {
    const client = new OpenRouter({
      apiKey,
      serverURL: ORBIO_API_ORIGIN,
      appTitle: "ora-procurement",
    });
    const payload = reasoningPayload(decision);
    const result = await client.chat.send(
      {
        chatRequest: {
          model: process.env.ORBIO_REASONING_MODEL?.trim() || DEFAULT_MODEL,
          stream: false,
          maxTokens: 400,
          temperature: 0.2,
          responseFormat: {
            type: "json_schema",
            jsonSchema: {
              name: "ora_reasoning",
              strict: true,
              schema: REASONING_SCHEMA,
            },
          },
          messages: [
            {
              role: "system",
              content:
                "You are Orbio reasoning for Ora, a CREDIT procurement agent. Ora's deterministic BUY/WAIT rule is authoritative. Interpret the CREDIT market, note risks, and say whether you agree. Do not claim control of spending, quotes, or purchases. Reply with JSON only.",
            },
            {
              role: "user",
              content: JSON.stringify(payload),
            },
          ],
        },
      },
      { timeoutMs: TIMEOUT_MS },
    );

    if (result instanceof ReadableStream) {
      logReasoningError(new Error("streaming response"));
      return null;
    }

    const text = messageContentText(result.choices[0]?.message.content);
    return parseReasoningOutput(text, decision.action);
  } catch (error) {
    logReasoningError(error);
    return null;
  }
}
