import { useRef, useState, useEffect, useMemo } from 'react'
import { stratify, tree } from 'd3'
import type { HierarchyPointNode } from 'd3'
import type { AnySimulationStep, Block, BlockHash } from '../types'

interface Props {
  step: AnySimulationStep
}

const MARGIN = { top: 30, right: 100, bottom: 50, left: 70 }

function hLink(s: HierarchyPointNode<Block>, t: HierarchyPointNode<Block>): string {
  const mid = (s.y + t.y) / 2
  return `M${s.y},${s.x}C${mid},${s.x} ${mid},${t.x} ${t.y},${t.x}`
}

export default function BlockchainPanel({ step }: Props) {
  const { blockchain, committedBlocks, viewStates, currentView } = step
  const proposalHash = viewStates[currentView]?.proposal?.hash

  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 900, h: 500 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setDims({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const innerW = dims.w - MARGIN.left - MARGIN.right
  const innerH = dims.h - MARGIN.top  - MARGIN.bottom

  const nodeW = Math.max(60, Math.min(110, Math.round(innerW / Math.max(blockchain.length, 1) * 0.7)))
  const nodeH = Math.max(32, Math.min(48, Math.round(innerH * 0.12)))

  const { nodes, links } = useMemo(() => {
    if (blockchain.length === 0 || innerW <= 0 || innerH <= 0) return { nodes: [], links: [] }

    try {
      const hashes = new Set((blockchain as Block[]).map(b => b.hash))
      const validBlocks = (blockchain as Block[]).filter(
        b => b.parentHash == null || hashes.has(b.parentHash)
      )

      const root = stratify<Block>()
        .id(b => b.hash)
        .parentId(b => b.parentHash)(validBlocks)

      const layout = tree<Block>()
        .size([innerH, innerW])
        .separation(() => 1)

      const pointRoot = layout(root) as HierarchyPointNode<Block>
      return {
        nodes: pointRoot.descendants(),
        links: pointRoot.links(),
      }
    } catch {
      return { nodes: [], links: [] }
    }
  }, [blockchain, innerW, innerH])

  const hashChars = Math.max(6, Math.min(10, Math.round(nodeW / 8)))
  const fontSize  = Math.max(8, Math.min(11, Math.round(nodeH * 0.24)))

  return (
    <div ref={containerRef} className="w-full h-full">
      <svg width={dims.w} height={dims.h}>
        <text x={12} y={20} fill="#6b7280" fontSize={11} fontFamily="monospace">BLOCKCHAIN</text>

        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
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

        <g transform={`translate(12, ${dims.h - 14})`}>
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
