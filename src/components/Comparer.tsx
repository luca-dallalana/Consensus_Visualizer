import { useEffect, useMemo, useState } from 'react'
import { REGISTRY } from '../engine/registry'
import { PROTOCOL_PROFILES, type ProtocolProfile } from '../data/protocolProfiles'
import type { AnySimulationStep, ByzantineFaultStrategy, ReplicaId, SimConfig, SimulationStatus } from '../types'
import StatusBar from './StatusBar'
import ReplicaPanel from './ReplicaPanel'
import BlockchainPanel from './BlockchainPanel'
import ByzantineFaultPicker, { availableStrategiesFor, reconcileByzantineMap, pruneReplicaCount } from './ByzantineFaultPicker'

type Category = 'BFT' | 'CFT'
type RunState = 'IDLE' | 'RUNNING' | 'PAUSED'
type Terminal = 'COMPLETED' | 'FAULT' | null

const SPEEDS = [
  { label: '0.25×', ms: 4000 },
  { label: '0.5×',  ms: 2000 },
  { label: '1×',    ms: 1000 },
  { label: '2×',    ms: 500  },
  { label: '4×',    ms: 200  },
]

interface Side {
  steps:    AnySimulationStep[]
  terminal: Terminal
}

function advanceSide(side: Side, idx: number, protocol: string, config: SimConfig): Side {
  if (side.terminal != null) return side
  if (idx + 1 < side.steps.length) return side
  const plugin  = REGISTRY[protocol]
  const current = side.steps[side.steps.length - 1]
  const next    = plugin.advance(current, config)
  if (next.stepIndex === current.stepIndex) return { steps: side.steps, terminal: 'FAULT' }
  const terminal: Terminal = next.currentView >= config.maxViews ? 'COMPLETED' : null
  return { steps: [...side.steps, next], terminal }
}

function LiveColumn({ protocol, config, side, idx }: { protocol: string; config: SimConfig; side: Side; idx: number }) {
  if (side.steps.length === 0) return <div className="flex-1 border border-gray-800 rounded bg-gray-900/40" />
  const clamped = Math.min(idx, side.steps.length - 1)
  const step    = side.steps[clamped]
  const status: SimulationStatus = side.terminal ?? 'RUNNING'
  const plugin  = REGISTRY[protocol]
  const prev    = clamped > 0 ? side.steps[clamped - 1] : null
  const narrative = plugin.narrate(prev, step, config)

  return (
    <div className="flex-1 flex flex-col gap-2 min-w-0">
      <StatusBar step={step} status={status} maxViews={config.maxViews} protocol={protocol} />
      <div className="h-64 border border-gray-800 rounded p-2">
        <ReplicaPanel step={step} config={config} />
      </div>
      <div className="h-64 border border-gray-800 rounded p-2">
        <BlockchainPanel step={step} />
      </div>
      <div className="px-3 py-2 bg-gray-900 border border-gray-700 border-l-2 border-l-blue-500 rounded font-mono text-xs text-gray-100">
        {narrative}
      </div>
    </div>
  )
}

function LivePanel({ protocolA, protocolB, category }: { protocolA: string; protocolB: string; category: Category }) {
  const [n,        setN]        = useState(4)
  const [maxViews, setMaxViews] = useState(10)
  const [seed,     setSeed]     = useState(42)
  const [dropPct,  setDropPct]  = useState(0)
  const [byzantineMap, setByzantineMap] = useState<Map<number, ByzantineFaultStrategy>>(new Map())

  const [runState, setRunState] = useState<RunState>('IDLE')
  const [idx,      setIdx]      = useState(0)
  const [speed,    setSpeed]    = useState(1000)
  const [sideA,    setSideA]    = useState<Side>({ steps: [], terminal: null })
  const [sideB,    setSideB]    = useState<Side>({ steps: [], terminal: null })

  const isCFT = category === 'CFT'
  const f = isCFT ? Math.floor((n - 1) / 2) : Math.floor((n - 1) / 3)
  const isValid = byzantineMap.size <= f

  const availableStrategies = availableStrategiesFor(protocolA).filter(s => availableStrategiesFor(protocolB).includes(s))

  const byzantineReplicas = useMemo(
    () => Array.from(byzantineMap.entries()).map(([id, strategy]) => ({ id: id as ReplicaId, strategy })),
    [byzantineMap],
  )

  const baseConfig = useMemo(() => ({
    n, f, byzantineReplicas, viewTimeout: 10, maxViews, seed, dropRate: dropPct / 100,
  }), [n, f, byzantineReplicas, maxViews, seed, dropPct])

  const configA: SimConfig = { ...baseConfig, protocol: protocolA as SimConfig['protocol'] }
  const configB: SimConfig = { ...baseConfig, protocol: protocolB as SimConfig['protocol'] }

  function handleNChange(newN: number) {
    const clamped = Math.max(4, Math.min(9, newN))
    setN(clamped)
    setByzantineMap(prev => pruneReplicaCount(prev, clamped))
  }

  useEffect(() => {
    setRunState('IDLE'); setIdx(0)
    setSideA({ steps: [], terminal: null })
    setSideB({ steps: [], terminal: null })
    setByzantineMap(prev =>
      reconcileByzantineMap(prev, availableStrategiesFor(protocolA).filter(s => availableStrategiesFor(protocolB).includes(s))))
  }, [protocolA, protocolB])

  function start() {
    const step0A = REGISTRY[protocolA].init(configA)
    const step0B = REGISTRY[protocolB].init(configB)
    setSideA({ steps: [step0A], terminal: null })
    setSideB({ steps: [step0B], terminal: null })
    setIdx(0)
    setRunState('RUNNING')
  }

  function reset() {
    setRunState('IDLE'); setIdx(0)
    setSideA({ steps: [], terminal: null })
    setSideB({ steps: [], terminal: null })
  }

  function tick() {
    setSideA(s => advanceSide(s, idx, protocolA, configA))
    setSideB(s => advanceSide(s, idx, protocolB, configB))
    setIdx(i => i + 1)
  }

  const bothTerminal = sideA.terminal != null && sideB.terminal != null
  const maxLen        = Math.max(sideA.steps.length, sideB.steps.length)
  const atEnd          = idx + 1 >= maxLen
  const canStepForward = runState !== 'IDLE' && !(bothTerminal && atEnd)

  useEffect(() => {
    if (runState !== 'RUNNING') return
    if (bothTerminal && atEnd) { setRunState('PAUSED'); return }
    const id = setInterval(tick, speed)
    return () => clearInterval(id)
  })

  return (
    <div className="flex flex-col gap-3">
      {runState === 'IDLE' && (
        <div className="flex flex-col gap-3 text-xs font-mono">
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">Replicas
              <input type="number" min={4} max={9} value={n} onChange={e => handleNChange(Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-center" />
            </label>
            <label className="flex flex-col gap-1">Max views
              <input type="number" min={5} max={50} value={maxViews} onChange={e => setMaxViews(Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-center" />
            </label>
            <label className="flex flex-col gap-1">Seed
              <input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))}
                className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-center" />
            </label>
            <label className="flex flex-col gap-1">Drop %
              <input type="number" min={0} max={40} step={5} value={dropPct} onChange={e => setDropPct(Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-center" />
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-gray-500">
              f = {f} — up to {f} {isCFT ? 'crash-faulty' : 'Byzantine'} replica{f !== 1 ? 's' : ''} allowed (shared by both sides)
            </p>
            <ByzantineFaultPicker
              n={n}
              byzantineMap={byzantineMap}
              setByzantineMap={setByzantineMap}
              availableStrategies={availableStrategies}
              f={f}
            />
            {!isValid && (
              <p className="text-red-400">
                Too many {isCFT ? 'crash-faulty' : 'Byzantine'} replicas — safety requires at most {f}
              </p>
            )}
          </div>

          <button type="button" onClick={start} disabled={!isValid}
            className="self-start px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-30 disabled:cursor-not-allowed">
            Start
          </button>
        </div>
      )}

      {runState !== 'IDLE' && (
        <div className="flex items-center gap-3 text-xs font-mono">
          <button type="button" onClick={reset} className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600">Reset</button>
          <button type="button" onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx <= 0}
            className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed">&#8592;</button>
          {runState === 'RUNNING'
            ? <button type="button" onClick={() => setRunState('PAUSED')} className="px-3 py-1 rounded bg-blue-700 hover:bg-blue-600">Pause</button>
            : <button type="button" onClick={() => setRunState('RUNNING')} disabled={bothTerminal && atEnd}
                className="px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-30 disabled:cursor-not-allowed">Resume</button>
          }
          <button type="button" onClick={tick} disabled={!canStepForward}
            className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed">&#8594;</button>
          <select value={speed} onChange={e => setSpeed(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-white">
            {SPEEDS.map(o => <option key={o.ms} value={o.ms}>{o.label}</option>)}
          </select>
        </div>
      )}

      <div className="flex gap-3">
        <LiveColumn protocol={protocolA} config={configA} side={sideA} idx={idx} />
        <LiveColumn protocol={protocolB} config={configB} side={sideB} idx={idx} />
      </div>
    </div>
  )
}

const ROWS: { label: string; key: keyof ProtocolProfile }[] = [
  { label: 'Leader selection',      key: 'leaderSelection' },
  { label: 'Quorum',                key: 'quorum' },
  { label: 'Phases',                key: 'phases' },
  { label: 'Message complexity',    key: 'messageComplexity' },
  { label: 'Cross-view safety',     key: 'crossViewSafety' },
  { label: 'Distinguishing trait',  key: 'distinguishingTrait' },
  { label: 'Strength',              key: 'strength' },
  { label: 'Weakness',              key: 'weakness' },
]

const TAB = (active: boolean) =>
  `flex-1 py-1.5 transition-colors ${active ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`

export default function Comparer() {
  const [category,   setCategory]   = useState<Category | null>(null)
  const [protocolA,  setProtocolA]  = useState<string | null>(null)
  const [protocolB,  setProtocolB]  = useState<string | null>(null)
  const [viewMode,   setViewMode]   = useState<'static' | 'live'>('static')

  function pickCategory(c: Category) {
    setCategory(c)
    setProtocolA(null)
    setProtocolB(null)
  }

  const choices = category
    ? Object.values(REGISTRY).filter(p => PROTOCOL_PROFILES[p.id].category === category)
    : []

  const profileA = protocolA ? PROTOCOL_PROFILES[protocolA] : null
  const profileB = protocolB ? PROTOCOL_PROFILES[protocolB] : null

  const bothPicked = profileA != null && profileB != null

  return (
    <div className={`bg-gray-900 border border-gray-700 rounded-xl p-6 w-full mx-auto font-mono flex flex-col gap-5 ${viewMode === 'live' && bothPicked ? 'max-w-6xl' : 'max-w-4xl'}`}>
      <h1 className="text-white text-base font-semibold tracking-tight text-center">
        Protocol Comparer
      </h1>

      <div className="flex rounded-lg overflow-hidden border border-gray-700 text-xs">
        <button type="button" onClick={() => pickCategory('BFT')} className={TAB(category === 'BFT')}>BFT</button>
        <button type="button" onClick={() => pickCategory('CFT')} className={TAB(category === 'CFT')}>CFT</button>
      </div>

      {category && (
        <div className="flex gap-4">
          <div className="flex-1 flex flex-col gap-1.5">
            <span className="text-xs text-gray-500 text-center">Protocol A</span>
            <div className="flex flex-col rounded-lg overflow-hidden border border-gray-700 text-xs">
              {choices.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setProtocolA(p.id)}
                  disabled={p.id === protocolB}
                  className={`py-1.5 disabled:opacity-30 disabled:cursor-not-allowed ${TAB(protocolA === p.id)}`}
                >
                  {p.displayName}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 flex flex-col gap-1.5">
            <span className="text-xs text-gray-500 text-center">Protocol B</span>
            <div className="flex flex-col rounded-lg overflow-hidden border border-gray-700 text-xs">
              {choices.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setProtocolB(p.id)}
                  disabled={p.id === protocolA}
                  className={`py-1.5 disabled:opacity-30 disabled:cursor-not-allowed ${TAB(protocolB === p.id)}`}
                >
                  {p.displayName}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {bothPicked && (
        <div className="flex rounded-lg overflow-hidden border border-gray-700 text-xs w-48 mx-auto">
          <button type="button" onClick={() => setViewMode('static')} className={TAB(viewMode === 'static')}>Static</button>
          <button type="button" onClick={() => setViewMode('live')} className={TAB(viewMode === 'live')}>Live</button>
        </div>
      )}

      {profileA && profileB && viewMode === 'static' && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-700 text-gray-400">
                <th className="text-left py-2 pr-3 w-40">Attribute</th>
                <th className="text-left py-2 px-3 text-white">{REGISTRY[protocolA!].displayName}</th>
                <th className="text-left py-2 pl-3 text-white">{REGISTRY[protocolB!].displayName}</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(row => (
                <tr key={row.key} className="border-b border-gray-800/50 align-top">
                  <td className="py-2 pr-3 text-gray-500">{row.label}</td>
                  <td className="py-2 px-3 text-gray-200">{String(profileA[row.key])}</td>
                  <td className="py-2 pl-3 text-gray-200">{String(profileB[row.key])}</td>
                </tr>
              ))}
              <tr className="align-top">
                <td className="py-2 pr-3 text-gray-500">Faults handled</td>
                <td className="py-2 px-3 text-gray-200">{profileA.faultsHandled.join(', ')}</td>
                <td className="py-2 pl-3 text-gray-200">{profileB.faultsHandled.join(', ')}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {bothPicked && viewMode === 'live' && category && (
        <LivePanel protocolA={protocolA!} protocolB={protocolB!} category={category} />
      )}
    </div>
  )
}
