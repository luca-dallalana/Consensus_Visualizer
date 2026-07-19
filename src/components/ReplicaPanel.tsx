import { useRef, useState, useEffect } from 'react'
import type { AnySimulationStep, SimConfig } from '../types'
import { REGISTRY } from '../engine/registry'

interface Props {
  step:   AnySimulationStep
  config: SimConfig
}

function arcPath(fromX: number, toX: number, y: number, minY: number): string {
  const midX = (fromX + toX) / 2
  const h    = Math.min(Math.abs(toX - fromX) * 0.5, y - minY)
  return `M ${fromX} ${y} Q ${midX} ${y - h} ${toX} ${y}`
}

function arcMidpoint(fromX: number, toX: number, y: number, minY: number): { x: number; y: number } {
  const midX       = (fromX + toX) / 2
  const h          = Math.min(Math.abs(toX - fromX) * 0.5, y - minY)
  const effectiveH = Math.max(h, (y - minY) * 0.38)
  const rawY       = y - effectiveH * 0.95 - 18
  return { x: midX, y: Math.max(minY + 28, rawY) }
}

export default function ReplicaPanel({ step, config }: Props) {
  const { n } = config
  const plugin = REGISTRY[config.protocol]
  const vs     = step.viewStates[step.currentView]
  const leader = vs != null ? (vs.leader as number) : -1

  const svgContainerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 600, h: 320 })

  useEffect(() => {
    const el = svgContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setDims({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { w, h } = dims
  const spacing  = w / (n + 1)
  const radius   = Math.max(16, Math.min(50, Math.round(Math.min(h * 0.13, spacing * 0.43))))
  const replicaY = Math.round(h * 0.62)
  const arcMinY  = Math.round(h * 0.10)

  const replicaX = (id: number) => Math.round((id + 1) * w / (n + 1))

  const msgTypeMap = plugin.messageTypeMap

  function getMsgStyle(type: string) {
    return msgTypeMap[type] ?? { color: '#6b7280', label: type, broadcastArc: false }
  }

  function toIds(msg: { from: unknown; to: unknown; type: string }): number[] {
    if (msg.to === 'broadcast') {
      return Array.from({ length: n }, (_, i) => i).filter(i => i !== (msg.from as number))
    }
    return [msg.to as number]
  }

  const allPending    = step.pendingMessages as readonly { id: string; from: unknown; to: unknown; type: string }[]
  const allDelivered  = step.deliveredMessages as readonly { id: string; from: unknown; to: unknown; type: string }[]
  const pending       = allPending.slice(-8)
  const lastDelivered = allDelivered.length > 0 ? allDelivered[allDelivered.length - 1] : undefined

  const arcLabel = lastDelivered != null ? (() => {
    const tIds  = toIds(lastDelivered)
    if (tIds.length === 0) return null
    const repId = tIds[Math.floor(tIds.length / 2)]
    const mid   = arcMidpoint(replicaX(lastDelivered.from as number), replicaX(repId), replicaY, arcMinY)
    const style = getMsgStyle(lastDelivered.type)
    const toStr = lastDelivered.to === 'broadcast' ? 'ALL' : `R${lastDelivered.to as number}`
    return {
      x:     mid.x,
      y:     mid.y,
      color: style.color,
      type:  style.label,
      flow:  `R${lastDelivered.from as number} → ${toStr}`,
    }
  })() : null

  const allMsgTypes  = Object.keys(msgTypeMap)
  const legendEntries = Object.entries(msgTypeMap).map(([, s]) => [s.label, s.color] as [string, string])

  const labelSize    = Math.max(9, Math.round(radius * 0.30))
  const replicaFSize = Math.max(12, Math.round(radius * 0.44))
  const phaseFSize   = Math.max(10, Math.round(radius * 0.34))
  const legendSpacing = Math.min(140, Math.round(w / (legendEntries.length + 1)))

  const rowsNeeded = legendEntries.length > 5 ? 2 : 1
  const itemsPerRow = rowsNeeded === 2 ? Math.ceil(legendEntries.length / 2) : legendEntries.length
  const rowSpacing  = Math.min(140, Math.round(w / (itemsPerRow + 1)))

  return (
    <div className="flex flex-col h-full">
      <div ref={svgContainerRef} className="flex-1 min-h-0">
        <svg width="100%" height="100%">
          <defs>
            {allMsgTypes.map(t => {
              const style = getMsgStyle(t)
              const id    = t.toLowerCase().replace(/_/g, '-')
              return (
                <>
                  <marker
                    key={`arr-${id}`}
                    id={`arr-${id}`}
                    markerWidth="6" markerHeight="6"
                    refX="5" refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L0,6 L6,3 z" fill={style.color} />
                  </marker>
                  <marker
                    key={`dot-${id}`}
                    id={`dot-${id}`}
                    markerWidth="5" markerHeight="5"
                    refX="2.5" refY="2.5"
                    orient="auto"
                  >
                    <circle cx="2.5" cy="2.5" r="2.5" fill={style.color} />
                  </marker>
                </>
              )
            })}
          </defs>

          {pending.map(msg =>
            toIds(msg).map(toId => {
              const style = getMsgStyle(msg.type)
              const mid   = msg.type.toLowerCase().replace(/_/g, '-')
              return (
                <path
                  key={`p-${msg.id}-${toId}`}
                  d={arcPath(replicaX(msg.from as number), replicaX(toId), replicaY, arcMinY)}
                  fill="none"
                  stroke={style.color}
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  opacity={0.45}
                  markerStart={`url(#dot-${mid})`}
                  markerEnd={`url(#arr-${mid})`}
                />
              )
            })
          )}

          {lastDelivered != null && toIds(lastDelivered).map(toId => {
            const style = getMsgStyle(lastDelivered.type)
            const mid   = lastDelivered.type.toLowerCase().replace(/_/g, '-')
            return (
              <path
                key={`d-${lastDelivered.id}-${toId}`}
                d={arcPath(replicaX(lastDelivered.from as number), replicaX(toId), replicaY, arcMinY)}
                fill="none"
                stroke={style.color}
                strokeWidth={2.5}
                markerStart={`url(#dot-${mid})`}
                markerEnd={`url(#arr-${mid})`}
              />
            )
          })}

          {arcLabel != null && (
            <g>
              <rect
                x={arcLabel.x - 36} y={arcLabel.y - 15}
                width={72} height={26}
                rx={4}
                fill="#0f172a" fillOpacity={0.92}
                stroke={arcLabel.color} strokeWidth={0.75}
              />
              <text
                x={arcLabel.x} y={arcLabel.y - 3}
                textAnchor="middle"
                fill={arcLabel.color}
                fontSize={9}
                fontFamily="monospace"
                fontWeight="bold"
              >
                {arcLabel.type}
              </text>
              <text
                x={arcLabel.x} y={arcLabel.y + 8}
                textAnchor="middle"
                fill="#9ca3af"
                fontSize={8}
                fontFamily="monospace"
              >
                {arcLabel.flow}
              </text>
            </g>
          )}

          {Array.from({ length: n }, (_, id) => {
            const cx          = replicaX(id)
            const isLeader    = id === leader
            const isByzantine = step.replicaStates[id]?.isByzantine ?? false
            const fill        = isByzantine ? '#991b1b' : '#1e3a5f'

            return (
              <g key={id}>
                {isLeader && (
                  <circle cx={cx} cy={replicaY} r={radius + Math.round(radius * 0.20)} fill="none" stroke="#fbbf24" strokeWidth={2} />
                )}
                <circle cx={cx} cy={replicaY} r={radius} fill={fill} />
                <text x={cx} y={replicaY + Math.round(replicaFSize * 0.35)} textAnchor="middle" fill="white" fontSize={replicaFSize} fontFamily="monospace">
                  R{id}
                </text>
                {isByzantine && (
                  <text x={cx} y={replicaY + radius + 22} textAnchor="middle" fill="#f87171" fontSize={11} fontFamily="monospace">
                    BYZ
                  </text>
                )}
              </g>
            )
          })}

          <text x={12} y={22} fill="#6b7280" fontSize={11} fontFamily="monospace">REPLICAS</text>
          {vs != null && leader >= 0 && (
            <text
              x={w / 2} y={22}
              textAnchor="middle"
              fill="#fbbf24"
              fontSize={phaseFSize}
              fontFamily="monospace"
            >
              {(vs.phase as string).replace(/_/g, ' ')}
            </text>
          )}

          {rowsNeeded === 2 ? (
            [0, itemsPerRow].map((rowStart, rowIdx) => (
              <g key={rowStart} transform={`translate(0, ${h - (rowIdx === 0 ? 28 : 14)})`}>
                {legendEntries.slice(rowStart, rowStart + itemsPerRow).map(([lbl, color], i) => (
                  <g key={lbl} transform={`translate(${12 + i * rowSpacing}, 0)`}>
                    <line x1={0} y1={0} x2={18} y2={0} stroke={color} strokeWidth={2} />
                    <text x={22} y={4} fill={color} fontSize={labelSize} fontFamily="monospace">{lbl}</text>
                  </g>
                ))}
              </g>
            ))
          ) : (
            <g transform={`translate(0, ${h - 14})`}>
              {legendEntries.map(([lbl, color], i) => (
                <g key={lbl} transform={`translate(${12 + i * legendSpacing}, 0)`}>
                  <line x1={0} y1={0} x2={18} y2={0} stroke={color} strokeWidth={2} />
                  <text x={22} y={4} fill={color} fontSize={labelSize} fontFamily="monospace">{lbl}</text>
                </g>
              ))}
            </g>
          )}
        </svg>
      </div>

      <div className="flex-1 min-h-0 border-t border-gray-800 flex flex-col overflow-hidden">
        <div className="flex shrink-0 text-gray-500 text-xs font-mono border-b border-gray-700">
          <div className="flex-1 text-center py-1">Replica</div>
          <div className="flex-1 text-center py-1">lockedQC</div>
          <div className="flex-1 text-center py-1">prepareQC</div>
          <div className="flex-1 text-center py-1">Vote</div>
        </div>
        <div className="flex-1 flex flex-col min-h-0">
          {Array.from({ length: n }, (_, id) => {
            const r           = step.replicaStates[id]
            const isLeader    = id === leader
            const isByzantine = r?.isByzantine ?? false
            const nameColor   = isLeader ? '#fbbf24' : isByzantine ? '#f87171' : '#d1d5db'
            const lockedView  = r?.lockedQC  != null ? `v${r.lockedQC.view  as number}` : '—'
            const prepareView = r?.prepareQC != null ? `v${r.prepareQC.view as number}` : '—'
            const votes       = plugin.getVotesForReplica(step, id as unknown as import('../types').ReplicaId, config)
            const voteLabel   = votes.length > 0 ? votes[0].blockHash.slice(0, 6) : '—'

            return (
              <div key={id} className="flex flex-1 items-center border-t border-gray-800/50 text-xs font-mono min-h-0">
                <div className="flex-1 text-center" style={{ color: nameColor }}>R{id}</div>
                <div className="flex-1 text-center" style={{ color: lockedView  === '—' ? '#4b5563' : '#f3f4f6' }}>{lockedView}</div>
                <div className="flex-1 text-center" style={{ color: prepareView === '—' ? '#4b5563' : '#f3f4f6' }}>{prepareView}</div>
                <div className="flex-1 text-center" style={{ color: voteLabel   === '—' ? '#4b5563' : '#4ade80' }}>{voteLabel}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
