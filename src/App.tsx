import { useState } from 'react'
import { useAutoAdvance } from './store/useAutoAdvance'
import SimCanvas from './components/SimCanvas'
import Comparer from './components/Comparer'

export default function App() {
  useAutoAdvance()
  const [mode, setMode] = useState<'sim' | 'compare'>('sim')

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white">
      <div className="flex justify-center gap-2 py-2 text-xs font-mono shrink-0">
        <button
          type="button"
          onClick={() => setMode('sim')}
          className={`px-3 py-1 rounded ${mode === 'sim' ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
        >
          Simulator
        </button>
        <button
          type="button"
          onClick={() => setMode('compare')}
          className={`px-3 py-1 rounded ${mode === 'compare' ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
        >
          Comparer
        </button>
      </div>
      {mode === 'sim' ? (
        <SimCanvas />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="min-h-full flex items-center justify-center p-6">
            <Comparer />
          </div>
        </div>
      )}
    </div>
  )
}
