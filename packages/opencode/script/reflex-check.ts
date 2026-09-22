import { Effect, Schema } from "effect"
import { ReflexConfig } from "../src/reflex/config"
import { Jev } from "../src/reflex/client"

const config = ReflexConfig.read(process.env)
if (!config) throw new Error("Set REFLEX_ENABLED=true to run the explicit, billable connectivity check")
const decision = await Effect.runPromise(
  Jev.decide(config, {
    state: { request: "Read the README and explain the project. Do not edit files." },
    questions: {
      mode: {
        type: "choice",
        instructions: "Which mode matches this request?",
        criteria: { plan: "Explain without editing", build: "Implement changes" },
      },
    },
  }),
)
console.log(JSON.stringify({ check: "jev", model: decision.model, answers: decision.answers, usage: decision.usage }))

const Chat = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        tool_calls: Schema.Array(
          Schema.Struct({ function: Schema.Struct({ name: Schema.String, arguments: Schema.String }) }),
        ),
      }),
    }),
  ),
})
for (const tier of ReflexConfig.tiers) {
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${config.llmKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.models[tier],
      stream: false,
      messages: [{ role: "user", content: "Call connectivity_check with no arguments." }],
      tools: [
        {
          type: "function",
          function: {
            name: "connectivity_check",
            description: "Connectivity test; no side effects.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "connectivity_check" } },
    }),
  })
  if (!response.ok) throw new Error(`${tier}: HTTP ${response.status}`)
  const result = Schema.decodeUnknownSync(Chat)(await response.json())
  if (
    !result.choices.some((choice) =>
      choice.message.tool_calls.some((call) => call.function.name === "connectivity_check"),
    )
  )
    throw new Error(`${tier}: model did not return a tool call`)
  console.log(JSON.stringify({ check: tier, model: config.models[tier], tool_call: "ok" }))
}
