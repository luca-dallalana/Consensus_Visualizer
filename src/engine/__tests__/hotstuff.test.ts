import { describe, it, expect } from 'vitest'
import { advanceStep } from '../hotstuff/step'
import { makeGenesisBlock, makeBlock, makeQC, makeProposalMessage, makeNewViewMessage } from '../shared/factory'
import { quorumSize, leaderForView, nextView } from '../shared/protocol'
import type { Block, ReplicaId, ViewNumber } from '../../types'
import type { SimulationStep, ViewState, SimConfig } from '../../types'

const N = 4
const Q = quorumSize(N)
const v = (n: number) => n as ViewNumber
const r = (n: number) => n as ReplicaId
const QSIDS: ReplicaId[] = [r(0), r(1), r(2)]

const CFG: SimConfig = {
  n: N, f: 1, seed: 0, viewTimeout: 999, maxViews: 20,
  byzantineReplicas: [], dropRate: 0, protocol: 'chained',
}

function mkVS(view: number, qc: ReturnType<typeof makeQC> | null, phase: ViewState['phase'] = 'QC_FORMED'): ViewState {
  return {
    view: v(view), leader: r(view % N), phase,
    proposal: null, highQC: null, votes: [],
    qc, triggeredCommitOf: null, viewStartStep: 0,
  }
}

function mkState(viewStates: ViewState[], blockchain: Block[], currentView: number, byzantineIds: number[] = []): SimulationStep {
  return {
    stepIndex: 100, currentView,
    replicaStates: Array.from({ length: N }, (_, i) => ({
      id: r(i), currentView: v(currentView), lockedQC: null, prepareQC: null,
      isByzantine: byzantineIds.includes(i),
    })),
    viewStates, blockchain, committedBlocks: [],
    pendingMessages: [], deliveredMessages: [], droppedMessages: [],
  }
}

describe('Chained HotStuff — 3-chain commit rule', () => {
  it('timed-out view breaks the chain — no block commits', () => {
    const genesis = makeGenesisBlock()
    const B0 = makeBlock(genesis, v(0), r(0), 'tx0')
    const B1 = makeBlock(B0,     v(1), r(1), 'tx1')
    const B3 = makeBlock(B1,     v(3), r(3), 'tx3')

    const viewStates = [
      mkVS(0, makeQC(v(0), B0.hash, QSIDS)),
      mkVS(1, makeQC(v(1), B1.hash, QSIDS)),
      mkVS(2, null, 'TIMED_OUT'),
      mkVS(3, makeQC(v(3), B3.hash, QSIDS)),
    ]
    const result = advanceStep(mkState(viewStates, [genesis, B0, B1, B3], 3), CFG)

    expect(result.committedBlocks).toHaveLength(0)
  })

  it('consecutive 3-chain commits the first block and genesis ancestor', () => {
    const genesis = makeGenesisBlock()
    const B0 = makeBlock(genesis, v(0), r(0), 'tx0')
    const B1 = makeBlock(B0,     v(1), r(1), 'tx1')
    const B2 = makeBlock(B1,     v(2), r(2), 'tx2')

    const viewStates = [
      mkVS(0, makeQC(v(0), B0.hash, QSIDS)),
      mkVS(1, makeQC(v(1), B1.hash, QSIDS)),
      mkVS(2, makeQC(v(2), B2.hash, QSIDS)),
    ]
    const result = advanceStep(mkState(viewStates, [genesis, B0, B1, B2], 2), CFG)

    expect(result.committedBlocks).toEqual([genesis.hash, B0.hash])
  })

  it('all uncommitted ancestors cascade when a later 3-chain fires', () => {
    const genesis = makeGenesisBlock()
    const B0 = makeBlock(genesis, v(0), r(0), 'tx0')
    const B1 = makeBlock(B0,     v(1), r(1), 'tx1')
    const B2 = makeBlock(B1,     v(2), r(2), 'tx2')
    const B3 = makeBlock(B2,     v(3), r(3), 'tx3')
    const B4 = makeBlock(B3,     v(4), r(0), 'tx4')

    const viewStates = [
      mkVS(0, null, 'TIMED_OUT'),
      mkVS(1, null, 'TIMED_OUT'),
      mkVS(2, makeQC(v(2), B2.hash, QSIDS)),
      mkVS(3, makeQC(v(3), B3.hash, QSIDS)),
      mkVS(4, makeQC(v(4), B4.hash, QSIDS)),
    ]
    const result = advanceStep(mkState(viewStates, [genesis, B0, B1, B2, B3, B4], 4), CFG)

    expect(result.committedBlocks).toEqual([genesis.hash, B0.hash, B1.hash, B2.hash])
    expect(result.committedBlocks).not.toContain(B3.hash)
    expect(result.committedBlocks).not.toContain(B4.hash)
  })

  it('non-matching parent in the 3-chain prevents commit', () => {
    const genesis  = makeGenesisBlock()
    const B0       = makeBlock(genesis, v(0), r(0), 'tx0')
    const B1       = makeBlock(B0,      v(1), r(1), 'tx1')
    const B2_fork  = makeBlock(genesis, v(2), r(2), 'fork')

    const viewStates = [
      mkVS(0, makeQC(v(0), B0.hash,      QSIDS)),
      mkVS(1, makeQC(v(1), B1.hash,      QSIDS)),
      mkVS(2, makeQC(v(2), B2_fork.hash, QSIDS)),
    ]
    const result = advanceStep(mkState(viewStates, [genesis, B0, B1, B2_fork], 2), CFG)

    expect(result.committedBlocks).toHaveLength(0)
  })
})

describe('Chained HotStuff — highQC selection on view change', () => {
  it('new leader adopts the highest-view QC from incoming NEW_VIEW messages', () => {
    const genesis = makeGenesisBlock()
    const B0 = makeBlock(genesis, v(0), r(0), 'tx0')
    const B1 = makeBlock(B0,     v(1), r(1), 'tx1')

    const qc0 = makeQC(v(0), B0.hash, QSIDS)
    const qc1 = makeQC(v(1), B1.hash, QSIDS)
    const nl  = leaderForView(nextView(v(1)), N)

    const state: SimulationStep = {
      stepIndex: 10, currentView: 1,
      replicaStates: Array.from({ length: N }, (_, i) => ({
        id: r(i), currentView: v(1), lockedQC: null, prepareQC: qc0, isByzantine: false,
      })),
      viewStates: [mkVS(0, qc0), mkVS(1, null, 'TIMED_OUT')],
      blockchain: [genesis, B0, B1],
      committedBlocks: [],
      pendingMessages: [
        makeNewViewMessage(r(0), nl, v(1), qc1, 5),
        makeNewViewMessage(r(1), nl, v(1), qc0, 5),
        makeNewViewMessage(r(2), nl, v(1), qc1, 5),
      ],
      deliveredMessages: [],
      droppedMessages:   [],
    }

    let s = advanceStep(state, CFG)
    s = advanceStep(s, CFG)
    s = advanceStep(s, CFG)

    expect(s.currentView).toBe(2)
    expect(s.viewStates[2].highQC!.view as number).toBe(1)
  })
})

describe('Chained HotStuff — safeBlock enforcement', () => {
  it('honest replicas refuse to vote when highQC view is below lockedQC view', () => {
    const genesis = makeGenesisBlock()
    const Bx    = makeBlock(genesis, v(5), r(1), 'bx')
    const B_bad = makeBlock(genesis, v(7), r(3), 'bad')

    const lockedQC   = makeQC(v(5), Bx.hash,     QSIDS)
    const highQC_low = makeQC(v(3), genesis.hash, QSIDS)

    const state: SimulationStep = {
      stepIndex: 5, currentView: 7,
      replicaStates: Array.from({ length: N }, (_, i) => ({
        id: r(i), currentView: v(7), lockedQC, prepareQC: lockedQC, isByzantine: false,
      })),
      viewStates: Array.from({ length: 8 }, (_, i) => mkVS(i, null)),
      blockchain: [genesis, Bx, B_bad],
      committedBlocks: [],
      pendingMessages: [makeProposalMessage(r(3), v(7), B_bad, highQC_low, 5, 'broadcast')],
      deliveredMessages: [],
      droppedMessages:   [],
    }

    const result = advanceStep(state, CFG)
    expect(result.pendingMessages.filter(m => m.type === 'VOTE')).toHaveLength(0)
  })

  it('honest replicas vote when highQC view exceeds lockedQC view', () => {
    const genesis  = makeGenesisBlock()
    const Bx       = makeBlock(genesis, v(5), r(1), 'bx')
    const B_prop   = makeBlock(genesis, v(7), r(3), 'prop')

    const lockedQC     = makeQC(v(5), Bx.hash,     QSIDS)
    const highQC_high  = makeQC(v(7), genesis.hash, QSIDS)

    const state: SimulationStep = {
      stepIndex: 5, currentView: 7,
      replicaStates: Array.from({ length: N }, (_, i) => ({
        id: r(i), currentView: v(7), lockedQC, prepareQC: lockedQC, isByzantine: false,
      })),
      viewStates: Array.from({ length: 8 }, (_, i) => mkVS(i, null)),
      blockchain: [genesis, Bx, B_prop],
      committedBlocks: [],
      pendingMessages: [makeProposalMessage(r(3), v(7), B_prop, highQC_high, 5, 'broadcast')],
      deliveredMessages: [],
      droppedMessages:   [],
    }

    const result = advanceStep(state, CFG)
    expect(result.pendingMessages.filter(m => m.type === 'VOTE')).toHaveLength(N)
  })
})

describe('Chained HotStuff — DELAY strategy', () => {
  it('DELAY leader withholds proposal until elapsed reaches viewTimeout/2', () => {
    const genesis   = makeGenesisBlock()
    const genesisQC = makeQC(v(-1), genesis.hash, QSIDS)

    const delayVS: ViewState = {
      view: v(0), leader: r(0), phase: 'PROPOSING',
      proposal: null, highQC: genesisQC, votes: [],
      qc: null, triggeredCommitOf: null, viewStartStep: 0,
    }
    const cfg: SimConfig = {
      ...CFG, viewTimeout: 10,
      byzantineReplicas: [{ id: r(0), strategy: 'DELAY' as const }],
    }
    const base: SimulationStep = {
      stepIndex: 0, currentView: 0,
      replicaStates: Array.from({ length: N }, (_, i) => ({
        id: r(i), currentView: v(0), lockedQC: null, prepareQC: genesisQC,
        isByzantine: i === 0,
      })),
      viewStates: [delayVS],
      blockchain: [genesis],
      committedBlocks: [],
      pendingMessages: [], deliveredMessages: [], droppedMessages: [],
    }

    const early = advanceStep({ ...base, stepIndex: 2 }, cfg)
    expect(early.blockchain).toHaveLength(1)
    expect(early.pendingMessages).toHaveLength(0)

    const late = advanceStep({ ...base, stepIndex: 5 }, cfg)
    expect(late.blockchain).toHaveLength(2)
    expect(late.pendingMessages.filter(m => m.type === 'PROPOSAL')).toHaveLength(1)
  })
})
