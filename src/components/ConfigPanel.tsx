import { useState } from 'react'
import { useSimStore } from '../store/useSimStore'
import type { ByzantineFaultStrategy, SimConfig } from '../types'
import type { ReplicaId } from '../types'
import { REGISTRY } from '../engine/registry'
import ByzantineFaultPicker, { availableStrategiesFor, reconcileByzantineMap, pruneReplicaCount } from './ByzantineFaultPicker'

const INPUT = 'w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-sm text-center'

export default function ConfigPanel() {
  const setConfig = useSimStore(s => s.setConfig)
  const start     = useSimStore(s => s.start)
  const speed     = useSimStore(s => s.speed)

  const [n,               setN]               = useState(4)
  const [maxViews,        setMaxViews]        = useState(10)
  const [viewTimeoutSecs, setViewTimeoutSecs] = useState(3)
  const [seed,            setSeed]            = useState(42)
  const [dropPct,         setDropPct]         = useState(0)
  const [protocol,        setProtocol]        = useState<SimConfig['protocol']>('chained')
  const [byzantineMap,    setByzantineMap]    = useState<Map<number, ByzantineFaultStrategy>>(new Map())

  const isCFT   = protocol === 'paxos' || protocol === 'raft'
  const f       = isCFT ? Math.floor((n - 1) / 2) : Math.floor((n - 1) / 3)
  const isValid = byzantineMap.size <= f

  const availableStrategies = availableStrategiesFor(protocol)

  function handleNChange(newN: number) {
    setN(newN)
    setByzantineMap(prev => pruneReplicaCount(prev, newN))
  }

  function handleProtocolChange(p: SimConfig['protocol']) {
    setProtocol(p)
    setByzantineMap(prev => reconcileByzantineMap(prev, availableStrategiesFor(p)))
  }

  function handleStart() {
    const byzantineReplicas = Array.from(byzantineMap.entries()).map(
      ([id, strategy]) => ({ id: id as ReplicaId, strategy }),
    )
    const viewTimeout = Math.max(1, Math.round(viewTimeoutSecs * 1000 / speed))
    setConfig({ n, f, byzantineReplicas, viewTimeout, maxViews, seed, protocol, dropRate: dropPct / 100 })
    start()
  }

  const protocols = Object.values(REGISTRY).map(p => ({
    id:   p.id as SimConfig['protocol'],
    name: p.displayName,
  }))

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-80 font-mono flex flex-col gap-5">
      <h1 className="text-white text-base font-semibold tracking-tight text-center">
        Consensus Visualizer
      </h1>

      <div className="flex rounded-lg overflow-hidden border border-gray-700 text-xs">
        {protocols.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => handleProtocolChange(p.id)}
            className={`flex-1 py-1.5 transition-colors ${
              protocol === p.id ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="flex gap-4 justify-between">
        <label className="flex flex-col gap-1 items-center text-xs text-gray-400">
          Replicas
          <input
            type="number" min={4} max={9} step={1}
            value={n}
            onChange={e => handleNChange(Math.max(4, Math.min(9, Number(e.target.value))))}
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1 items-center text-xs text-gray-400">
          Views
          <input
            type="number" min={5} max={50} step={1}
            value={maxViews}
            onChange={e => setMaxViews(Math.max(5, Math.min(50, Number(e.target.value))))}
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1 items-center text-xs text-gray-400">
          Seed
          <input
            type="number"
            value={seed}
            onChange={e => setSeed(Number(e.target.value))}
            className={INPUT}
          />
        </label>
      </div>

      <p className="text-xs text-gray-500 text-center">
        f = {f} — up to {f} {isCFT ? 'crash-faulty' : 'Byzantine'} replica{f !== 1 ? 's' : ''} allowed
      </p>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-gray-400">
          <span>View timeout</span>
          <span className="text-white">{viewTimeoutSecs}s</span>
        </div>
        <input
          type="range"
          min={0.5} max={10} step={0.5}
          value={viewTimeoutSecs}
          onChange={e => setViewTimeoutSecs(Number(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-gray-400">
          <span>Packet drop rate</span>
          <span className="text-white">{dropPct}%</span>
        </div>
        <input
          type="range"
          min={0} max={40} step={5}
          value={dropPct}
          onChange={e => setDropPct(Number(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>

      <ByzantineFaultPicker
        n={n}
        byzantineMap={byzantineMap}
        setByzantineMap={setByzantineMap}
        availableStrategies={availableStrategies}
        f={f}
      />

      {!isValid && (
        <p className="text-xs text-red-400 text-center">
          Too many {isCFT ? 'crash-faulty' : 'Byzantine'} replicas — safety requires at most {f}
        </p>
      )}

      <button
        onClick={handleStart}
        disabled={!isValid}
        className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-white text-sm font-semibold transition-colors"
      >
        Start Simulation
      </button>
    </div>
  )
}
