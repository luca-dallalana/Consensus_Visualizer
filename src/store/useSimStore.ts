import { create } from 'zustand'
import type { SimulationState, SimulationStatus, SimConfig, AnySimulationStep, ViewSummary } from '../types'
import { REGISTRY } from '../engine/registry'

interface Actions {
  setConfig: (config: SimConfig) => void
  start:     () => void
  pause:     () => void
  resume:    () => void
  step:      () => void
  seekTo:    (index: number) => void
  reset:     () => void
  setSpeed:  (ms: number) => void
}

interface UiState {
  speed:         number
  narrative:     string
  viewSummaries: readonly ViewSummary[]
}

const DEFAULT_CONFIG: SimConfig = {
  n:                 4,
  f:                 1,
  byzantineReplicas: [],
  viewTimeout:       10,
  maxViews:          10,
  seed:              42,
  protocol:          'chained',
  dropRate:          0,
}

const INITIAL_STATE: SimulationState = {
  config:           DEFAULT_CONFIG,
  status:           'IDLE',
  steps:            [],
  currentStepIndex: 0,
}

export const useSimStore = create<SimulationState & UiState & Actions>((set, get) => ({
  ...INITIAL_STATE,
  speed:         1000,
  narrative:     '',
  viewSummaries: [],

  setConfig: (config) => set({ ...INITIAL_STATE, config }),

  start: () => {
    const { config, status } = get()
    if (status !== 'IDLE') return
    const plugin = REGISTRY[config.protocol]
    const step0  = plugin.init(config)
    set({
      steps:         [step0],
      currentStepIndex: 0,
      status:        'RUNNING',
      narrative:     plugin.narrate(null, step0, config),
      viewSummaries: [],
    })
  },

  pause:  () => set({ status: 'PAUSED' }),
  resume: () => set({ status: 'RUNNING' }),

  step: () => {
    const { steps, currentStepIndex, config, status } = get()
    if (status === 'COMPLETED' || status === 'FAULT') return

    const plugin       = REGISTRY[config.protocol]
    const desiredIndex = currentStepIndex + 1

    if (desiredIndex < steps.length) {
      const { viewSummaries } = get()
      const prev = steps[desiredIndex - 1]
      const next = steps[desiredIndex]
      const newSummaries = next.currentView > prev.currentView
        ? [...viewSummaries, plugin.summarizeView(prev, next, config)]
        : viewSummaries
      set({ currentStepIndex: desiredIndex, narrative: plugin.narrate(prev, next, config), viewSummaries: newSummaries })
      return
    }

    const current = steps[currentStepIndex]
    const next: AnySimulationStep = plugin.advance(current, config)

    if (next.stepIndex === current.stepIndex) {
      set({ status: 'FAULT' })
      return
    }

    const nextStatus: SimulationStatus =
      next.currentView >= config.maxViews ? 'COMPLETED' : status

    const { viewSummaries } = get()
    const newSummaries = next.currentView > current.currentView
      ? [...viewSummaries, plugin.summarizeView(current, next, config)]
      : viewSummaries

    set({
      steps:            [...steps, next],
      currentStepIndex: desiredIndex,
      status:           nextStatus,
      narrative:        plugin.narrate(current, next, config),
      viewSummaries:    newSummaries,
    })
  },

  seekTo: (index) => {
    const { steps, config } = get()
    if (index < 0 || index >= steps.length) return
    const plugin    = REGISTRY[config.protocol]
    const narrative = index > 0
      ? plugin.narrate(steps[index - 1], steps[index], config)
      : plugin.narrate(null, steps[0], config)
    const viewSummaries: ViewSummary[] = []
    for (let i = 1; i <= index; i++) {
      if (steps[i].currentView > steps[i - 1].currentView) {
        viewSummaries.push(plugin.summarizeView(steps[i - 1], steps[i], config))
      }
    }
    set({ currentStepIndex: index, narrative, viewSummaries })
  },

  reset: () => {
    const { config, speed } = get()
    set({ ...INITIAL_STATE, config, speed, narrative: '', viewSummaries: [] })
  },

  setSpeed: (ms) => set({ speed: ms }),
}))
