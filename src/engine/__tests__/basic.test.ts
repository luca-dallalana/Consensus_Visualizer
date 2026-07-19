import { describe, it, expect } from 'vitest'
import { advanceBasicStep } from '../basic/step'
import { computeViewSummary } from '../basic/narrate'
import { makeGenesisBlock, makeBlock, makeQC } from '../shared/factory'
import { quorumSize, leaderForView, nextView } from '../shared/protocol'
import type { Block, ReplicaId, ViewNumber, BlockHash } from '../../types'
import type { BasicSimulationStep, BasicViewState, BasicMessage } from '../../types'
import type { SimConfig } from '../../types'

const N = 4
const Q = quorumSize(N)
const v = (n: number) => n as ViewNumber
const r = (n: number) => n as ReplicaId
const QSIDS: ReplicaId[] = [r(0), r(1), r(2)]

const CFG: SimConfig = {
  n: N, f: 1, seed: 0, viewTimeout: 999, maxViews: 20,
  byzantineReplicas: [], dropRate: 0, protocol: 'basic',
}

function mkVS(view: number, phase: BasicViewState['phase'] = 'PREPARE'): BasicViewState {
  return {
    view: v(view), leader: r(view % N), phase,
    proposal: null, highQC: null,
    prepareQC: null, preCommitQC: null, commitQC: null,
    prepareVotes: [], preCommitVotes: [], commitVotes: [],
    triggeredCommitOf: null, viewStartStep: 0,
  }
}

function mkState(
  viewStates: BasicViewState[],
  blockchain: Block[],
  currentView: number,
  pendingMessages: BasicMessage[] = [],
  committedBlocks: BlockHash[] = [],
  byzantineIds: number[] = [],
): BasicSimulationStep {
  return {
    stepIndex: 100, currentView,
    replicaStates: Array.from({ length: N }, (_, i) => ({
      id: r(i), currentView: v(currentView), lockedQC: null, prepareQC: null,
      isByzantine: byzantineIds.includes(i),
    })),
    viewStates, blockchain, committedBlocks,
    pendingMessages, deliveredMessages: [], droppedMessages: [],
  }
}

describe('Basic HotStuff — commit rules', () => {
  it('view advancement without DECIDE leaves committedBlocks empty', () => {
    const genesis   = makeGenesisBlock()
    const genesisQC = makeQC(v(-1), genesis.hash, QSIDS)
    const nl        = leaderForView(nextView(v(0)), N)

    const nvMsgs: BasicMessage[] = [
      { id: 'nv0', type: 'BASIC_NEW_VIEW', from: r(0), to: nl, view: v(0), sentAtStep: 5, highQC: genesisQC },
      { id: 'nv1', type: 'BASIC_NEW_VIEW', from: r(1), to: nl, view: v(0), sentAtStep: 5, highQC: genesisQC },
      { id: 'nv2', type: 'BASIC_NEW_VIEW', from: r(2), to: nl, view: v(0), sentAtStep: 5, highQC: genesisQC },
    ]

    const state = mkState([mkVS(0, 'TIMED_OUT')], [genesis], 0, nvMsgs)

    let s = advanceBasicStep(state, CFG)
    s = advanceBasicStep(s, CFG)
    s = advanceBasicStep(s, CFG)

    expect(s.currentView).toBe(1)
    expect(s.committedBlocks).toHaveLength(0)
  })

  it('DECIDE for a block commits uncommitted ancestors alongside it', () => {
    const genesis = makeGenesisBlock()
    const B0      = makeBlock(genesis, v(0), r(0), 'tx0')
    const B1      = makeBlock(B0,      v(1), r(1), 'tx1')
    const B2      = makeBlock(B1,      v(2), r(2), 'tx2')

    const commitQC    = makeQC(v(2), B2.hash, QSIDS)
    const decideMsg: BasicMessage = {
      id: 'decide-v2', type: 'BASIC_DECIDE',
      from: r(2), to: 'broadcast', view: v(2), sentAtStep: 50,
      commitQC,
    }

    const state = mkState(
      [mkVS(0), mkVS(1), mkVS(2)],
      [genesis, B0, B1, B2],
      2,
      [decideMsg],
      [genesis.hash, B0.hash],
    )

    const result = advanceBasicStep(state, CFG)

    expect(result.committedBlocks).toEqual([genesis.hash, B0.hash, B1.hash, B2.hash])
    expect(result.viewStates[2].triggeredCommitOf).toBe(B2.hash)
  })
})

describe('Basic HotStuff — lockedQC enforcement in PREPARE', () => {
  it('honest replicas reject PREPARE when highQC view is below lockedQC view', () => {
    const genesis = makeGenesisBlock()
    const Bx      = makeBlock(genesis, v(5), r(1), 'bx')
    const B_bad   = makeBlock(genesis, v(7), r(3), 'bad')

    const lockedQC    = makeQC(v(5), Bx.hash,     QSIDS)
    const highQC_low  = makeQC(v(3), genesis.hash, QSIDS)

    const prepareMsg: BasicMessage = {
      id: 'prep-v7', type: 'BASIC_PREPARE',
      from: r(3), to: 'broadcast', view: v(7), sentAtStep: 5,
      block: B_bad, highQC: highQC_low,
    }

    const state: BasicSimulationStep = {
      stepIndex: 5, currentView: 7,
      replicaStates: Array.from({ length: N }, (_, i) => ({
        id: r(i), currentView: v(7), lockedQC, prepareQC: lockedQC, isByzantine: false,
      })),
      viewStates: Array.from({ length: 8 }, (_, i) => mkVS(i)),
      blockchain: [genesis, Bx, B_bad],
      committedBlocks: [],
      pendingMessages: [prepareMsg],
      deliveredMessages: [],
      droppedMessages:   [],
    }

    const result = advanceBasicStep(state, CFG)
    expect(result.pendingMessages.filter(m => m.type === 'BASIC_PREPARE_VOTE')).toHaveLength(0)
  })

  it('honest replicas vote on PREPARE when highQC view exceeds lockedQC view', () => {
    const genesis  = makeGenesisBlock()
    const Bx       = makeBlock(genesis, v(5), r(1), 'bx')
    const B_prop   = makeBlock(genesis, v(7), r(3), 'prop')

    const lockedQC    = makeQC(v(5), Bx.hash,     QSIDS)
    const highQC_high = makeQC(v(7), genesis.hash, QSIDS)

    const prepareMsg: BasicMessage = {
      id: 'prep-v7', type: 'BASIC_PREPARE',
      from: r(3), to: 'broadcast', view: v(7), sentAtStep: 5,
      block: B_prop, highQC: highQC_high,
    }

    const state: BasicSimulationStep = {
      stepIndex: 5, currentView: 7,
      replicaStates: Array.from({ length: N }, (_, i) => ({
        id: r(i), currentView: v(7), lockedQC, prepareQC: lockedQC, isByzantine: false,
      })),
      viewStates: Array.from({ length: 8 }, (_, i) => mkVS(i)),
      blockchain: [genesis, Bx, B_prop],
      committedBlocks: [],
      pendingMessages: [prepareMsg],
      deliveredMessages: [],
      droppedMessages:   [],
    }

    const result = advanceBasicStep(state, CFG)
    expect(result.pendingMessages.filter(m => m.type === 'BASIC_PREPARE_VOTE')).toHaveLength(N)
  })
})

describe('Basic HotStuff — DELAY strategy', () => {
  it('DELAY leader withholds proposal until elapsed reaches viewTimeout/2', () => {
    const genesis   = makeGenesisBlock()
    const genesisQC = makeQC(v(-1), genesis.hash, QSIDS)

    const delayVS: BasicViewState = {
      view: v(0), leader: r(0), phase: 'PREPARE',
      proposal: null, highQC: genesisQC,
      prepareQC: null, preCommitQC: null, commitQC: null,
      prepareVotes: [], preCommitVotes: [], commitVotes: [],
      triggeredCommitOf: null, viewStartStep: 0,
    }
    const cfg: SimConfig = {
      ...CFG, viewTimeout: 10,
      byzantineReplicas: [{ id: r(0), strategy: 'DELAY' as const }],
    }
    const base: BasicSimulationStep = {
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

    const early = advanceBasicStep({ ...base, stepIndex: 2 }, cfg)
    expect(early.blockchain).toHaveLength(1)
    expect(early.pendingMessages).toHaveLength(0)

    const late = advanceBasicStep({ ...base, stepIndex: 5 }, cfg)
    expect(late.blockchain).toHaveLength(2)
    expect(late.pendingMessages.filter(m => m.type === 'BASIC_PREPARE')).toHaveLength(1)
  })
})

describe('Basic HotStuff — Byzantine non-leader behavior', () => {
  it('WRONG_BLOCK non-leader sends no PRE_COMMIT_VOTE', () => {
    const genesis  = makeGenesisBlock()
    const B0       = makeBlock(genesis, v(0), r(0), 'tx0')
    const prepareQC = makeQC(v(1), B0.hash, QSIDS)

    const preCommitMsg: BasicMessage = {
      id: 'pc-v1', type: 'BASIC_PRE_COMMIT',
      from: r(1), to: 'broadcast', view: v(1), sentAtStep: 10,
      prepareQC,
    }
    const cfg: SimConfig = {
      ...CFG, byzantineReplicas: [{ id: r(0), strategy: 'WRONG_BLOCK' as const }],
    }
    const state = mkState(
      [mkVS(0), mkVS(1, 'PRE_COMMIT')],
      [genesis, B0],
      1,
      [preCommitMsg],
      [],
      [0],
    )

    const result = advanceBasicStep(state, cfg)
    expect(result.pendingMessages.filter(m => m.type === 'BASIC_PRE_COMMIT_VOTE')).toHaveLength(3)
    expect(result.pendingMessages.some(m => m.type === 'BASIC_PRE_COMMIT_VOTE' && (m.from as number) === 0)).toBe(false)
  })

  it('WRONG_BLOCK non-leader sends no COMMIT_VOTE', () => {
    const genesis     = makeGenesisBlock()
    const B0          = makeBlock(genesis, v(0), r(0), 'tx0')
    const preCommitQC = makeQC(v(1), B0.hash, QSIDS)

    const commitMsg: BasicMessage = {
      id: 'cv-v1', type: 'BASIC_COMMIT',
      from: r(1), to: 'broadcast', view: v(1), sentAtStep: 10,
      preCommitQC,
    }
    const cfg: SimConfig = {
      ...CFG, byzantineReplicas: [{ id: r(0), strategy: 'WRONG_BLOCK' as const }],
    }
    const state = mkState(
      [mkVS(0), mkVS(1, 'COMMIT_VOTING')],
      [genesis, B0],
      1,
      [commitMsg],
      [],
      [0],
    )

    const result = advanceBasicStep(state, cfg)
    expect(result.pendingMessages.filter(m => m.type === 'BASIC_COMMIT_VOTE')).toHaveLength(3)
    expect(result.pendingMessages.some(m => m.type === 'BASIC_COMMIT_VOTE' && (m.from as number) === 0)).toBe(false)
  })
})

describe('computeViewSummary — cascade commit', () => {
  it('committed field shows the directly-decided block, not the oldest ancestor', () => {
    const genesis = makeGenesisBlock()
    const B0      = makeBlock(genesis, v(0), r(0), 'tx0')
    const B1      = makeBlock(B0,      v(1), r(1), 'tx1')
    const B2      = makeBlock(B1,      v(2), r(2), 'tx2')

    const prevStep = mkState(
      [mkVS(0), mkVS(1), { ...mkVS(2), triggeredCommitOf: B2.hash as BlockHash }],
      [genesis, B0, B1, B2],
      2,
      [],
      [genesis.hash, B0.hash, B1.hash, B2.hash],
    )

    const currentStep: BasicSimulationStep = {
      ...prevStep,
      currentView: 3,
      viewStates:  [...prevStep.viewStates, mkVS(3)],
    }

    const summary = computeViewSummary(prevStep, currentStep, CFG)

    expect(summary.committed).toBe(B2.hash)
  })
})

describe('Basic HotStuff — BASIC_DECIDE drop protection', () => {
  it('BASIC_DECIDE is never dropped even at 100% drop rate', () => {
    const genesis  = makeGenesisBlock()
    const B0       = makeBlock(genesis, v(0), r(0), 'tx0')
    const commitQC = makeQC(v(0), B0.hash, QSIDS)

    const decideMsg: BasicMessage = {
      id: 'decide-drop', type: 'BASIC_DECIDE',
      from: r(0), to: 'broadcast', view: v(0), sentAtStep: 10,
      commitQC,
    }
    const cfg: SimConfig = { ...CFG, dropRate: 1 }

    const state = mkState([mkVS(0, 'DECIDE_COLLECTING')], [genesis, B0], 0, [decideMsg])

    const result = advanceBasicStep(state, cfg)
    expect(result.droppedMessages).toHaveLength(0)
    expect(result.deliveredMessages.some(m => m.type === 'BASIC_DECIDE')).toBe(true)
  })
})
