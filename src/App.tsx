import { useAutoAdvance } from './store/useAutoAdvance'
import SimCanvas from './components/SimCanvas'

export default function App() {
  useAutoAdvance()
  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white">
      <SimCanvas />
    </div>
  )
}
