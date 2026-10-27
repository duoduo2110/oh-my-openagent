import { describe, expect, test } from "bun:test"
import { BUILD_NODES, selectBuildNodes } from "./build-nodes"

describe("selectBuildNodes", () => {
	test("#given no profile #when the graph is selected #then every node runs", () => {
		expect(selectBuildNodes(BUILD_NODES, undefined)).toEqual([...BUILD_NODES])
		expect(selectBuildNodes(BUILD_NODES, "")).toEqual([...BUILD_NODES])
	})

	test("#given a profile naming a node with dependencies #when selected #then the dependency closure comes with it", () => {
		const graph = [
			{ id: "leaf", command: "bun", args: [], deps: [] },
			{ id: "middle", command: "bun", args: [], deps: ["leaf"] },
			{ id: "top", command: "bun", args: [], deps: ["middle"] },
			{ id: "unrelated", command: "bun", args: [], deps: [] },
		]
		const selected = selectBuildNodes(graph, "test-closure", { "test-closure": ["top"] }).map((node) => node.id)
		expect(selected).toEqual(["leaf", "middle", "top"])
	})

	test("#given an unknown profile or an unknown node #when selected #then it fails loudly instead of building nothing", () => {
		expect(() => selectBuildNodes(BUILD_NODES, "does-not-exist")).toThrow(/unknown build profile/)
		expect(() => selectBuildNodes(BUILD_NODES, "broken", { broken: ["no-such-node"] })).toThrow(/unknown node/)
	})

	test("#given the declared graph #when every dependency is resolved #then no node depends on a missing id", () => {
		const ids = new Set(BUILD_NODES.map((node) => node.id))
		for (const node of BUILD_NODES) {
			for (const dep of node.deps) expect(ids).toContain(dep)
		}
	})
})
