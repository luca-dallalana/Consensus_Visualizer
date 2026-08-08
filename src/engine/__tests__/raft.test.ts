import { describe, it, expect } from 'vitest'
import { initRaftSimulation, advanceRaftStep } from '../raft/step'
import { makeGenesisBlock, makeBlock } from '../shared/factory'
import { majorityQuorumSize, quorumSize } from '../shared/protocol'
import type { ReplicaId, ViewNumber } from '../../types'
import type { RaftSimulationStep, RaftViewState, RaftReplicaState, RaftVoteGrantMessage, RaftRequestVoteMessage } from '../../types'
import type { SimConfig } from '../../types'

const N = 4
const v = (n: number) => n as ViewNumber
const r = (n: number) => n as ReplicaId

const CFG: SimConfig = {
  n: N, f: 1, seed: 0, viewTimeout: 999, maxViews: 20,
  byzantineReplicas: [], dropRate: 0, protocol: 'raft',
}

function mkReplicaStates(n: number): RaftReplicaState[] {
  return Array.from({ length: n }, (_, i) => ({
    id: r(i), currentView: v(0), currentTerm: 1, lastLogIndex: 0, lastLogTerm: -1, isByzantine: false,
  }))
}

function mkVS(view: number, opts: Partial<RaftViewState> = {}): RaftViewState {
  return {
    view: v(view), leader: r(view % N), phase: 'REQUEST_VOTE_VOTING', term: view + 1,
    proposal: null, votesGranted: [], appendAcks: [], committedBlock: null, viewStartStep: 0,
    ...opts,
  }
}

describe('Raft — normal commit path', () => {
  it('block is committed after REQUEST_VOTE -> VOTE_GRANT -> APPEND -> APPEND_ACK', () => {
    let s = initRaftSimulation(CFG)
    for (let i = 0; i < 60; i++) {
      s = advanceRaftStep(s, CFG)
      if (s.committedBlocks.length > 0) break
    }
    // committedBlocks includes genesis as its own root entry on the first
    // real commit (established convention — see basic.test.ts:95).
    expect(s.committedBlocks).toHaveLength(2)
    expect(s.blockchain).toHaveLength(2)
    expect(s.viewStates[0].phase).toBe('COMMITTED')
    expect(s.viewStates[0].committedBlock).toBe(s.committedBlocks[1])
  })
})

describe('Raft — SILENT candidate retries with no view-change handshake', () => {
  it('silent candidate times out with an empty pending queue, next view has a different candidate, and it still commits', () => {
    const cfg: SimConfig = { ...CFG, viewTimeout: 5, byzantineReplicas: [{ id: r(0), strategy: 'SILENT' }] }
    let s = initRaftSimulation(cfg)

    for (let i = 0; i < 15; i++) {
      s = advanceRaftStep(s, cfg)
      if (s.viewStates[0]?.phase === 'TIMED_OUT') break
    }
    expect(s.viewStates[0].phase).toBe('TIMED_OUT')
    expect(s.pendingMessages).toHaveLength(0)

    for (let i = 0; i < 60; i++) {
      s = advanceRaftStep(s, cfg)
      if (s.committedBlocks.length > 0) break
    }
    expect(s.committedBlocks).toHaveLength(2)
    expect(s.viewStates[1].leader).toBe(r(1))
  })
})

describe('Raft — majority quorum, not BFT quorum', () => {
  it('commits at N=5 with only 3 live replicas, which a floor(2n/3)+1 BFT quorum could not do', () => {
    expect(majorityQuorumSize(5)).toBe(3)
    expect(quorumSize(5)).toBe(4)

    const cfg: SimConfig = {
      ...CFG, n: 5,
      byzantineReplicas: [{ id: r(1), strategy: 'SILENT' }, { id: r(2), strategy: 'SILENT' }],
    }
    let s = initRaftSimulation(cfg)
    for (let i = 0; i < 60; i++) {
      s = advanceRaftStep(s, cfg)
      if (s.committedBlocks.length > 0) break
    }
    expect(s.committedBlocks).toHaveLength(2)
  })
})

describe('Raft — DELAY candidate', () => {
  it('schedules its REQUEST_VOTE at a future step and still eventually commits', () => {
    const cfg: SimConfig = { ...CFG, viewTimeout: 10, byzantineReplicas: [{ id: r(0), strategy: 'DELAY' }] }
    const s0 = initRaftSimulation(cfg)

    expect(s0.pendingMessages).toHaveLength(1)
    expect(s0.pendingMessages[0].type).toBe('RAFT_REQUEST_VOTE')
    expect(s0.pendingMessages[0].sentAtStep).toBe(Math.floor(cfg.viewTimeout / 2))

    let s = s0
    for (let i = 0; i < 60; i++) {
      s = advanceRaftStep(s, cfg)
      if (s.committedBlocks.length > 0) break
    }
    expect(s.committedBlocks).toHaveLength(2)
  })
})

describe('Raft — vote-grant quorum counts only granted:true (flagship regression)', () => {
  it('does not elect a leader on 3 rejections + 1 grant, even though 4 replies reach the reply-count', () => {
    const genesis = makeGenesisBlock()
    const grants: RaftVoteGrantMessage[] = [
      { id: 'g0', type: 'RAFT_VOTE_GRANT', from: r(0), to: r(1), view: v(1), sentAtStep: 1, term: 2, granted: false },
      { id: 'g2', type: 'RAFT_VOTE_GRANT', from: r(2), to: r(1), view: v(1), sentAtStep: 1, term: 2, granted: false },
      { id: 'g3', type: 'RAFT_VOTE_GRANT', from: r(3), to: r(1), view: v(1), sentAtStep: 1, term: 2, granted: false },
      { id: 'g1', type: 'RAFT_VOTE_GRANT', from: r(1), to: r(1), view: v(1), sentAtStep: 1, term: 2, granted: true  },
    ]
    let s: RaftSimulationStep = {
      stepIndex: 0, currentView: 1,
      replicaStates: mkReplicaStates(N),
      viewStates: [mkVS(0, { phase: 'TIMED_OUT' }), mkVS(1, { leader: r(1), term: 2 })],
      blockchain: [genesis], committedBlocks: [],
      pendingMessages: grants, deliveredMessages: [], droppedMessages: [],
    }
    for (let i = 0; i < 4; i++) s = advanceRaftStep(s, CFG)

    expect(s.viewStates[1].phase).toBe('REQUEST_VOTE_VOTING')
    expect(s.blockchain).toHaveLength(1)
  })
})

describe('Raft — log-comparison gate rejects a stale candidate (flagship safety rule)', () => {
  it('refuses a vote request whose log lags behind the voters', () => {
    const genesis = makeGenesisBlock()
    const replicaStates: RaftReplicaState[] = [
      { id: r(0), currentView: v(1), currentTerm: 2, lastLogIndex: 0, lastLogTerm: -1, isByzantine: false },
      { id: r(1), currentView: v(1), currentTerm: 2, lastLogIndex: 2, lastLogTerm: 1,  isByzantine: false },
      { id: r(2), currentView: v(1), currentTerm: 2, lastLogIndex: 2, lastLogTerm: 1,  isByzantine: false },
      { id: r(3), currentView: v(1), currentTerm: 2, lastLogIndex: 2, lastLogTerm: 1,  isByzantine: false },
    ]
    const requestVote: RaftRequestVoteMessage = {
      id: 'rv', type: 'RAFT_REQUEST_VOTE', from: r(0), to: 'broadcast', view: v(1), sentAtStep: 1,
      term: 2, lastLogIndex: 0, lastLogTerm: -1,
    }
    let s: RaftSimulationStep = {
      stepIndex: 0, currentView: 1,
      replicaStates,
      viewStates: [mkVS(0, { phase: 'TIMED_OUT' }), mkVS(1, { leader: r(0), term: 2 })],
      blockchain: [genesis], committedBlocks: [],
      pendingMessages: [requestVote], deliveredMessages: [], droppedMessages: [],
    }
    s = advanceRaftStep(s, CFG)

    // The candidate trivially grants its own request (comparing its log
    // against itself always passes) — the real safety property is that the
    // three up-to-date voters refuse, keeping the total below quorum.
    const grants     = s.pendingMessages.filter((m): m is RaftVoteGrantMessage => m.type === 'RAFT_VOTE_GRANT')
    const trueGrants = grants.filter(g => g.granted)
    expect(grants.length).toBeGreaterThan(0)
    expect(trueGrants.length).toBeLessThan(majorityQuorumSize(N))
  })

  it('grants the vote when the candidate is at least as up-to-date', () => {
    const genesis = makeGenesisBlock()
    const replicaStates: RaftReplicaState[] = [
      { id: r(0), currentView: v(1), currentTerm: 2, lastLogIndex: 2, lastLogTerm: 1, isByzantine: false },
      { id: r(1), currentView: v(1), currentTerm: 2, lastLogIndex: 2, lastLogTerm: 1, isByzantine: false },
      { id: r(2), currentView: v(1), currentTerm: 2, lastLogIndex: 1, lastLogTerm: 1, isByzantine: false },
      { id: r(3), currentView: v(1), currentTerm: 2, lastLogIndex: 0, lastLogTerm: -1, isByzantine: false },
    ]
    const requestVote: RaftRequestVoteMessage = {
      id: 'rv', type: 'RAFT_REQUEST_VOTE', from: r(0), to: 'broadcast', view: v(1), sentAtStep: 1,
      term: 2, lastLogIndex: 2, lastLogTerm: 1,
    }
    let s: RaftSimulationStep = {
      stepIndex: 0, currentView: 1,
      replicaStates,
      viewStates: [mkVS(0, { phase: 'TIMED_OUT' }), mkVS(1, { leader: r(0), term: 2 })],
      blockchain: [genesis], committedBlocks: [],
      pendingMessages: [requestVote], deliveredMessages: [], droppedMessages: [],
    }
    s = advanceRaftStep(s, CFG)

    const grants = s.pendingMessages.filter((m): m is RaftVoteGrantMessage => m.type === 'RAFT_VOTE_GRANT')
    expect(grants.length).toBeGreaterThan(0)
    expect(grants.every(g => g.granted === true)).toBe(true)
  })
})

describe('Raft — dangling uncommitted block gets backfilled', () => {
  it('a block appended but never ack-quorumed before timeout is retroactively committed once the chain moves past it', () => {
    const genesis  = makeGenesisBlock()
    const dangling = makeBlock(genesis, v(0), r(0), 'dangling')

    let s: RaftSimulationStep = {
      stepIndex: 0, currentView: 0,
      replicaStates: mkReplicaStates(N),
      viewStates: [mkVS(0, { phase: 'TIMED_OUT' })],
      blockchain: [genesis, dangling], committedBlocks: [],
      pendingMessages: [], deliveredMessages: [], droppedMessages: [],
    }

    for (let i = 0; i < 60; i++) {
      s = advanceRaftStep(s, CFG)
      if (s.committedBlocks.length > 0) break
    }

    expect(s.committedBlocks).toContain(dangling.hash)
    expect(s.committedBlocks[s.committedBlocks.length - 1]).not.toBe(dangling.hash)
  })
})
