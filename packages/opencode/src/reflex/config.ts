export * as ReflexConfig from "./config"

export const tiers = ["small", "normal", "strong"] as const
export type Tier = (typeof tiers)[number]

export function read(env: Record<string, string | undefined>) {
  if (env.REFLEX_ENABLED !== "true") return
  return {
    url: url(env.JEV_URL ?? "https://openrouter.ai/api/alpha/decisions", "JEV_URL"),
    apiKey: required(env, "JEV_API_KEY"),
    model: env.JEV_MODEL || "typesafe/jev-1.13",
    timeout: number(env, "JEV_TIMEOUT_MS", 3000, 1, 60000, true),
    baseURL: url(required(env, "REFLEX_LLM_BASE_URL"), "REFLEX_LLM_BASE_URL").replace(/\/$/, ""),
    llmKey: required(env, "REFLEX_LLM_API_KEY"),
    models: {
      small: required(env, "REFLEX_MODEL_SMALL"),
      normal: required(env, "REFLEX_MODEL_NORMAL"),
      strong: required(env, "REFLEX_MODEL_STRONG"),
    },
    routeConfidence: number(env, "REFLEX_ROUTE_CONFIDENCE", 0.8, 0, 1),
    permissionConfidence: number(env, "REFLEX_PERMISSION_CONFIDENCE", 0.9, 0, 1),
    outcomeConfidence: number(env, "REFLEX_OUTCOME_CONFIDENCE", 0.8, 0, 1),
    corrections: number(env, "REFLEX_MAX_CORRECTIONS", 2, 0, 2, true),
    turns: number(env, "REFLEX_MAX_PROVIDER_TURNS", 30, 1, 1000, true),
  }
}

export type Info = NonNullable<ReturnType<typeof read>>

function required(env: Record<string, string | undefined>, key: string) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`Reflex configuration: ${key} is required`)
  return value
}

function url(value: string, key: string) {
  if (!URL.canParse(value) || !["http:", "https:"].includes(new URL(value).protocol))
    throw new Error(`Reflex configuration: ${key} must be an absolute HTTP(S) URL`)
  if (new URL(value).username || new URL(value).password)
    throw new Error(`Reflex configuration: ${key} must not contain credentials`)
  return value
}

function number(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  integer = false,
) {
  const value = env[key] === undefined ? fallback : Number(env[key])
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new Error(
      `Reflex configuration: ${key} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`,
    )
  return value
}
