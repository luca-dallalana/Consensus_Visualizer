import { useState } from 'react'
import { REGISTRY } from '../engine/registry'
import { PROTOCOL_PROFILES, type ProtocolProfile } from '../data/protocolProfiles'

type Category = 'BFT' | 'CFT'

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
  `flex-1 py-1.5 text-center transition-colors ${active ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`

export default function Comparer() {
  const [category,   setCategory]   = useState<Category | null>(null)
  const [protocolA,  setProtocolA]  = useState<string | null>(null)
  const [protocolB,  setProtocolB]  = useState<string | null>(null)

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

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full mx-auto font-mono flex flex-col gap-5 max-w-4xl">
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

      {profileA && profileB && (
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
    </div>
  )
}
