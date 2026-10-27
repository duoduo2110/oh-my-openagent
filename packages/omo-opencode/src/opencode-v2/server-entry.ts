import * as Plugin from "@opencode/plugin/promise/plugin"

import { log } from "../shared/logger"
import { runOpenCodeV2Probe } from "./probe"
import { OPENCODE_V2_NOTICE_MESSAGE } from "./startup-notice"

// OpenCode 2 entry point. It only registers the plugin so OpenCode 2 loads it; the V1 `server`
// export next to it keeps running the full plugin on OpenCode 1.x.
export const opencodeV2Server = Plugin.define({
  id: "oh-my-openagent",
  setup: async (context) => {
    log("[opencode-v2] loaded without the V1 runtime", { notice: OPENCODE_V2_NOTICE_MESSAGE })
    // S0 probe: proves setup cardinality, tool schema acceptance and the Bun runtime.
    await runOpenCodeV2Probe(context)
  },
})
