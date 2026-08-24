import { useRef, useState, useEffect, useMemo } from 'react'
import { stratify, tree } from 'd3'
import type { HierarchyPointNode } from 'd3'
import type { AnySimulationStep, Block, BlockHash } from '../types'

interface Props {
  step: AnySimulationStep
}

const MARGIN = { top: 44, right: 100, bottom: 16, left: 70 }
const LEGEND_H = 26
const MAX_TREE_H = 260

function hLink(s: HierarchyPointNode<Block>, t: HierarchyPointNode<Block>): string {
  const mid = (s.y + t.y) / 2
  return `M${s.y},${s.x}C${mid},${s.x} ${mid},${t.x} ${t.y},${t.x}`
}

export default function BlockchainPanel({ step }: Props) {
  const { blockchain, committedBlocks, viewStates, currentView } = step
  const proposalHash = viewStates[currentView]?.proposal?.hash

  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const nodeW = 90
  const nodeH = 36
  const depthSpacing   = nodeW + 50
  const siblingSpacing = nodeH + 16

  const { nodes, links, treeW, treeH } = useMemo(() => {
    if (blockchain.length === 0) return { nodes: [], links: [], treeW: 0, treeH: 0 }

    try {
      const hashes = new Set((blockchain as Block[]).map(b => b.hash))
      const validBlocks = (blockchain as Block[]).filter(
        b => b.parentHash == null || hashes.has(b.parentHash)
      )

      const root = stratify<Block>()
        .id(b => b.hash)
        .parentId(b => b.parentHash)(validBlocks)

      const layout = tree<Block>().nodeSize([siblingSpacing, depthSpacing])

      const pointRoot = layout(root) as HierarchyPointNode<Block>
      const nodes = pointRoot.descendants()
      const maxY  = Math.max(0, ...nodes.map(n => n.y))
      const xs    = nodes.map(n => n.x)
      const treeH = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0
      return { nodes, links: pointRoot.links(), treeW: maxY, treeH }
    } catch {
      return { nodes: [], links: [], treeW: 0, treeH: 0 }
    }
  }, [blockchain, siblingSpacing, depthSpacing])

  const xs = nodes.map(n => n.x)
  const vOffset = xs.length > 0 ? -Math.min(...xs) : 0

  const hashChars = 8
  const fontSize  = 10
  const svgWidth  = Math.max(width, treeW + MARGIN.left + MARGIN.right + nodeW)
  const svgHeight = treeH + MARGIN.top + MARGIN.bottom

  return (
    <div ref={containerRef} className="w-full flex flex-col">
      <div className="overflow-auto" style={{ maxHeight: MAX_TREE_H }}>
        <svg width={svgWidth} height={svgHeight}>
          <text x={12} y={20} fill="#6b7280" fontSize={11} fontFamily="monospace">BLOCKCHAIN</text>

          <g transform={`translate(${MARGIN.left},${MARGIN.top + vOffset})`}>
          {links.map((link, i) => (
            <path
              key={i}
              d={hLink(link.source as HierarchyPointNode<Block>, link.target as HierarchyPointNode<Block>)}
              fill="none"
              stroke="#374151"
              strokeWidth={1.5}
            />
          ))}

          {nodes.map(node => {
            const hash        = node.data.hash as BlockHash
            const isGenesis   = (node.data.view as number) === -1
            const isCommitted = committedBlocks.includes(hash)
            const isProposal  = hash === proposalHash

            const fill   = isCommitted ? '#14532d' : isProposal ? '#78350f' : isGenesis ? '#1f2937' : '#1e3a5f'
            const stroke = isCommitted ? '#22c55e' : isProposal ? '#f59e0b' : '#4b5563'

            return (
              <g key={hash} transform={`translate(${node.y},${node.x})`}>
                <rect
                  x={-nodeW / 2} y={-nodeH / 2}
                  width={nodeW}  height={nodeH}
                  rx={5}
                  fill={fill} stroke={stroke} strokeWidth={1.5}
                />
                <text textAnchor="middle" y={-nodeH * 0.14} fill="#e5e7eb" fontSize={fontSize} fontFamily="monospace">
                  {hash.slice(0, hashChars)}
                </text>
                <text textAnchor="middle" y={nodeH * 0.28} fill="#9ca3af" fontSize={Math.max(7, fontSize - 1)} fontFamily="monospace">
                  {isGenesis
                    ? 'genesis'
                    : `v${node.data.view as number}  R${node.data.proposer as number}`}
                </text>
              </g>
            )
          })}
          </g>
        </svg>
      </div>

      <svg width={width} height={LEGEND_H} className="shrink-0">
        <g transform={`translate(12, ${LEGEND_H - 12})`}>
          {([
            ['committed', '#22c55e', '#14532d'],
            ['proposal',  '#f59e0b', '#78350f'],
            ['pending',   '#4b5563', '#1e3a5f'],
          ] as const).map(([label, stroke, fill], i) => (
            <g key={label} transform={`translate(${i * 100}, 0)`}>
              <rect x={0} y={-8} width={14} height={10} rx={2} fill={fill} stroke={stroke} strokeWidth={1} />
              <text x={18} y={2} fill={stroke} fontSize={9} fontFamily="monospace">{label}</text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  )
}
