// Paths the published payload must always carry: the LSP runtime is resolved out of the
// installed package, so a missing entry dies at first use rather than at install time.
export function requiredPayloadPaths() {
  return [
    "packages/lsp-core/package.json",
    "packages/lsp-core/src/index.ts",
  ]
}

export function findMissingPayloadPaths(packedPaths, requiredPaths) {
  const packed = new Set(packedPaths)
  return requiredPaths.filter((requiredPath) => !packed.has(requiredPath))
}
