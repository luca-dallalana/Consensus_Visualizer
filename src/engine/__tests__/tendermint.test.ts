import { describe, it, expect } from 'vitest'
import { initTendermintSimulation, advanceTendermintStep } from '../tendermint/step'
import { makeGenesisBlock, makeBlock } from '../shared/factory'
import { NIL_VALUE } from '../../types'
import type { ReplicaId, ViewNumber, BlockHash } from '../../types'
import type {
  TendermintSimulationStep, TendermintViewState, TendermintReplicaState,
  TmProposeMessage, TmPrevoteMessage,
} from '../../types'
import type { SimConfig } from '../../types'

const N = 4
const v = (n: number) => n as ViewNumber
const r = (n: number) => n as ReplicaId

const CFG: SimConfig = {
  n: N, f: 1, seed: 0, viewTimeout: 999, maxViews: 20,
  byzantineReplicas: [], dropRate: 0, protocol: 'tendermint',
}

function mkReplica(id: number, opts: Partial<TendermintReplicaState> = {}): TendermintReplicaState {
  return {
    id: r(id), currentView: v(1), isByzantine: false,
    lockedValue: null, lockedRound: null, validValue: null, validRound: null,
    ...opts,
  }
}

function mkVS(view: number, round: number, opts: Partial<TendermintViewState> = {}): TendermintViewState {
  return {
    view: v(view), height: 0, round, leader: r(view % N), phase: 'PREVOTE_VOTING',
    proposal: null, proposalValidRound: null, prevotes: [], precommits: [],
    triggeredCommitOf: null, viewStartStep: 0,
    ...opts,
  }
}

describe('Tendermint — normal commit path', () => {
  it('block commits after a Polka forms a PRECOMMIT quorum, then locks reset on height advance', () => {
    let s = initTendermintSimulation(CFG)

    for (let i = 0; i < 60; i++) {
      s = advanceTendermintStep(s, CFG)
      if (s.committedBlocks.length > 0) break
    }

    // genesis is included as a cascade-committed ancestor, same convention as
    // hotstuff.test.ts's 3-chain commit (this engine uses collectUncommittedAncestors too)
    expect(s.committedBlocks).toHaveLength(2)
    const committedView = s.viewStates.find(vs => vs.phase === 'COMMITTED')
    expect(committedView?.triggeredCommitOf).toBe(s.committedBlocks[s.committedBlocks.length - 1])

    s = advanceTendermintStep(s, CFG)
    const nextVS = s.viewStates[s.currentView]
    expect(nextVS.height).toBe(1)
    expect(nextVS.round).toBe(0)
    for (const rs of s.replicaStates) {
      expect(rs.lockedValue).toBeNull()
      expect(rs.lockedRound).toBeNull()
      expect(rs.validValue).toBeNull()
      expect(rs.validRound).toBeNull()
    }
  })
})

describe('Tendermint — locked-value safety across rounds', () => {
  const genesis = makeGenesisBlock()
  const blockA  = makeBlock(genesis, v(0), r(0), 'txA')

  function replicasWithLock(lockedRound: number | null, lockedValue: BlockHash | null): TendermintReplicaState[] {
    return Array.from({ length: N }, (_, i) => mkReplica(i, i === 1 ? { lockedValue, lockedRound } : {}))
  }

  it('prevotes NIL when a later-round proposal offers a different block with no Polka justification', () => {
    const blockB = makeBlock(genesis, v(1), r(2), 'txB')
    const proposeMsg: TmProposeMessage = {
      id: 'tm-test-1', type: 'TM_PROPOSE', from: r(2), to: 'broadcast',
      view: v(1), sentAtStep: 5, block: blockB, height: 0, round: 1, validRound: null,
    }
    const state: TendermintSimulationStep = {
      stepIndex: 5, currentView: 1,
      replicaStates: replicasWithLock(0, blockA.hash),
      viewStates: [mkVS(0, 0, { phase: 'ROUND_TIMED_OUT' }), mkVS(1, 1, { leader: r(2) })],
      blockchain: [genesis, blockA, blockB], committedBlocks: [],
      pendingMessages: [proposeMsg], deliveredMessages: [], droppedMessages: [],
    }

    const result  = advanceTendermintStep(state, CFG)
    const prevote = result.pendingMessages.find(
      m => m.type === 'TM_PREVOTE' && (m.from as number) === 1,
    ) as TmPrevoteMessage
    expect(prevote.vote.blockHash).toBe(NIL_VALUE)
  })

  it('prevotes for its own locked block when a later round re-proposes that exact block', () => {
    const proposeMsg: TmProposeMessage = {
      id: 'tm-test-2', type: 'TM_PROPOSE', from: r(2), to: 'broadcast',
      view: v(1), sentAtStep: 5, block: blockA, height: 0, round: 1, validRound: null,
    }
    const state: TendermintSimulationStep = {
      stepIndex: 5, currentView: 1,
      replicaStates: replicasWithLock(0, blockA.hash),
      viewStates: [mkVS(0, 0, { phase: 'ROUND_TIMED_OUT' }), mkVS(1, 1, { leader: r(2) })],
      blockchain: [genesis, blockA], committedBlocks: [],
      pendingMessages: [proposeMsg], deliveredMessages: [], droppedMessages: [],
    }

    const result  = advanceTendermintStep(state, CFG)
    const prevote = result.pendingMessages.find(
      m => m.type === 'TM_PREVOTE' && (m.from as number) === 1,
    ) as TmPrevoteMessage
    expect(prevote.vote.blockHash).toBe(blockA.hash)
  })

  it('prevotes for a different block when the proposal carries a validRound proving a newer Polka', () => {
    const blockC = makeBlock(genesis, v(2), r(3), 'txC')
    const proposeMsg: TmProposeMessage = {
      id: 'tm-test-3', type: 'TM_PROPOSE', from: r(3), to: 'broadcast',
      view: v(2), sentAtStep: 8, block: blockC, height: 0, round: 2, validRound: 1,
    }
    const state: TendermintSimulationStep = {
      stepIndex: 8, currentView: 2,
      replicaStates: replicasWithLock(0, blockA.hash),
      viewStates: [
        mkVS(0, 0, { phase: 'ROUND_TIMED_OUT' }),
        mkVS(1, 1, { phase: 'ROUND_TIMED_OUT' }),
        mkVS(2, 2, { leader: r(3) }),
      ],
      blockchain: [genesis, blockA, blockC], committedBlocks: [],
      pendingMessages: [proposeMsg], deliveredMessages: [], droppedMessages: [],
    }

    const result  = advanceTendermintStep(state, CFG)
    const prevote = result.pendingMessages.find(
      m => m.type === 'TM_PREVOTE' && (m.from as number) === 1,
    ) as TmPrevoteMessage
    expect(prevote.vote.blockHash).toBe(blockC.hash)
  })

  it('unlocked replica always prevotes for a valid proposal', () => {
    const blockB = makeBlock(genesis, v(0), r(0), 'txB')
    const proposeMsg: TmProposeMessage = {
      id: 'tm-test-4', type: 'TM_PROPOSE', from: r(0), to: 'broadcast',
      view: v(0), sentAtStep: 1, block: blockB, height: 0, round: 0, validRound: null,
    }
    const state: TendermintSimulationStep = {
      stepIndex: 1, currentView: 0,
      replicaStates: replicasWithLock(null, null),
      viewStates: [mkVS(0, 0, { leader: r(0) })],
      blockchain: [genesis, blockB], committedBlocks: [],
      pendingMessages: [proposeMsg], deliveredMessages: [], droppedMessages: [],
    }

    const result  = advanceTendermintStep(state, CFG)
    const prevote = result.pendingMessages.find(
      m => m.type === 'TM_PREVOTE' && (m.from as number) === 1,
    ) as TmPrevoteMessage
    expect(prevote.vote.blockHash).toBe(blockB.hash)
  })
})

describe('Tendermint — Byzantine proposer strategies', () => {
  it('SILENT proposer causes prevote-timeout and round-change with no commit', () => {
    const cfg: SimConfig = { ...CFG, viewTimeout: 5, byzantineReplicas: [{ id: r(0), strategy: 'SILENT' }] }
    let s = initTendermintSimulation(cfg)

    for (let i = 0; i < 20; i++) {
      s = advanceTendermintStep(s, cfg)
      if (s.viewStates[0]?.phase === 'ROUND_TIMED_OUT') break
    }

    expect(s.viewStates[0].phase).toBe('ROUND_TIMED_OUT')
    expect(s.committedBlocks).toHaveLength(0)
  })

  it('WRONG_BLOCK proposer causes replicas to prevote NIL and no PRECOMMIT quorum forms', () => {
    const cfg: SimConfig = { ...CFG, viewTimeout: 5, byzantineReplicas: [{ id: r(0), strategy: 'WRONG_BLOCK' }] }
    let s = initTendermintSimulation(cfg)

    for (let i = 0; i < 20; i++) {
      s = advanceTendermintStep(s, cfg)
      if (s.viewStates[0]?.phase === 'ROUND_TIMED_OUT') break
    }

    expect(s.committedBlocks).toHaveLength(0)
    const precommits = s.deliveredMessages.filter(m => m.type === 'TM_PRECOMMIT') as { vote: { blockHash: BlockHash } }[]
    expect(precommits.every(m => m.vote.blockHash === NIL_VALUE)).toBe(true)
  })

  it('EQUIVOCATE proposer splits prevotes so no Polka forms in that round', () => {
    const cfg: SimConfig = { ...CFG, viewTimeout: 5, byzantineReplicas: [{ id: r(0), strategy: 'EQUIVOCATE' }] }
    let s = initTendermintSimulation(cfg)

    for (let i = 0; i < 20; i++) {
      s = advanceTendermintStep(s, cfg)
      if (s.currentView > 0 || s.viewStates[0]?.phase === 'ROUND_TIMED_OUT') break
    }

    expect(s.committedBlocks).toHaveLength(0)
  })

  it('DELAY proposer withholds proposal until elapsed reaches viewTimeout/2', () => {
    const cfg: SimConfig = { ...CFG, viewTimeout: 10, byzantineReplicas: [{ id: r(0), strategy: 'DELAY' }] }
    const base = initTendermintSimulation(cfg)

    const early = advanceTendermintStep({ ...base, stepIndex: 2 }, cfg)
    expect(early.blockchain).toHaveLength(1)
    expect(early.pendingMessages).toHaveLength(0)

    const late = advanceTendermintStep({ ...base, stepIndex: 5 }, cfg)
    expect(late.blockchain).toHaveLength(2)
    expect(late.pendingMessages.filter(m => m.type === 'TM_PROPOSE')).toHaveLength(1)
  })
})

describe('Tendermint — Byzantine non-leader replica', () => {
  it('f=1 SILENT non-leader still allows commit with 3 honest replicas', () => {
    const cfg: SimConfig = { ...CFG, byzantineReplicas: [{ id: r(1), strategy: 'SILENT' }] }
    let s = initTendermintSimulation(cfg)

    for (let i = 0; i < 60; i++) {
      s = advanceTendermintStep(s, cfg)
      if (s.committedBlocks.length > 0) break
    }

    expect(s.committedBlocks).toHaveLength(2)
  })
})

describe('Tendermint — round-change is timeout-driven, not message-survival-driven', () => {
  it('rounds still advance via local timeout even at 100% drop rate, with no commit', () => {
    const cfg: SimConfig = { ...CFG, viewTimeout: 5, dropRate: 1 }
    let s = initTendermintSimulation(cfg)

    for (let i = 0; i < 30; i++) {
      s = advanceTendermintStep(s, cfg)
      if (s.viewStates.length > 1) break
    }

    expect(s.viewStates.length).toBeGreaterThan(1)
    const newVS = s.viewStates[s.viewStates.length - 1]
    expect(newVS.round).toBeGreaterThan(0)
    expect(newVS.height).toBe(0)
    expect(s.committedBlocks).toHaveLength(0)
    expect(s.droppedMessages.length).toBeGreaterThan(0)
  })
})
