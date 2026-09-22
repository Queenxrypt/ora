import { config } from "dotenv";
import { OpenRouter } from "@openrouter/sdk";

config({ path: ".env.local" });

const apiKey = process.env.ORBIO_API_KEY?.trim();

if (!apiKey) {
  throw new Error(
    "Missing ORBIO_API_KEY. Add it to .env.local before running this test.",
  );
}

const client = new OpenRouter({
  apiKey,
  serverURL: "https://api.orbio.so/api/v1",
  appTitle: "orbio-build-local-test",
});

const result = await client.chat.send({
  chatRequest: {
    model: "google/gemini-3.8-flash",
    stream: false,
    maxTokens: 32,
    messages: [
      {
        role: "user",
        content: "Reply with exactly: Orbio connection OK",
      },
    ],
  },
});

if (result instanceof ReadableStream) {
  throw new Error("Expected a non-streaming chat completion response.");
}

const content = result.choices[0]?.message.content;
console.log("Model:", result.model);
console.log("Response:", content);
console.log("Full payload:");
console.log(JSON.stringify(result, null, 2));
