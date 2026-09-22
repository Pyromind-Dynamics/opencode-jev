import { ReflexConfig } from "../src/reflex/config"

// Validate before starting a daemon or loading providers; never make a paid startup request.
ReflexConfig.read(process.env)
await import("../src/index")
