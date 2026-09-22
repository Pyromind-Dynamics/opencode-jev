export * as Jev from "./client"

import { Effect, Schema } from "effect"
import type { ReflexConfig } from "./config"

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Probabilities = Schema.Record(Schema.String, Probability)
const Answer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    confidence: Probability,
    probabilities: Probabilities,
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Finite,
    confidence: Probability,
    probabilities: Probabilities,
    legend: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
])
const Response = Schema.Struct({
  answers: Schema.Record(Schema.String, Answer),
  id: Schema.String.pipe(Schema.optional),
  model: Schema.String,
  provider: Schema.String.pipe(Schema.optional),
  usage: Schema.Struct({
    cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
    input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
    output_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  }).pipe(Schema.optional),
})
export type Response = typeof Response.Type
export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string }

export class Error extends Schema.TaggedErrorClass<Error>()("Jev.Error", {
  reason: Schema.String,
}) {}

export const decide = (
  config: Pick<ReflexConfig.Info, "url" | "apiKey" | "model" | "timeout">,
  input: {
    state: unknown
    questions: Record<string, Question>
  },
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const abort = AbortSignal.any([signal, AbortSignal.timeout(config.timeout)])
      const started = performance.now()
      const send = () =>
        fetch(config.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: config.model, ...input }),
          signal: abort,
          redirect: "error",
        })
      const first = await send()
      if ([429, 500, 502, 503, 524, 529].includes(first.status)) await first.body?.cancel()
      const response = [429, 500, 502, 503, 524, 529].includes(first.status) ? await send() : first
      if (!response.ok) throw new Error({ reason: `http_${response.status}` })
      const result = Schema.decodeUnknownSync(Response)(await response.json())
      Object.entries(input.questions).forEach(([id, question]) => {
        const answer = result.answers[id]
        if (!answer || answer.type !== question.type) throw new Error({ reason: "invalid_answer" })
        if (question.type === "choice" && answer.type === "choice") {
          const keys = Object.keys(question.criteria)
          if (
            !keys.includes(answer.choice) ||
            keys.some((key) => answer.probabilities[key] === undefined) ||
            Object.keys(answer.probabilities).some((key) => !keys.includes(key))
          )
            throw new Error({ reason: "invalid_choice" })
        }
        if (question.type === "score" && answer.type === "score") {
          if (
            answer.score < 0 ||
            answer.score > question.criteria.length - 1 ||
            question.criteria.some((_, i) => answer.probabilities[String(i)] === undefined)
          )
            throw new Error({ reason: "invalid_score" })
        }
        if (
          answer.type !== "noul" &&
          Math.abs(Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.02
        )
          throw new Error({ reason: "invalid_distribution" })
      })
      abort.throwIfAborted()
      return { ...result, latency_ms: performance.now() - started }
    },
    // Never include a response body, URL or provider error text: these may contain secrets.
    catch: (error) => (error instanceof Error ? error : new Error({ reason: "transport_or_schema_error" })),
  })
