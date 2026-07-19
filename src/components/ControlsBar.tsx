import { useSimStore } from '../store/useSimStore'

const SPEEDS = [
  { label: '0.25×', ms: 4000 },
  { label: '0.5×',  ms: 2000 },
  { label: '1×',    ms: 1000 },
  { label: '2×',    ms: 500  },
  { label: '4×',    ms: 200  },
]

const BTN = 'px-3 py-1 rounded font-mono text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed'
const BTN_DEFAULT = `${BTN} bg-gray-700 hover:bg-gray-600`
const BTN_PRIMARY = `${BTN} bg-blue-700 hover:bg-blue-600`

export default function ControlsBar() {
  const status           = useSimStore(s => s.status)
  const steps            = useSimStore(s => s.steps)
  const currentStepIndex = useSimStore(s => s.currentStepIndex)
  const speed            = useSimStore(s => s.speed)
  const pause            = useSimStore(s => s.pause)
  const resume           = useSimStore(s => s.resume)
  const step             = useSimStore(s => s.step)
  const seekTo           = useSimStore(s => s.seekTo)
  const reset            = useSimStore(s => s.reset)
  const setSpeed         = useSimStore(s => s.setSpeed)

  const isRunning  = status === 'RUNNING'
  const isTerminal = status === 'COMPLETED' || status === 'FAULT'
  const maxIndex   = Math.max(0, steps.length - 1)

  const canStepBack    = currentStepIndex > 0
  const canStepForward = !isTerminal || currentStepIndex < maxIndex

  return (
    <div className="flex items-center gap-3 px-4 h-12 bg-gray-900 border-b border-gray-800 shrink-0 font-mono">
      <button onClick={reset} className={BTN_DEFAULT}>
        Reset
      </button>

      <div className="w-px h-6 bg-gray-700" />

      <button
        onClick={() => seekTo(currentStepIndex - 1)}
        disabled={!canStepBack}
        className={BTN_DEFAULT}
      >
        &#8592;
      </button>

      {isRunning
        ? <button onClick={pause}  className={BTN_PRIMARY}>Pause</button>
        : <button onClick={resume} disabled={isTerminal} className={BTN_PRIMARY}>Resume</button>
      }

      <button
        onClick={step}
        disabled={!canStepForward}
        className={BTN_DEFAULT}
      >
        &#8594;
      </button>

      <div className="w-px h-6 bg-gray-700" />

      <input
        type="range"
        min={0}
        max={maxIndex}
        value={currentStepIndex}
        onChange={e => seekTo(Number(e.target.value))}
        className="flex-1 accent-blue-500"
      />

      <span className="text-xs text-gray-400 w-20 text-right tabular-nums">
        {currentStepIndex} / {maxIndex}
      </span>

      <div className="w-px h-6 bg-gray-700" />

      <select
        value={speed}
        onChange={e => setSpeed(Number(e.target.value))}
        className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-sm text-white"
      >
        {SPEEDS.map(o => (
          <option key={o.ms} value={o.ms}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}
