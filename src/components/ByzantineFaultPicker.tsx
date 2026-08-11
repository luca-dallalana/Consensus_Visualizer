import type { Dispatch, SetStateAction } from 'react'
import type { ByzantineFaultStrategy } from '../types'

export const ALL_STRATEGIES: ByzantineFaultStrategy[] = [
  'SILENT', 'EQUIVOCATE', 'WRONG_BLOCK', 'DELAY', 'INVALID_QC',
]

const SELECT = 'bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs'

export function availableStrategiesFor(protocol: string): ByzantineFaultStrategy[] {
  if (protocol === 'paxos' || protocol === 'raft') {
    return ALL_STRATEGIES.filter(s => s === 'SILENT' || s === 'DELAY')
  }
  if (protocol === 'pbft' || protocol === 'tendermint' || protocol === 'algorand') {
    return ALL_STRATEGIES.filter(s => s !== 'INVALID_QC')
  }
  return ALL_STRATEGIES
}

export function reconcileByzantineMap(
  map: Map<number, ByzantineFaultStrategy>,
  availableStrategies: readonly ByzantineFaultStrategy[],
): Map<number, ByzantineFaultStrategy> {
  const next = new Map(map)
  for (const [id, s] of next.entries()) {
    if (!availableStrategies.includes(s)) next.set(id, 'SILENT')
  }
  return next
}

export function pruneReplicaCount(
  map: Map<number, ByzantineFaultStrategy>,
  newN: number,
): Map<number, ByzantineFaultStrategy> {
  const next = new Map(map)
  for (const id of next.keys()) {
    if (id >= newN) next.delete(id)
  }
  return next
}

interface ByzantineFaultPickerProps {
  n:                   number
  byzantineMap:        Map<number, ByzantineFaultStrategy>
  setByzantineMap:     Dispatch<SetStateAction<Map<number, ByzantineFaultStrategy>>>
  availableStrategies: readonly ByzantineFaultStrategy[]
  f:                   number
}

export default function ByzantineFaultPicker(
  { n, byzantineMap, setByzantineMap, availableStrategies, f }: ByzantineFaultPickerProps,
) {
  function toggleReplica(id: number, checked: boolean) {
    setByzantineMap(prev => {
      const next = new Map(prev)
      if (checked) {
        next.set(id, 'SILENT')
      } else {
        next.delete(id)
      }
      return next
    })
  }

  function setStrategy(id: number, strategy: ByzantineFaultStrategy) {
    setByzantineMap(prev => new Map(prev).set(id, strategy))
  }

  const byzantineIds = Array.from(byzantineMap.keys())
  const overLimit     = byzantineMap.size > f ? byzantineIds.slice(f) : []

  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: n }, (_, id) => {
        const isByz    = byzantineMap.has(id)
        const strategy = byzantineMap.get(id)
        const isOver   = overLimit.includes(id)

        return (
          <div
            key={id}
            className={`flex items-center gap-3 px-2 py-1.5 rounded text-sm ${
              isOver ? 'border border-red-800 bg-red-950/30' : 'border border-transparent'
            }`}
          >
            <span className="text-gray-300 w-6">R{id}</span>
            <input
              type="checkbox"
              checked={isByz}
              onChange={e => toggleReplica(id, e.target.checked)}
              className="accent-blue-500"
            />
            {isByz && strategy != null
              ? (
                <select
                  value={strategy}
                  onChange={e => setStrategy(id, e.target.value as ByzantineFaultStrategy)}
                  className={SELECT}
                >
                  {availableStrategies.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              )
              : <span className="text-gray-600 text-xs">honest</span>
            }
          </div>
        )
      })}
    </div>
  )
}
