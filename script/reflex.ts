import path from "node:path"

const args = process.argv.slice(2)
const index = args.indexOf("--env-file")
const file = path.resolve(index < 0 ? ".env" : (args[index + 1] ?? ".env"))
if (index >= 0) args.splice(index, 2)
if (!(await Bun.file(file).exists())) throw new Error(`Reflex environment file does not exist: ${file}`)
const check = args[0] === "--check"
if (check) args.shift()
const entry = path.resolve(
  import.meta.dir,
  check ? "../packages/opencode/script/reflex-check.ts" : "../packages/opencode/script/reflex-start.ts",
)
const preload = Bun.resolveSync("@opentui/solid/preload", path.resolve(import.meta.dir, "../packages/opencode"))
const child = Bun.spawn([process.execPath, `--env-file=${file}`, "--preload", preload, entry, ...args], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
})
process.on("SIGINT", () => child.kill("SIGINT"))
process.on("SIGTERM", () => child.kill("SIGTERM"))
process.exitCode = await child.exited
