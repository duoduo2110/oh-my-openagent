import * as Plugin from "@opencode/plugin/promise/plugin"

import { log } from "../shared/logger"
import { createOpenCodeV2Runtime } from "./adapter"
import { materializeOpenCodeV2Agents } from "./agents"
import { applyOpenCodeV2ConfigDomains } from "./config-domains"
import { registerOpenCodeV2Hooks } from "./hooks"
import { runOpenCodeV2Probe } from "./probe"
import { OPENCODE_V2_NOTICE_MESSAGE } from "./startup-notice"
import { registerOpenCodeV2Tools } from "./tools"

// OpenCode 2 entry point. It only registers the plugin so OpenCode 2 loads it; the V1 `server`
// export next to it keeps running the full plugin on OpenCode 1.x.
export const opencodeV2Server = Plugin.define({
  id: "oh-my-openagent",
  setup: async (context) => {
    log("[opencode-v2] loaded without the V1 runtime", { notice: OPENCODE_V2_NOTICE_MESSAGE })
    // S0 probe: proves setup cardinality, tool schema acceptance and the Bun runtime.
    await runOpenCodeV2Probe(context)
    // S1a: A-group tools (grep/glob/task_get/task_list/goal trio) through the V1 -> V2 bridge.
    await registerOpenCodeV2Tools(context)
    // S2a: V1 runtime (managers/hooks/tools) assembled over a V2 context shim.
    const runtime = await createOpenCodeV2Runtime(context)
    log("[opencode-v2] runtime assembled", { hasRuntime: Boolean(runtime) })
    // S3b: project the V1 config handler output onto V2 config domains.
    await applyOpenCodeV2ConfigDomains(context)
    // S2b: bridge V2 domain hooks onto the V1 hook handlers.
    const releaseHooks = await registerOpenCodeV2Hooks(context, runtime)
    // S3a: built-in agents materialized as markdown (V2 has no agent add()).
    await materializeOpenCodeV2Agents(context)

    return async () => {
      // Order is not cosmetic: the bridge's registrations and event pump point *into* the runtime,
      // so releasing the bridge first stops the pump while its handlers still exist. Disposing the
      // runtime first would leave a pump running against handlers whose managers are already
      // stopped, and `releaseHooks` is what drops the bridge's reference count to zero — skipping
      // it (this used to be dropped) left the bridge installed forever.
      try {
        await releaseHooks()
      } catch (error) {
        // Cleanup must not reach the host: a failing release is logged, never thrown.
        log("[opencode-v2] hook bridge release failed", { error: String(error) })
      }
      try {
        await runtime?.dispose()
      } catch (error) {
        log("[opencode-v2] runtime dispose failed", { error: String(error) })
      }
      log("[opencode-v2] runtime disposed", {})
    }
  },
})
