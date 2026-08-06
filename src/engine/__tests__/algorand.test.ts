import { describe, it, expect } from 'vitest'
import { initAlgorandSimulation, advanceAlgorandStep } from '../algorand/step'
import { makeGenesisBlock, makeBlock } from '../shared/factory'
import type { ReplicaId, ViewNumber, BlockHash, Block, ReplicaState } from '../../types'
import type { AlgorandSimulationStep, AlgorandViewState, AlgProposeMessage } from '../../types'
import type { SimConfig, ByzantineFaultStrategy } from '../../types'

const N = 4
const v = (n: number) => n as ViewNumber
const r = (n: number) => n as ReplicaId

const CFG: SimConfig = {
  n: N, f: 1, seed: 0, viewTimeout: 999, maxViews: 20,
  byzantineReplicas: [], dropRate: 0, protocol: 'algorand',
}

function mkReplicaStates(byzantineId?: number): ReplicaState[] {
  return Array.from({ length: N }, (_, i) => ({
    id: r(i), currentView: v(0), lockedQC: null, prepareQC: null,
    isByzantine: byzantineId !== undefined && i === byzantineId,
  }))
}

function mkVS(opts: Partial<AlgorandViewState> & { proposers: ReplicaId[] }): AlgorandViewState {
  return {
    view: v(0), leader: opts.proposers[0] ?? (-1 as ReplicaId), phase: 'PROPOSE',
    proposal: null, proposalPriority: null, softVotes: [], certVotes: [], triggeredCommitOf: null, viewStartStep: 0,
    ...opts,
  }
}

describe('Algorand — normal commit path', () => {
  it('a block eventually commits despite natural sortition variability (0/1/many proposers per round)', () => {
    let s = initAlgorandSimulation(CFG)
    for (let i = 0; i < 500; i++) {
      s = advanceAlgorandStep(s, CFG)
      if (s.committedBlocks.length > 0) break
    }
    expect(s.committedBlocks.length).toBeGreaterThan(0)
  })
})

describe('Algorand — empty sortition round', () => {
  it('a round with zero sortition-selected proposers times out immediately with no messages', () => {
    const genesis = makeGenesisBlock()
    const state: AlgorandSimulationStep = {
      stepIndex: 0, currentView: 0,
      replicaStates: mkReplicaStates(),
      viewStates: [mkVS({ proposers: [] })],
      blockchain: [genesis], committedBlocks: [],
      pendingMessages: [], deliveredMessages: [], droppedMessages: [],
    }

    const result = advanceAlgorandStep(state, CFG)
    expect(result.viewStates[0].phase).toBe('ROUND_TIMED_OUT')
    expect(result.pendingMessages).toHaveLength(0)
  })
})

describe('Algorand — priority tiebreak with multiple proposers', () => {
  const genesis   = makeGenesisBlock()
  const blockLow  = makeBlock(genesis, v(0), r(0), 'low-priority-wins')
  const blockHigh = makeBlock(genesis, v(0), r(2), 'high-priority-loses')

  const msgLow: AlgProposeMessage = {
    id: 'p-low', type: 'ALG_PROPOSE', from: r(0), to: 'broadcast', view: v(0), sentAtStep: 1,
    block: blockLow, priority: 0.2,
  }
  const msgHigh: AlgProposeMessage = {
    id: 'p-high', type: 'ALG_PROPOSE', from: r(2), to: 'broadcast', view: v(0), sentAtStep: 1,
    block: blockHigh, priority: 0.8,
  }

  function baseState(pending: AlgProposeMessage[], blocks: Block[]): AlgorandSimulationStep {
    return {
      stepIndex: 0, currentView: 0,
      replicaStates: mkReplicaStates(),
      viewStates: [mkVS({ proposers: [r(0), r(2)] })],
      blockchain: blocks, committedBlocks: [],
      pendingMessages: pending, deliveredMessages: [], droppedMessages: [],
    }
  }

  it('keeps the lower-priority block regardless of delivery order (low delivered first)', () => {
    let s = baseState([msgLow, msgHigh], [genesis, blockLow, blockHigh])
    s = advanceAlgorandStep(s, CFG)
    s = advanceAlgorandStep(s, CFG)
    expect(s.viewStates[0].proposal?.hash).toBe(blockLow.hash)
  })

  it('keeps the lower-priority block regardless of delivery order (high delivered first)', () => {
    let s = baseState([msgHigh, msgLow], [genesis, blockLow, blockHigh])
    s = advanceAlgorandStep(s, CFG)
    s = advanceAlgorandStep(s, CFG)
    expect(s.viewStates[0].proposal?.hash).toBe(blockLow.hash)
  })

  it('a WRONG_BLOCK proposal never wins the ratchet even with the best priority', () => {
    const brokenBlock: Block = {
      hash: 'broken-test' as BlockHash, parentHash: 'nonexistent-parent' as BlockHash,
      height: 1, view: v(0), proposer: r(0), payload: 'byzantine-wrong',
    }
    const msgBroken: AlgProposeMessage = {
      id: 'p-broken', type: 'ALG_PROPOSE', from: r(0), to: 'broadcast', view: v(0), sentAtStep: 1,
      block: brokenBlock, priority: 0.01,
    }
    let s = baseState([msgBroken, msgHigh], [genesis, brokenBlock, blockHigh])
    s = advanceAlgorandStep(s, CFG)
    s = advanceAlgorandStep(s, CFG)
    expect(s.viewStates[0].proposal?.hash).toBe(blockHigh.hash)
  })
})

describe('Algorand — Byzantine proposer strategies', () => {
  function soleProposerState(strategy: ByzantineFaultStrategy, viewTimeout = 5) {
    const genesis = makeGenesisBlock()
    const cfg: SimConfig = { ...CFG, viewTimeout, byzantineReplicas: [{ id: r(0), strategy }] }
    const state: AlgorandSimulationStep = {
      stepIndex: 0, currentView: 0,
      replicaStates: mkReplicaStates(0),
      viewStates: [mkVS({ proposers: [r(0)], leader: r(0) })],
      blockchain: [genesis], committedBlocks: [],
      pendingMessages: [], deliveredMessages: [], droppedMessages: [],
    }
    return { cfg, state }
  }

  it('SILENT sole proposer causes the round to time out with no commit', () => {
    const { cfg, state } = soleProposerState('SILENT')
    let s = state
    for (let i = 0; i < 20; i++) {
      s = advanceAlgorandStep(s, cfg)
      if (s.viewStates[0].phase === 'ROUND_TIMED_OUT') break
    }
    expect(s.viewStates[0].phase).toBe('ROUND_TIMED_OUT')
    expect(s.committedBlocks).toHaveLength(0)
  })

  it('WRONG_BLOCK sole proposer is rejected — round times out, no soft-vote ever forms', () => {
    const { cfg, state } = soleProposerState('WRONG_BLOCK')
    let s = state
    for (let i = 0; i < 20; i++) {
      s = advanceAlgorandStep(s, cfg)
      if (s.viewStates[0].phase === 'ROUND_TIMED_OUT') break
    }
    expect(s.committedBlocks).toHaveLength(0)
    expect(s.deliveredMessages.filter(m => m.type === 'ALG_SOFT_VOTE')).toHaveLength(0)
  })

  it('DELAY sole proposer enqueues its proposal immediately with a future sentAtStep', () => {
    const { cfg, state } = soleProposerState('DELAY', 10)
    const result = advanceAlgorandStep(state, cfg)
    expect(result.blockchain).toHaveLength(2)
    const proposeMsgs = result.pendingMessages.filter(m => m.type === 'ALG_PROPOSE')
    expect(proposeMsgs).toHaveLength(1)
    expect(proposeMsgs[0].sentAtStep).toBe(1 + 5)
    expect(result.viewStates[0].phase).toBe('PROPOSE')
  })
})

describe('Algorand — Byzantine non-leader replica', () => {
  it('a SILENT byzantine replica that is not sortition-selected does not block commit', () => {
    const genesis = makeGenesisBlock()
    const cfg: SimConfig = { ...CFG, byzantineReplicas: [{ id: r(0), strategy: 'SILENT' }] }
    let s: AlgorandSimulationStep = {
      stepIndex: 0, currentView: 0,
      replicaStates: mkReplicaStates(0),
      viewStates: [mkVS({ proposers: [r(1)], leader: r(1) })],
      blockchain: [genesis], committedBlocks: [],
      pendingMessages: [], deliveredMessages: [], droppedMessages: [],
    }
    for (let i = 0; i < 60; i++) {
      s = advanceAlgorandStep(s, cfg)
      if (s.committedBlocks.length > 0) break
    }
    expect(s.committedBlocks.length).toBeGreaterThan(0)
  })
})

describe('Algorand — propose window closes on drop, not just delivery', () => {
  it('a round with 2 proposers whose proposals both get dropped still reaches ROUND_TIMED_OUT', () => {
    const genesis = makeGenesisBlock()
    const cfg: SimConfig = { ...CFG, viewTimeout: 5, dropRate: 1 }
    let s: AlgorandSimulationStep = {
      stepIndex: 0, currentView: 0,
      replicaStates: mkReplicaStates(),
      viewStates: [mkVS({ proposers: [r(0), r(2)] })],
      blockchain: [genesis], committedBlocks: [],
      pendingMessages: [], deliveredMessages: [], droppedMessages: [],
    }
    for (let i = 0; i < 10; i++) {
      s = advanceAlgorandStep(s, cfg)
      if (s.viewStates[0].phase === 'ROUND_TIMED_OUT') break
    }
    expect(s.viewStates[0].phase).toBe('ROUND_TIMED_OUT')
    expect(s.committedBlocks).toHaveLength(0)
    expect(s.droppedMessages.filter(m => m.type === 'ALG_PROPOSE')).toHaveLength(2)
  })
})
