export type AriaSnapshotNode = {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  backendDOMNodeId?: number
  depth: number
}

export type RawAXNode = {
  nodeId?: string
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string }
  description?: { value?: string }
  childIds?: string[]
  backendDOMNodeId?: number
  ignored?: boolean
}

function axValue(v: unknown): string {
  if (!v || typeof v !== 'object') return ''
  const value = (v as { value?: unknown }).value
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export function formatAriaSnapshot(nodes: RawAXNode[], limit: number): AriaSnapshotNode[] {
  const byId = new Map<string, RawAXNode>()
  for (const n of nodes) {
    if (n.nodeId) byId.set(n.nodeId, n)
  }
  const referenced = new Set<string>()
  for (const n of nodes) {
    for (const c of n.childIds ?? []) referenced.add(c)
  }
  const root = nodes.find(n => n.nodeId && !referenced.has(n.nodeId!)) ?? nodes[0]
  if (!root?.nodeId) return []

  const out: AriaSnapshotNode[] = []
  const stack: Array<{ id: string; depth: number }> = [{ id: root.nodeId, depth: 0 }]

  while (stack.length && out.length < limit) {
    const popped = stack.pop()
    if (!popped) break
    const { id, depth } = popped
    const n = byId.get(id)
    if (!n || n.ignored) continue

    const role = axValue(n.role)
    const name = axValue(n.name)
    const value = axValue(n.value)
    const description = axValue(n.description)
    const ref = `ax${out.length + 1}`

    out.push({
      ref,
      role: role || 'unknown',
      name: name || '',
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(typeof n.backendDOMNodeId === 'number' ? { backendDOMNodeId: n.backendDOMNodeId } : {}),
      depth,
    })

    const children = (n.childIds ?? []).filter(c => byId.has(c))
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child) stack.push({ id: child, depth: depth + 1 })
    }
  }

  return out
}