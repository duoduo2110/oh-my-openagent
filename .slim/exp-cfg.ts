import { loadPluginConfig } from "../packages/omo-opencode/src/plugin-config"
const cfg = loadPluginConfig("/tmp/s3a-proj", {})
console.log("HOME", process.env.HOME, "disabled_agents", JSON.stringify(cfg.disabled_agents))
console.log("keys", Object.keys(cfg).length)
