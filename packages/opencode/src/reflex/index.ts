export * as Reflex from "./index"

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Env } from "../env"
import { Session } from "../session/session"
import { MessageID, PartID, SessionID } from "../session/schema"
import { ReflexConfig } from "./config"
import { ReflexQuestions } from "./questions"
import { Jev } from "./client"

const Task = Schema.Struct({
  taskID: MessageID,
  userID: MessageID,
  agent: Schema.Literals(["build", "plan"]),
  tier: Schema.Literals(ReflexConfig.tiers),
  turns: Schema.Int,
  corrections: Schema.Int,
  evaluated: Schema.Array(MessageID),
  feedback: Schema.Struct({ id: MessageID, partID: PartID, assistantID: MessageID, text: Schema.String }).pipe(
    Schema.optional,
  ),
})
export type Task = typeof Task.Type
export const task = (session: Session.Info) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Task)(session.metadata?.reflex))

export interface Interface {
  readonly start: (
    sessionID: SessionID,
    user: SessionV1.User,
    messages: SessionV1.WithParts[],
  ) => Effect.Effect<Task | undefined>
  readonly recover: (sessionID: SessionID) => Effect.Effect<void>
  readonly takeTurn: (sessionID: SessionID, task: Task, limit?: number) => Effect.Effect<Task | undefined>
  readonly evaluate: (
    sessionID: SessionID,
    task: Task,
    assistant: SessionV1.Assistant,
    messages: SessionV1.WithParts[],
    diff: unknown,
    limit?: number,
  ) => Effect.Effect<boolean>
  readonly authorize: (input: PermissionV1.AskInput) => Effect.Effect<"allow" | "ask" | "deny">
  readonly recordTurn: (
    sessionID: SessionID,
    task: Task,
    assistant: SessionV1.Assistant,
    started: number,
    model: string,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Reflex") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const env = yield* Env.Service
    const sessions = yield* Session.Service
    const config = Effect.fn("Reflex.config")(function* () {
      return ReflexConfig.read(yield* env.all())
    })
    const get = (id: SessionID) => sessions.get(id).pipe(Effect.orDie)
    const save = Effect.fn("Reflex.save")(function* (sessionID: SessionID, value: Task) {
      const session = yield* get(sessionID)
      yield* sessions.setMetadata({ sessionID, metadata: { ...session.metadata, reflex: value } })
      return value
    })
    const current = Effect.fn("Reflex.current")(function* (sessionID: SessionID, userID: MessageID) {
      const messages = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      return messages.findLast((item) => item.info.role === "user")?.info.id === userID
    })
    const log = Effect.fn("Reflex.log")(function* (sessionID: SessionID, value: Record<string, unknown>) {
      const cfg = yield* config()
      yield* Effect.tryPromise(async () => {
        const safe = cfg ? redact(value, cfg) : value
        const dir = path.join(Global.Path.data, "reflex")
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await appendFile(
          path.join(dir, `${sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`),
          JSON.stringify({
            schema_version: 1,
            timestamp: new Date().toISOString(),
            session_id: sessionID,
            question_version: ReflexQuestions.version,
            ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(safe),
          }) + "\n",
          { mode: 0o600 },
        )
      }).pipe(Effect.catch(() => Effect.logWarning("Reflex decision log could not be written")))
    })
    const request = Effect.fn("Reflex.request")(function* (
      cfg: ReflexConfig.Info,
      state: unknown,
      questions: Record<string, Jev.Question>,
    ) {
      return yield* Effect.try({
        try: () => redact(state, cfg),
        catch: () => new Jev.Error({ reason: "context_too_large" }),
      }).pipe(
        Effect.flatMap((state) => Jev.decide(cfg, { state, questions })),
        Effect.result,
      )
    })
    const recover = Effect.fn("Reflex.recover")(function* (sessionID: SessionID) {
      if (!(yield* config())) return
      const value = task(yield* get(sessionID))
      if (!value?.feedback) return
      const messages = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const latest = messages.findLast((item) => item.info.role === "user")
      if (latest?.info.id !== value.userID && latest?.info.id !== value.feedback.id) return
      const original = messages.find((item) => item.info.id === value.taskID)
      if (original?.info.role !== "user") return
      if (!messages.some((item) => item.info.id === value.feedback!.id)) {
        yield* sessions.updateMessage({
          ...original.info,
          id: value.feedback.id,
          time: { created: Date.now() },
          summary: undefined,
          agent: "reflex",
          format: original.info.format ? Schema.decodeUnknownSync(SessionV1.Format)(original.info.format) : undefined,
        })
      }
      if (!messages.some((item) => item.parts.some((part) => part.id === value.feedback!.partID))) {
        yield* sessions.updatePart({
          id: value.feedback.partID,
          messageID: value.feedback.id,
          sessionID,
          type: "text",
          text: value.feedback.text,
          synthetic: true,
          metadata: {
            reflex: {
              task_id: value.taskID,
              evaluated_message_id: value.feedback.assistantID,
              correction_index: value.corrections,
            },
          },
        })
      }
      yield* save(sessionID, { ...value, userID: value.feedback.id, feedback: undefined })
    })
    return Service.of({
      recover,
      recordTurn: (sessionID, value, assistant, started, model) =>
        Effect.suspend(() =>
          log(sessionID, {
            task_id: value.taskID,
            message_id: assistant.id,
            decision_kind: "llm",
            model,
            applied: assistant.error ? "error" : (assistant.finish ?? "interrupted"),
            latency_ms: performance.now() - started,
            usage: assistant.tokens,
            // Legacy providers default unknown catalog prices to zero. Never export that as free inference.
            cost: assistant.cost > 0 ? assistant.cost : null,
            cost_source: assistant.cost > 0 ? "opencode_accounting" : "unknown",
            correction_index: value.corrections,
          }),
        ),
      start: Effect.fn("Reflex.start")(function* (sessionID, user, messages) {
        const cfg = yield* config()
        if (!cfg || user.agent !== "reflex") return
        const session = yield* get(sessionID)
        const previous = task(session)
        if (previous?.userID === user.id) return previous
        const continuation = messages
          .find((item) => item.info.id === user.id)
          ?.parts.some(
            (part) =>
              (part.type === "compaction" && part.auto) ||
              (part.type === "text" &&
                (part.metadata?.compaction_continue === true || part.metadata?.reflex_continuation === true)),
          )
        if (previous && continuation) return yield* save(sessionID, { ...previous, userID: user.id })
        const result = yield* request(
          cfg,
          {
            request: textOf(messages, user.id),
            trajectory: evidence(messages),
            current: previous && { agent: previous.agent, tier: previous.tier },
          },
          ReflexQuestions.route,
        )
        if (!(yield* current(sessionID, user.id))) return
        const answers = result._tag === "Success" ? result.success.answers : undefined
        const agent = answers?.agent
        const tier = answers?.tier
        const selected: Task = {
          taskID: user.id,
          userID: user.id,
          turns: 0,
          corrections: 0,
          evaluated: [],
          agent:
            agent?.type === "choice" && agent.confidence >= cfg.routeConfidence && agent.choice === "build"
              ? "build"
              : "plan",
          tier:
            tier?.type === "choice" && tier.confidence >= cfg.routeConfidence
              ? Schema.decodeUnknownSync(Task.fields.tier)(tier.choice)
              : "normal",
        }
        yield* save(sessionID, selected)
        yield* log(sessionID, {
          task_id: user.id,
          message_id: user.id,
          decision_kind: "route",
          ...record(result),
          applied: { agent: selected.agent, tier: selected.tier, model: cfg.models[selected.tier] },
          fallback_reason:
            result._tag === "Failure"
              ? result.failure.reason
              : agent?.type !== "choice" ||
                  tier?.type !== "choice" ||
                  agent.confidence < cfg.routeConfidence ||
                  tier.confidence < cfg.routeConfidence
                ? "low_confidence"
                : null,
          correction_index: 0,
        })
        return selected
      }),
      takeTurn: Effect.fn("Reflex.takeTurn")(function* (sessionID, value, limit) {
        const cfg = yield* config()
        if (!cfg || !(yield* current(sessionID, value.userID))) return
        if (value.turns >= Math.min(cfg.turns, limit ?? Infinity)) {
          yield* log(sessionID, {
            task_id: value.taskID,
            message_id: value.userID,
            decision_kind: "budget",
            applied: "stop",
            fallback_reason: "provider_turn_limit",
          })
          return
        }
        return yield* save(sessionID, { ...value, turns: value.turns + 1 })
      }),
      evaluate: Effect.fn("Reflex.evaluate")(function* (sessionID, value, assistant, messages, diff, limit) {
        const cfg = yield* config()
        if (
          !cfg ||
          assistant.error ||
          value.evaluated.includes(assistant.id) ||
          !(yield* current(sessionID, value.userID))
        )
          return false
        const relevant = messages.slice(
          Math.max(
            0,
            messages.findIndex((item) => item.info.id === value.taskID),
          ),
        )
        const observed = evidence(relevant)
        const verification = checks(relevant)
        const failed = verification.some((check) => check.exit !== 0)
        const result = yield* request(
          cfg,
          {
            original_task: textOf(messages, value.taskID),
            task_mode: value.agent,
            trajectory: observed,
            diff,
            corrections: value.corrections,
            verification: verification.length ? verification : "unknown",
          },
          ReflexQuestions.outcome,
        )
        if (!(yield* current(sessionID, value.userID))) return false
        const answers = result._tag === "Success" ? result.success.answers : undefined
        const action = answers?.action
        const issue = answers?.issue
        const quality = answers?.quality
        const requested =
          action?.type === "choice" && action.confidence >= cfg.outcomeConfidence ? action.choice : undefined
        const decision = failed && value.agent === "build" ? "retry" : requested
        const correction = decision === "retry" || decision === "replan"
        const allowed =
          correction && value.corrections < cfg.corrections && value.turns < Math.min(cfg.turns, limit ?? Infinity)
        const next = { ...value, evaluated: [...value.evaluated, assistant.id] }
        yield* log(sessionID, {
          task_id: value.taskID,
          message_id: assistant.id,
          decision_kind: "outcome",
          ...record(result),
          quality: quality?.type === "score" ? quality.score / 4 : null,
          applied: allowed
            ? decision
            : correction
              ? "correction_limit"
              : decision === "finish"
                ? "finish"
                : "unverified",
          verification: verification.length ? verification : "unknown",
          fallback_reason: failed
            ? "observed_verification_failure"
            : result._tag === "Failure"
              ? result.failure.reason
              : !requested
                ? "low_confidence"
                : null,
          correction_index: value.corrections,
        })
        if (!allowed) {
          yield* save(sessionID, next)
          return false
        }
        const routing = yield* request(
          cfg,
          { task_mode: value.agent, trajectory: observed, previous_tier: value.tier, outcome: answers },
          { tier: ReflexQuestions.route.tier },
        )
        if (!(yield* current(sessionID, value.userID))) return false
        const tier = routing._tag === "Success" ? routing.success.answers.tier : undefined
        const proposed =
          tier?.type === "choice" && tier.confidence >= cfg.routeConfidence
            ? ReflexConfig.tiers.indexOf(Schema.decodeUnknownSync(Task.fields.tier)(tier.choice))
            : 0
        const selected =
          ReflexConfig.tiers[
            Math.min(2, Math.max(proposed, ReflexConfig.tiers.indexOf(value.tier) + (decision === "replan" ? 1 : 0)))
          ]
        yield* log(sessionID, {
          task_id: value.taskID,
          message_id: assistant.id,
          decision_kind: "route",
          ...record(routing),
          applied: { agent: value.agent, tier: selected, model: cfg.models[selected] },
          correction_index: value.corrections + 1,
        })
        yield* save(sessionID, {
          ...next,
          tier: selected,
          corrections: value.corrections + 1,
          feedback: {
            id: MessageID.ascending(),
            partID: PartID.ascending(),
            assistantID: assistant.id,
            text: `[Reflex correction ${value.corrections + 1}/${cfg.corrections}; original task ${value.taskID}]\nThe outcome policy selected ${decision}; issue: ${failed ? "test_failure" : issue?.type === "choice" ? issue.choice : "insufficient_context"}. ${decision === "replan" ? "Reconsider your approach before continuing." : "Address the remaining issue."} ${failed ? `Observed verification: ${JSON.stringify(verification.map((check) => ({ call_id: check.call_id, exit: check.exit })))}.` : ""} Review the original request and actual tool results above. Do not repeat completed side effects. Do not claim unexecuted checks passed. Stay within the original requested deliverable.`,
          },
        })
        yield* recover(sessionID)
        return true
      }),
      authorize: Effect.fn("Reflex.authorize")(function* (input) {
        const cfg = yield* config()
        if (!cfg) return "ask"
        const session = yield* get(input.sessionID)
        const lineage = [session]
        while (!task(lineage.at(-1)!) && lineage.at(-1)!.parentID && lineage.length < 32) {
          lineage.push(yield* get(lineage.at(-1)!.parentID!))
        }
        const owner = lineage.at(-1)!
        const value = task(owner)
        if (!value || !(yield* current(owner.id, value.userID))) return "ask"
        const history = yield* sessions.messages({ sessionID: owner.id }).pipe(Effect.orDie)
        if (history.findLast((item) => item.info.role === "user")?.info.agent !== "reflex") return "ask"
        const messages =
          owner.id === session.id ? history : yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)
        const tool = messages
          .find((item) => item.info.id === input.tool?.messageID)
          ?.parts.find((part) => part.type === "tool" && part.callID === input.tool?.callID)
        if (tool?.type !== "tool") return "ask"
        const latest = messages.findLast((item) => item.info.role === "user")?.info.id
        const result = yield* request(
          cfg,
          {
            original_task: textOf(history, value.taskID),
            directory: session.directory,
            permission: input.permission,
            resources: input.patterns,
            metadata: input.metadata,
            rules: input.ruleset,
            tool: { name: tool.tool, arguments: tool.state.input },
          },
          ReflexQuestions.permission,
        )
        if (!(yield* current(owner.id, value.userID))) return "ask"
        if (latest && !(yield* current(session.id, latest))) return "ask"
        const answer = result._tag === "Success" ? result.success.answers.action : undefined
        const applied =
          answer?.type === "choice" && answer.confidence >= cfg.permissionConfidence
            ? Schema.decodeUnknownSync(Schema.Literals(["allow", "ask", "deny"]))(answer.choice)
            : "ask"
        yield* log(session.id, {
          task_id: value.taskID,
          message_id: input.tool?.messageID,
          call_id: input.tool?.callID,
          decision_kind: "permission",
          ...record(result),
          applied,
          fallback_reason:
            result._tag === "Failure"
              ? result.failure.reason
              : answer?.type === "choice" && answer.confidence < cfg.permissionConfidence
                ? "low_confidence"
                : null,
          correction_index: value.corrections,
        })
        if (!(yield* current(owner.id, value.userID))) return "ask"
        return applied
      }),
    })
  }),
)

function record(
  result: { _tag: "Success"; success: Jev.Response & { latency_ms: number } } | { _tag: "Failure"; failure: Jev.Error },
) {
  if (result._tag === "Failure") return { proposed: null, cost: null, fallback_reason: result.failure.reason }
  return {
    proposed: result.success.answers,
    model: result.success.model,
    request_id: result.success.id,
    latency_ms: result.success.latency_ms,
    usage: result.success.usage,
    cost: result.success.usage?.cost ?? null,
    confidence: Object.fromEntries(
      Object.entries(result.success.answers)
        .filter(([, answer]) => answer.type !== "noul")
        .map(([id, answer]) => [id, answer.type !== "noul" ? answer.confidence : undefined]),
    ),
    probabilities: Object.fromEntries(
      Object.entries(result.success.answers)
        .filter(([, answer]) => answer.type !== "noul")
        .map(([id, answer]) => [id, answer.type !== "noul" ? answer.probabilities : undefined]),
    ),
    fallback_reason: null,
  }
}

export function evidence(messages: SessionV1.WithParts[]) {
  return messages.slice(-16).map((item) => ({
    id: item.info.id,
    role: item.info.role,
    parts: item.parts
      .flatMap((part) => {
        if (part.type === "text") return [{ type: "text", text: part.text.slice(0, 2000) }]
        if (part.type !== "tool") return []
        if (/(?:\.env\b|credentials|\.pem\b|\.key\b|id_rsa)/i.test(JSON.stringify(part.state.input)))
          return [{ type: "tool", text: "Sensitive tool evidence omitted" }]
        return [
          {
            type: "tool",
            text: JSON.stringify({
              name: part.tool,
              arguments: part.state.input,
              status: part.state.status,
              ...(part.state.status === "completed"
                ? { output: part.state.output.slice(-2000), metadata: part.state.metadata }
                : {}),
              ...(part.state.status === "error" ? { error: part.state.error } : {}),
            }).slice(0, 4000),
          },
        ]
      })
      .slice(-10),
  }))
}

function textOf(messages: SessionV1.WithParts[], id: MessageID) {
  return (
    messages
      .find((item) => item.info.id === id)
      ?.parts.flatMap((part) => (part.type === "text" && !part.ignored ? [part.text] : []))
      .join("\n") ?? "Original task unavailable; insufficient context"
  )
}

function redact(value: unknown, cfg: ReflexConfig.Info): unknown {
  const text = JSON.stringify(value, (key, value) =>
    /api.?key|authorization|password|secret|access.?token/i.test(key) ? "[redacted]" : value,
  )
    .replaceAll(cfg.apiKey, "[redacted]")
    .replaceAll(cfg.llmKey, "[redacted]")
  // Refuse oversized evidence rather than silently removing authorization context.
  if (text.length > 96000) throw new Error("Decision context too large")
  return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(text)
}

export const node = LayerNode.make({ service: Service, layer, deps: [Env.node, Session.node] })

// Deterministic evidence, not a claim that arbitrary shell output proves correctness.
export function checks(messages: SessionV1.WithParts[]) {
  const runs = messages
    .flatMap((item) => item.parts)
    .flatMap((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return []
      const command = part.state.input.command
      const exit = part.state.metadata.exit
      if (typeof command !== "string" || typeof exit !== "number" || !Number.isFinite(exit)) return []
      if (
        !/(?:^|\s)(?:pytest|jest|vitest|ruff|eslint|tsc)(?:\s|$)|(?:npm|pnpm|bun|yarn|cargo|go)\s+(?:run\s+)?(?:test|lint|typecheck|check)(?:\s|$)/.test(
          command,
        )
      )
        return []
      return [{ command, exit, call_id: part.callID }]
    })
  return [...new Map(runs.map((run) => [run.command.trim(), run])).values()]
}
