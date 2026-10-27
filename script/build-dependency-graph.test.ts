import { describe, expect, test } from "bun:test"
import { BUILD_NODES, selectBuildNodes } from "./build-nodes"

// The single-harness tree has no separate Codex/Senpi plugin build: the OpenCode plugin bundle is
// the only harness artifact, and it must stay in the default graph.
const HARNESS_NODES = ["index", "tui", "cli"] as const

describe("build dependency graph", () => {
	test("#given the retired harness editions #when reading the graph #then no Codex/Senpi node remains", () => {
		const ids = BUILD_NODES.map((node) => node.id)

		expect(ids).not.toContain("codex-plugin")
		expect(ids).not.toContain("senpi-plugin")
	})

	test("#given a default build #when the graph is selected #then every OpenCode harness artifact is scheduled", () => {
		const selected = selectBuildNodes(BUILD_NODES, undefined)
		const selectedIds = selected.map((node) => node.id)

		for (const id of HARNESS_NODES) {
			expect(selectedIds).toContain(id)
		}
		expect(selectedIds).toContain("omo-schema")
	})

	test("#given the graph #when dependencies are inspected #then every dependency is a scheduled node", () => {
		const ids = new Set(BUILD_NODES.map((node) => node.id))
		const dangling = BUILD_NODES.flatMap((node) => node.deps.filter((dep) => !ids.has(dep)))

		expect(dangling).toEqual([])
	})
})
