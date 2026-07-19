import { describe, it, expect } from 'vitest'
import { initPbftSimulation, advancePbftStep } from '../pbft/step'
import { makeGenesisBlock, makeBlock, makeQC } from '../shared/factory'
import { quorumSize } from '../shared/protocol'
import type { ReplicaId, ViewNumber, BlockHash } from '../../types'
import type { PbftSimulationStep, PbftViewState, PbftMessage } from '../../types'
import type { SimConfig } from '../../types'

const N = 4
const Q = quorumSize(N)
const v = (n: number) => n as ViewNumber
const r = (n: number) => n as ReplicaId
const QSIDS: ReplicaId[] = [r(0), r(1), r(2)]

const CFG: SimConfig = {
  n: N, f: 1, seed: 0, viewTimeout: 999, maxViews: 20,
  byzantineReplicas: [], dropRate: 0, protocol: 'pbft',
}

function mkVS(view: number, phase: PbftViewState['phase'] = 'PRE_PREPARE'): PbftViewState {
  return {
    view: v(view), leader: r(view % N), phase,
    proposal: null, prepareVotes: [], commitVotes: [],
    triggeredCommitOf: null, viewStartStep: 0,
  }
}

describe('PBFT — normal commit path', () => {
  it('block commits after 2f+1 PRE_PREPARE -> PREPARE -> COMMIT rounds', () => {
    let s = initPbftSimulation(CFG)

    for (let i = 0; i < 60; i++) {
      s = advancePbftStep(s, CFG)
      if (s.committedBlocks.length > 0) break
    }

    expect(s.committedBlocks).toHaveLength(1)
    expect(s.viewStates[0].phase).toBe('COMMITTED')
    expect(s.viewStates[0].triggeredCommitOf).toBe(s.committedBlocks[0])
  })
})

describe('PBFT — SILENT primary triggers VIEW_CHANGE', () => {
  it('silent primary causes timeout and VIEW_CHANGE messages to next primary', () => {
    const cfg: SimConfig = {
      ...CFG,
      viewTimeout: 5,
      byzantineReplicas: [{ id: r(0), strategy: 'SILENT' as const }],
    }

    let s = initPbftSimulation(cfg)

    for (let i = 0; i < 20; i++) {
      s = advancePbftStep(s, cfg)
      if (s.viewStates[0]?.phase === 'TIMED_OUT') break
    }

    expect(s.viewStates[0].phase).toBe('TIMED_OUT')
    expect(s.pendingMessages.every(m => m.type === 'PBFT_VIEW_CHANGE')).toBe(true)
    const nextLeader = 1
    expect(s.pendingMessages.some(m => (m.to as number) === nextLeader)).toBe(true)
  })
})

describe('PBFT — EQUIVOCATE primary prevents commit', () => {
  it('equivocating primary splits replicas so neither block reaches quorum', () => {
    const cfg: SimConfig = {
      ...CFG,
      viewTimeout: 5,
      byzantineReplicas: [{ id: r(0), strategy: 'EQUIVOCATE' as const }],
    }

    let s = initPbftSimulation(cfg)

    for (let i = 0; i < 30; i++) {
      s = advancePbftStep(s, cfg)
      if (s.currentView > 0 || s.viewStates[0]?.phase === 'TIMED_OUT') break
    }

    expect(s.committedBlocks).toHaveLength(0)
  })
})

describe('PBFT — SILENT non-leader', () => {
  it('f=1 SILENT non-leader still allows quorum with 3 honest replicas', () => {
    const cfg: SimConfig = {
      ...CFG,
      byzantineReplicas: [{ id: r(1), strategy: 'SILENT' as const }],
    }

    let s = initPbftSimulation(cfg)

    for (let i = 0; i < 60; i++) {
      s = advancePbftStep(s, cfg)
      if (s.committedBlocks.length > 0) break
    }

    expect(s.committedBlocks).toHaveLength(1)
  })
})

describe('PBFT — WRONG_BLOCK primary', () => {
  it('wrong block parentHash causes replicas to reject and not send PREPARE', () => {
    const cfg: SimConfig = {
      ...CFG,
      viewTimeout: 5,
      byzantineReplicas: [{ id: r(0), strategy: 'WRONG_BLOCK' as const }],
    }

    let s = initPbftSimulation(cfg)

    for (let i = 0; i < 30; i++) {
      s = advancePbftStep(s, cfg)
      if (s.viewStates[0]?.phase === 'TIMED_OUT') break
    }

    expect(s.committedBlocks).toHaveLength(0)
    const prepares = s.deliveredMessages.filter(m => m.type === 'PBFT_PREPARE')
    expect(prepares).toHaveLength(0)
  })
})

describe('PBFT — VIEW_CHANGE never dropped', () => {
  it('VIEW_CHANGE messages survive 100% drop rate', () => {
    const cfg: SimConfig = {
      ...CFG,
      viewTimeout: 3,
      dropRate: 1,
      byzantineReplicas: [{ id: r(0), strategy: 'SILENT' as const }],
    }

    let s = initPbftSimulation(cfg)

    for (let i = 0; i < 25; i++) {
      s = advancePbftStep(s, cfg)
      if (s.viewStates[0]?.phase === 'TIMED_OUT') break
    }

    expect(s.viewStates[0].phase).toBe('TIMED_OUT')
    const vcPending = s.pendingMessages.filter(m => m.type === 'PBFT_VIEW_CHANGE')
    expect(vcPending.length).toBeGreaterThan(0)
    expect(s.droppedMessages.some(m => m.type === 'PBFT_VIEW_CHANGE')).toBe(false)
  })
})
