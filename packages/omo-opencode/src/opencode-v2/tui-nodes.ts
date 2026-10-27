import type { JSX } from "@opentui/solid/jsx-runtime"

import type { ViewNode } from "../features/tui-sidebar/element-helpers"

/**
 * The three container operations a TUI slot needs, lifted out of `@opentui/solid` so a test can
 * build the same tree without a renderer. The real runtime passes the module itself; the fake one
 * in the self-test records plain objects.
 */
export type TuiSolidRuntime<Node = unknown> = {
  readonly createElement: (tag: string) => Node
  readonly insert: (
    parent: Node,
    child: unknown,
    marker?: unknown,
    initial?: unknown,
  ) => unknown
  readonly setProp: (
    node: Node,
    name: string,
    value: unknown,
    previous?: unknown,
  ) => unknown
}

/**
 * Materializes the sidebar's view nodes. Identical shape to the V1 renderer: one column box, one
 * element per view node, text nodes carrying their own children.
 */
export function materializeNodes<Node>(
  nodes: readonly ViewNode[],
  solid: TuiSolidRuntime<Node>,
): Node {
  const root = solid.createElement("box")
  solid.setProp(root, "flexDirection", "column")
  for (const node of nodes) {
    solid.insert(root, materializeNode(node, solid))
  }
  return root
}

function materializeNode<Node>(node: ViewNode, solid: TuiSolidRuntime<Node>): Node {
  const element = solid.createElement(node.kind)
  for (const [name, value] of Object.entries(node.props)) {
    solid.setProp(element, name, value)
  }
  if (node.kind === "text") {
    solid.insert(element, node.text ?? "")
  }
  for (const child of node.children ?? []) {
    solid.insert(element, materializeNode(child, solid))
  }
  return element
}

/**
 * OpenTUI's `JSX.Element` is Solid's element type; a Renderable is exactly what the runtime accepts.
 * The cast is the only place that bridge is asserted.
 */
export function slotElement<Node>(node: Node): JSX.Element {
  return node as unknown as JSX.Element
}
