import { useRef, useEffect } from 'react'
import { useSimStore } from '../store/useSimStore'
import type { AnySimulationStep, SimConfig, ViewSummary } from '../types'
import { REGISTRY } from '../engine/registry'
import StatusBar from './StatusBar'
import ControlsBar from './ControlsBar'
import ConfigPanel from './ConfigPanel'
import ReplicaPanel from './ReplicaPanel'
import BlockchainPanel from './BlockchainPanel'

function ViewHistoryPanel({ summaries, n }: { summaries: readonly ViewSummary[]; n: number }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [summaries.length])

  return (
    <div className="h-full flex flex-col overflow-hidden bg-gray-900/40 border border-gray-800 rounded font-mono text-xs">
      <div className="shrink-0 flex gap-3 px-2 py-1 border-b border-gray-700 text-gray-500 uppercase tracking-wide">
        <span className="w-8">View</span>
        <span className="w-8">Lead</span>
        <span className="w-16">QC block</span>
        <span className="w-16">Commit</span>
        <span className="flex-1">Replicas voted</span>
        <span className="w-14 text-right">Msgs</span>
      </div>
      <div className="flex-1 overflow-auto">
        {summaries.map(s => {
          const allReplicas = Array.from({ length: n }, (_, i) => i)
          return (
            <div key={s.view} className="flex items-center gap-3 px-2 py-0.5 border-b border-gray-800/50">
              <span className="w-8 text-gray-500">v{s.view}</span>
              <span className="w-8 text-yellow-400">{s.leader >= 0 ? `R${s.leader}` : '—'}</span>
              {s.timedOut
                ? <span className="w-16 text-red-400">TIMEOUT</span>
                : <span className="w-16 text-blue-400">{s.qcBlock ? s.qcBlock.slice(0, 6) + '...' : '-'}</span>
              }
              {s.committed
                ? <span className="w-16 text-green-400">{s.committed.slice(0, 6)}...</span>
                : <span className="w-16 text-gray-600">-</span>
              }
              <span className="flex-1 flex gap-1">
                {allReplicas.map(id => (
                  <span
                    key={id}
                    style={{ color: s.participating.includes(id) ? '#d1d5db' : '#374151' }}
                  >
                    R{id}
                  </span>
                ))}
              </span>
              <span className="w-14 text-right text-gray-500">{s.messageCount}</span>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500">{label}: </span>
      <span className="text-gray-200">{value}</span>
    </div>
  )
}

function CompletionSummary({
  config,
  finalStep,
  viewSummaries,
}: {
  config:        SimConfig
  finalStep:     AnySimulationStep
  viewSummaries: readonly ViewSummary[]
}) {
  const blocksCommitted = finalStep.committedBlocks.length
  const viewsCompleted  = viewSummaries.length
  const timedOutViews   = viewSummaries.filter(s => s.timedOut).length
  const totalSteps      = finalStep.stepIndex
  const totalMsgs       = finalStep.deliveredMessages.length
  const efficiency      = blocksCommitted > 0
    ? (totalSteps / blocksCommitted).toFixed(1)
    : '-'
  const faults = config.byzantineReplicas.length > 0
    ? config.byzantineReplicas.map(b => `R${b.id as number} (${b.strategy})`).join(', ')
    : 'none'
  const protocolName = REGISTRY[config.protocol]?.displayName ?? config.protocol

  return (
    <div className="h-full px-3 py-2 bg-gray-900 border border-green-900 border-l-2 border-l-green-500 rounded font-mono text-xs text-gray-100 overflow-auto">
      <div className="text-green-400 font-semibold mb-2">RUN COMPLETE</div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
        <StatRow label="Protocol"   value={protocolName} />
        <StatRow label="Replicas"   value={`n=${config.n}  f=${config.f}`} />
        <StatRow label="Committed"  value={`${blocksCommitted} block${blocksCommitted !== 1 ? 's' : ''}`} />
        <StatRow label="Views done" value={`${viewsCompleted}`} />
        <StatRow label="Timeouts"   value={`${timedOutViews}`} />
        <StatRow label="Steps"      value={`${totalSteps}`} />
        <StatRow label="Messages"   value={`${totalMsgs}`} />
        <StatRow label="Efficiency" value={`${efficiency} steps/block`} />
        <StatRow label="Faults"     value={faults} />
      </div>
    </div>
  )
}

export default function SimCanvas() {
  const status           = useSimStore(s => s.status)
  const steps            = useSimStore(s => s.steps)
  const currentStepIndex = useSimStore(s => s.currentStepIndex)
  const config           = useSimStore(s => s.config)
  const narrative        = useSimStore(s => s.narrative)
  const viewSummaries    = useSimStore(s => s.viewSummaries)

  if (status === 'IDLE') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <ConfigPanel />
      </div>
    )
  }

  const currentStep = steps[currentStepIndex]
  if (!currentStep) return null

  const hasHistory = viewSummaries.length > 0
  const isAtEnd    = status === 'COMPLETED' && currentStepIndex === steps.length - 1
  const finalStep  = steps[steps.length - 1]

  return (
    <>
      <StatusBar step={currentStep} status={status} maxViews={config.maxViews} protocol={config.protocol} />
      <ControlsBar />
      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/2 border-r border-gray-800 p-2">
          <ReplicaPanel step={currentStep} config={config} />
        </div>
        <div className="flex-1 p-2 flex flex-col gap-2">
          <div className="min-h-0" style={{ flex: 3 }}>
            <BlockchainPanel step={currentStep} />
          </div>
          {hasHistory && (
            <div className="min-h-0" style={{ flex: 1 }}>
              <ViewHistoryPanel summaries={viewSummaries} n={config.n} />
            </div>
          )}
          <div className="min-h-0" style={{ flex: isAtEnd ? 2 : 1 }}>
            {isAtEnd ? (
              <CompletionSummary
                config={config}
                finalStep={finalStep}
                viewSummaries={viewSummaries}
              />
            ) : (
              <div className="h-full px-3 py-2 bg-gray-900 border border-gray-700 border-l-2 border-l-blue-500 rounded font-mono text-sm text-gray-100 overflow-auto">
                {narrative}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
