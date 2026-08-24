import type { AnySimulationStep, SimulationStatus } from '../types'
import { REGISTRY } from '../engine/registry'

interface Props {
  step:     AnySimulationStep
  status:   SimulationStatus
  maxViews: number
  protocol: string
}

const STATUS_COLOR: Record<SimulationStatus, string> = {
  IDLE:      'bg-gray-600',
  RUNNING:   'bg-green-700',
  PAUSED:    'bg-yellow-700',
  COMPLETED: 'bg-blue-700',
  FAULT:     'bg-red-700',
}

export default function StatusBar({ step, status, maxViews, protocol }: Props) {
  const vs            = step.viewStates[step.currentView]
  const rawPhase       = vs?.phase ?? '—'
  const phase         = (rawPhase as string).replace(/_/g, ' ')
  const protocolName  = REGISTRY[protocol]?.displayName ?? protocol
  const hasHeightRound = !!vs && 'height' in vs && 'round' in vs

  return (
    <div className="flex items-center gap-6 px-6 h-14 bg-gray-900 border-b border-gray-800 text-sm font-mono shrink-0">
      <span className="text-blue-400 font-semibold">{protocolName}</span>
      <div className="w-px h-4 bg-gray-700" />
      {hasHeightRound ? (
        <>
          <Item label="Height" value={String((vs as { height: number }).height)} />
          <Item label="Round"  value={String((vs as { round: number }).round)} />
        </>
      ) : (
        <Item label="View" value={`${step.currentView} / ${maxViews}`} />
      )}
      <Item label="Phase" value={phase} />
      <Item label="Step"  value={String(step.stepIndex)} />
      <span className={`ml-auto px-2 py-0.5 rounded text-xs font-semibold ${STATUS_COLOR[status]}`}>
        {status}
      </span>
    </div>
  )
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-gray-400">
      {label}{' '}
      <span className="text-white">{value}</span>
    </span>
  )
}
