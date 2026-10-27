export type BuildNode = {
	id: string
	command: string
	args: string[]
	deps: string[]
}

const OPENTUI_EXTERNALS = ["@opentui/core", "@opentui/keymap", "@opentui/solid"]

export const BUILD_NODES: BuildNode[] = [
	{ id: "git-bash-mcp", command: "bun", args: ["run", "build:git-bash-mcp"], deps: [] },
	{ id: "ast-grep-mcp", command: "bun", args: ["run", "build:ast-grep-mcp"], deps: [] },
	{ id: "lsp-tools-mcp", command: "bun", args: ["run", "build:lsp-tools-mcp"], deps: [] },
	{ id: "lsp-daemon", command: "bun", args: ["run", "build:lsp-daemon"], deps: [] },
	{ id: "index", command: "bun", args: ["build", "packages/omo-opencode/src/index.ts", "--outdir", "dist", "--target", "bun", "--format", "esm", "--external", "zod"], deps: [] },
	{ id: "tui", command: "bun", args: ["build", "packages/omo-opencode/src/tui.ts", "--outdir", "dist", "--target", "bun", "--format", "esm", ...OPENTUI_EXTERNALS.flatMap((name) => ["--external", name])], deps: [] },
	{ id: "shared-skills-assets", command: "bun", args: ["run", "build:skills-assets"], deps: ["index"] },
	{ id: "node-require-shim", command: "bun", args: ["run", "build:node-require-shim"], deps: ["index"] },
	{ id: "declarations", command: "tsc", args: ["--emitDeclarationOnly"], deps: [] },
	{ id: "cli", command: "bun", args: ["build", "packages/omo-opencode/src/cli/index.ts", "--outdir", "dist/cli", "--target", "bun", "--format", "esm"], deps: [] },
	{ id: "cli-node", command: "bun", args: ["run", "build:cli-node"], deps: [] },
	{ id: "schema", command: "bun", args: ["run", "build:schema"], deps: [] },
	{ id: "omo-schema", command: "bun", args: ["run", "build:omo-schema"], deps: [] },
]

/**
 * A profile names the nodes a consumer actually needs; its dependency closure is added
 * automatically. No profile is defined while the plugin bundle is the only consumer.
 */
export const BUILD_PROFILES: Record<string, readonly string[]> = {}

export function selectBuildNodes(
	graph: readonly BuildNode[],
	profile: string | undefined,
	profiles: Record<string, readonly string[]> = BUILD_PROFILES,
): BuildNode[] {
	if (profile === undefined || profile === "") return [...graph]
	const requested = profiles[profile]
	if (requested === undefined) {
		throw new Error(`unknown build profile: ${profile} (known: ${Object.keys(profiles).join(", ")})`)
	}
	const byId = new Map(graph.map((node) => [node.id, node]))
	const keep = new Set<string>()
	const visit = (id: string): void => {
		if (keep.has(id)) return
		const node = byId.get(id)
		if (node === undefined) throw new Error(`build profile ${profile} names an unknown node: ${id}`)
		keep.add(id)
		for (const dep of node.deps) visit(dep)
	}
	for (const id of requested) visit(id)
	return graph.filter((node) => keep.has(node.id))
}
