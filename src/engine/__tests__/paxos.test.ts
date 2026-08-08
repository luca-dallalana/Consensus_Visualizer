import { describe, it, expect } from 'vitest'
import { initPaxosSimulation, advancePaxosStep } from '../paxos/step'
import { makeGenesisBlock, makeBlock } from '../shared/factory'
import { majorityQuorumSize, quorumSize } from '../shared/protocol'
import type { ReplicaId, ViewNumber } from '../../types'
import type { PaxosSimulationStep, PaxosViewState, PaxosReplicaState, PaxosPromiseMessage } from '../../types'
import type { SimConfig } from '../../types'

const N = 4
const v = (n: number) => n as ViewNumber
const r = (n: number) => n as ReplicaId

const CFG: SimConfig = {
  n: N, f: 1, seed: 0, viewTimeout: 999, maxViews: 20,
  byzantineReplicas: [], dropRate: 0, protocol: 'paxos',
}

function mkReplicaStates(n: number): PaxosReplicaState[] {
  return Array.from({ length: n }, (_, i) => ({
    id: r(i), currentView: v(0), promisedNumber: 0, acceptedProposal: null, isByzantine: false,
  }))
}

function mkVS(view: number, opts: Partial<PaxosViewState> = {}): PaxosViewState {
  return {
    view: v(view), leader: r(view % N), phase: 'PREPARE_VOTING', proposalNumber: view + 1,
    proposal: null, promises: [], accepteds: [], decidedBlock: null, viewStartStep: 0,
    ...opts,
  }
}

describe('Paxos — normal commit path', () => {
  it('block is decided after PREPARE -> PROMISE -> ACCEPT -> ACCEPTED', () => {
    let s = initPaxosSimulation(CFG)
    for (let i = 0; i < 60; i++) {
      s = advancePaxosStep(s, CFG)
      if (s.committedBlocks.length > 0) break
    }
    // committedBlocks includes genesis as its own root entry on the first
    // real commit (established convention — see basic.test.ts:95).
    expect(s.committedBlocks).toHaveLength(2)
    expect(s.viewStates[0].phase).toBe('DECIDED')
    expect(s.viewStates[0].decidedBlock).toBe(s.committedBlocks[1])
  })

  it('the chain actually grows across sequential views instead of every block parenting genesis', () => {
    let s = initPaxosSimulation(CFG)
    const decidedByView = () => s.viewStates.map(vs => vs.decidedBlock).filter((h): h is NonNullable<typeof h> => h !== null)

    for (let i = 0; i < 500 && decidedByView().length < 2; i++) {
      s = advancePaxosStep(s, CFG)
    }
    const decided = decidedByView()
    expect(decided.length).toBeGreaterThanOrEqual(2)
    expect(s.blockchain.length).toBeGreaterThanOrEqual(3)

    const first  = s.blockchain.find(b => b.hash === decided[0])
    const second = s.blockchain.find(b => b.hash === decided[1])
    expect(second?.parentHash).toBe(first?.hash)
  })
})

describe('Paxos — SILENT proposer retries with no view-change handshake', () => {
  it('silent proposer times out with an empty pending queue, next view has a new proposer, and it still commits', () => {
    const cfg: SimConfig = { ...CFG, viewTimeout: 5, byzantineReplicas: [{ id: r(0), strategy: 'SILENT' }] }
    let s = initPaxosSimulation(cfg)

    for (let i = 0; i < 15; i++) {
      s = advancePaxosStep(s, cfg)
      if (s.viewStates[0]?.phase === 'TIMED_OUT') break
    }
    expect(s.viewStates[0].phase).toBe('TIMED_OUT')
    expect(s.pendingMessages).toHaveLength(0)

    for (let i = 0; i < 60; i++) {
      s = advancePaxosStep(s, cfg)
      if (s.committedBlocks.length > 0) break
    }
    expect(s.committedBlocks).toHaveLength(2)
    expect(s.viewStates[1].leader).toBe(r(1))
  })
})

describe('Paxos — majority quorum, not BFT quorum', () => {
  it('commits at N=5 with only 3 live replicas, which a floor(2n/3)+1 BFT quorum could not do', () => {
    expect(majorityQuorumSize(5)).toBe(3)
    expect(quorumSize(5)).toBe(4)

    const cfg: SimConfig = {
      ...CFG, n: 5,
      byzantineReplicas: [{ id: r(1), strategy: 'SILENT' }, { id: r(2), strategy: 'SILENT' }],
    }
    let s = initPaxosSimulation(cfg)
    for (let i = 0; i < 60; i++) {
      s = advancePaxosStep(s, cfg)
      if (s.committedBlocks.length > 0) break
    }
    expect(s.committedBlocks).toHaveLength(2)
  })
})

describe('Paxos — DELAY proposer', () => {
  it('schedules its PREPARE at a future step and still eventually commits', () => {
    const cfg: SimConfig = { ...CFG, viewTimeout: 10, byzantineReplicas: [{ id: r(0), strategy: 'DELAY' }] }
    const s0 = initPaxosSimulation(cfg)

    expect(s0.pendingMessages).toHaveLength(1)
    expect(s0.pendingMessages[0].type).toBe('PAXOS_PREPARE')
    expect(s0.pendingMessages[0].sentAtStep).toBe(Math.floor(cfg.viewTimeout / 2))

    let s = s0
    for (let i = 0; i < 60; i++) {
      s = advancePaxosStep(s, cfg)
      if (s.committedBlocks.length > 0) break
    }
    expect(s.committedBlocks).toHaveLength(2)
  })
})

describe('Paxos — value adoption across a proposer change (flagship safety rule)', () => {
  const genesis  = makeGenesisBlock()
  const blockX   = makeBlock(genesis, v(0), r(0), 'X')
  const blockY   = makeBlock(genesis, v(2), r(2), 'Y')

  function baseState(view: number, leader: ReplicaId, proposalNumber: number, pending: PaxosPromiseMessage[]) {
    const viewStates: PaxosViewState[] = []
    for (let i = 0; i < view; i++) viewStates.push(mkVS(i, { phase: 'TIMED_OUT' }))
    viewStates.push(mkVS(view, { leader, proposalNumber }))

    const state: PaxosSimulationStep = {
      stepIndex: 0, currentView: view,
      replicaStates: mkReplicaStates(N),
      viewStates,
      blockchain: [genesis, blockX, blockY], committedBlocks: [],
      pendingMessages: pending, deliveredMessages: [], droppedMessages: [],
    }
    return state
  }

  it('adopts the sole prior-accepted block instead of proposing fresh', () => {
    const promises: PaxosPromiseMessage[] = [
      { id: 'p0', type: 'PAXOS_PROMISE', from: r(0), to: r(1), view: v(1), sentAtStep: 1, proposalNumber: 2, priorAccepted: { number: 1, block: blockX } },
      { id: 'p2', type: 'PAXOS_PROMISE', from: r(2), to: r(1), view: v(1), sentAtStep: 1, proposalNumber: 2, priorAccepted: null },
      { id: 'p3', type: 'PAXOS_PROMISE', from: r(3), to: r(1), view: v(1), sentAtStep: 1, proposalNumber: 2, priorAccepted: null },
    ]
    let s = baseState(1, r(1), 2, promises)
    for (let i = 0; i < 3; i++) s = advancePaxosStep(s, CFG)

    expect(s.viewStates[1].phase).toBe('ACCEPT_VOTING')
    expect(s.viewStates[1].proposal?.hash).toBe(blockX.hash)
  })

  it('adopts the higher-numbered prior accept when promises disagree', () => {
    const promises: PaxosPromiseMessage[] = [
      { id: 'p0', type: 'PAXOS_PROMISE', from: r(0), to: r(3), view: v(3), sentAtStep: 1, proposalNumber: 4, priorAccepted: { number: 1, block: blockX } },
      { id: 'p2', type: 'PAXOS_PROMISE', from: r(2), to: r(3), view: v(3), sentAtStep: 1, proposalNumber: 4, priorAccepted: { number: 3, block: blockY } },
      { id: 'p1', type: 'PAXOS_PROMISE', from: r(1), to: r(3), view: v(3), sentAtStep: 1, proposalNumber: 4, priorAccepted: null },
    ]
    let s = baseState(3, r(3), 4, promises)
    for (let i = 0; i < 3; i++) s = advancePaxosStep(s, CFG)

    expect(s.viewStates[3].phase).toBe('ACCEPT_VOTING')
    expect(s.viewStates[3].proposal?.hash).toBe(blockY.hash)
  })
})
