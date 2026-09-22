import type { Jev } from "../../src/reflex/client"
export * as ReflexTest from "./server"

export function server(
  options: {
    agent?: "build" | "plan"
    tier?: "small" | "normal" | "strong"
    actions?: string[]
    permission?: string
    confidence?: number
    wait?: Promise<void>
  } = {},
) {
  const requests: Array<{ model: string; state: unknown; questions: Record<string, Jev.Question> }> = []
  const actions = [...(options.actions ?? ["finish"])]
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number]
      requests.push(body)
      if (options.wait) await options.wait
      const outcome = body.questions.quality ? (actions.shift() ?? "finish") : undefined
      return Response.json({
        model: "typesafe/jev-test",
        id: `decision-${requests.length}`,
        usage: { cost: 0.000001, input_tokens: 100, output_tokens: 0 },
        answers: Object.fromEntries(
          Object.entries(body.questions).map(([key, question]) => {
            if (question.type === "noul") return [key, { type: "noul", noul: 0.9 }]
            if (question.type === "score")
              return [
                key,
                {
                  type: "score",
                  score: 3,
                  confidence: 0.99,
                  probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, 4: 0 },
                  legend: Object.fromEntries(question.criteria.map((text, i) => [String(i), text])),
                },
              ]
            const choice =
              key === "agent"
                ? (options.agent ?? "build")
                : key === "tier"
                  ? (options.tier ?? "small")
                  : key === "issue"
                    ? outcome === "finish"
                      ? "none"
                      : "incomplete"
                    : (outcome ?? options.permission ?? "allow")
            return [
              key,
              {
                type: "choice",
                choice,
                confidence: options.confidence ?? 0.99,
                probabilities: Object.fromEntries(
                  Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0]),
                ),
              },
            ]
          }),
        ),
      })
    },
  })
  return { url: `${http.url}decisions`, requests, stop: () => http.stop(true) }
}

export function environment(url: string, baseURL: string) {
  return {
    REFLEX_ENABLED: "true",
    JEV_URL: url,
    JEV_API_KEY: "jev-test-secret",
    JEV_TIMEOUT_MS: "2000",
    REFLEX_LLM_BASE_URL: baseURL,
    REFLEX_LLM_API_KEY: "llm-test-secret",
    REFLEX_MODEL_SMALL: "small-model",
    REFLEX_MODEL_NORMAL: "normal-model",
    REFLEX_MODEL_STRONG: "strong-model",
  }
}
