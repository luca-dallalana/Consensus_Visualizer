import { useEffect } from 'react'
import { useSimStore } from './useSimStore'

export function useAutoAdvance(): void {
  const status = useSimStore(s => s.status)
  const step   = useSimStore(s => s.step)
  const speed  = useSimStore(s => s.speed)

  useEffect(() => {
    if (status !== 'RUNNING') return
    const id = setInterval(step, speed)
    return () => clearInterval(id)
  }, [status, step, speed])
}
