import * as Plugin from "@opencode/plugin/promise/plugin"

import { log } from "../shared/logger"
import { createOpenCodeV2Runtime } from "./adapter"
import { materializeOpenCodeV2Agents } from "./agents"
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
    // S2b: bridge V2 domain hooks onto the V1 hook handlers.
    await registerOpenCodeV2Hooks(context, runtime)
    // S3a: built-in agents materialized as markdown (V2 has no agent add()).
    await materializeOpenCodeV2Agents(context)

    return async () => {
      await runtime?.dispose()
      log("[opencode-v2] runtime disposed", {})
    }
  },
})
