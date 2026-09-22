import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Jev } from "../../src/reflex/client"
import { ReflexConfig } from "../../src/reflex/config"
import { ReflexQuestions } from "../../src/reflex/questions"
import { environment, server } from "./server"

test("disabled config ignores absent credentials, enabled config validates without exposing values", () => {
  expect(ReflexConfig.read({})).toBeUndefined()
  expect(() => ReflexConfig.read({ REFLEX_ENABLED: "true" })).toThrow("JEV_API_KEY")
  expect(() =>
    ReflexConfig.read({
      ...environment("http://localhost/decisions", "http://localhost/v1"),
      REFLEX_MAX_CORRECTIONS: "3",
    }),
  ).toThrow("REFLEX_MAX_CORRECTIONS")
})

test("real Decisions HTTP request batches typed choices and preserves usage", async () => {
  const http = server()
  try {
    const config = ReflexConfig.read(environment(http.url, "http://localhost/v1"))!
    const result = await Effect.runPromise(
      Jev.decide(config, { state: { task: "fix a bug" }, questions: ReflexQuestions.route }),
    )
    expect(result.answers.agent).toMatchObject({ type: "choice", choice: "build", confidence: 0.99 })
    expect(result.usage?.cost).toBe(0.000001)
    expect(http.requests).toHaveLength(1)
    expect(http.requests[0].model).toBe("typesafe/jev-1.13")
  } finally {
    http.stop()
  }
})

for (const status of [401, 402, 403, 404, 429, 500, 503]) {
  test(`HTTP ${status}: bounded retry and sanitized failure`, async () => {
    const hits: string[] = []
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        hits.push(request.headers.get("authorization") ?? "")
        return new Response("jev-test-secret", { status })
      },
    })
    try {
      const config = ReflexConfig.read(environment(String(http.url), "http://localhost/v1"))!
      const result = await Effect.runPromise(
        Jev.decide(config, { state: {}, questions: ReflexQuestions.route }).pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      expect(JSON.stringify(result)).not.toContain("jev-test-secret")
      expect(hits).toHaveLength([429, 500, 503].includes(status) ? 2 : 1)
    } finally {
      http.stop(true)
    }
  })
}

test("out-of-taxonomy choices fail validation", async () => {
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({
        model: "jev",
        answers: { action: { type: "choice", choice: "execute", confidence: 0.99, probabilities: { execute: 1 } } },
      })
    },
  })
  try {
    const config = ReflexConfig.read(environment(String(http.url), "http://localhost/v1"))!
    const result = await Effect.runPromise(
      Jev.decide(config, { state: {}, questions: ReflexQuestions.permission }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
  } finally {
    http.stop(true)
  }
})

test("deadline and fiber cancellation abort an in-flight HTTP request", async () => {
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(1000)
      return Response.json({})
    },
  })
  try {
    const config = { ...ReflexConfig.read(environment(String(http.url), "http://localhost/v1"))!, timeout: 25 }
    const started = Date.now()
    const result = await Effect.runPromise(
      Jev.decide(config, { state: {}, questions: ReflexQuestions.route }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    expect(Date.now() - started).toBeLessThan(800)
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Jev.decide({ ...config, timeout: 2000 }, { state: {}, questions: ReflexQuestions.route }),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }),
    )
  } finally {
    http.stop(true)
  }
})
