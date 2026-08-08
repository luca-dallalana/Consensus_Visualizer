import type { ReplicaId, ViewNumber, Vote } from '../../types'
import type { SimConfig } from '../../types'
import type {
  RaftSimulationStep, RaftViewState, RaftReplicaState, RaftMessage,
  RaftRequestVoteMessage, RaftVoteGrantMessage, RaftAppendMessage, RaftAppendAckMessage,
} from '../../types'
import { makeGenesisBlock, makeBlock, makeVote } from '../shared/factory'
import { leaderForView, majorityQuorumSize } from '../shared/protocol'
import { tryFormQC, collectUncommittedAncestors } from '../shared/helpers'
import { stepRng } from '../shared/prng'

function getVS(step: RaftSimulationStep): RaftViewState {
  return step.viewStates[step.currentView]
}

function replaceVS(viewStates: readonly RaftViewState[], updated: RaftViewState): RaftViewState[] {
  return viewStates.map(vs => (vs.view as number) === (updated.view as number) ? updated : vs)
}

function mkRequestVote(
  from: ReplicaId, view: ViewNumber, term: number, lastLogIndex: number, lastLogTerm: number, step: number,
): RaftRequestVoteMessage {
  return {
    id: `raft-RV-${view as number}-${from as number}-${step}`,
    type: 'RAFT_REQUEST_VOTE', from, to: 'broadcast', view, sentAtStep: step, term, lastLogIndex, lastLogTerm,
  }
}

function mkVoteGrant(
  from: ReplicaId, to: ReplicaId, view: ViewNumber, term: number, granted: boolean, step: number,
): RaftVoteGrantMessage {
  return {
    id: `raft-VG-${view as number}-${from as number}-${step}`,
    type: 'RAFT_VOTE_GRANT', from, to, view, sentAtStep: step, term, granted,
  }
}

function mkAppend(
  from: ReplicaId, view: ViewNumber, term: number, block: import('../../types').Block, step: number,
): RaftAppendMessage {
  return {
    id: `raft-AP-${view as number}-${from as number}-${step}`,
    type: 'RAFT_APPEND', from, to: 'broadcast', view, sentAtStep: step, term, block,
  }
}

function mkAppendAck(
  from: ReplicaId, to: ReplicaId, view: ViewNumber, term: number, vote: Vote, step: number,
): RaftAppendAckMessage {
  return {
    id: `raft-APA-${view as number}-${from as number}-${step}`,
    type: 'RAFT_APPEND_ACK', from, to, view, sentAtStep: step, term, vote,
  }
}

// Shared by init and doAdvanceToNextView. The candidate's own log values are
// passed in by the caller (read from replicaStates) so this stays pure.
function startView(
  config: SimConfig,
  view: ViewNumber,
  candidate: ReplicaId,
  candidateLastLogIndex: number,
  candidateLastLogTerm: number,
  term: number,
  stepIndex: number,
): { viewState: RaftViewState; pendingMessages: RaftMessage[] } {
  const viewState: RaftViewState = {
    view, leader: candidate, phase: 'REQUEST_VOTE_VOTING', term,
    proposal: null, votesGranted: [], appendAcks: [], committedBlock: null,
    viewStartStep: stepIndex,
  }

  const byz = config.byzantineReplicas.find(b => (b.id as number) === (candidate as number))
  if (byz?.strategy === 'SILENT') {
    return { viewState, pendingMessages: [] }
  }

  const delay = byz?.strategy === 'DELAY' ? Math.floor(config.viewTimeout / 2) : 0
  return {
    viewState,
    pendingMessages: [mkRequestVote(candidate, view, term, candidateLastLogIndex, candidateLastLogTerm, stepIndex + delay)],
  }
}

export function initRaftSimulation(config: SimConfig): RaftSimulationStep {
  const genesis = makeGenesisBlock()
  const allIds  = Array.from({ length: config.n }, (_, i) => i as ReplicaId)
  const view0   = 0 as ViewNumber

  const replicaStates: RaftReplicaState[] = allIds.map(id => ({
    id,
    currentView:   view0,
    currentTerm:   0,
    lastLogIndex:  0,
    lastLogTerm:   -1,
    isByzantine:   config.byzantineReplicas.some(b => (b.id as number) === (id as number)),
  }))

  const candidate0 = leaderForView(view0, config.n)
  const { viewState, pendingMessages } = startView(config, view0, candidate0, 0, -1, 1, 0)

  return {
    stepIndex:         0,
    currentView:       0,
    replicaStates,
    viewStates:        [viewState],
    blockchain:        [genesis],
    committedBlocks:   [],
    pendingMessages,
    deliveredMessages: [],
    droppedMessages:   [],
  }
}

export function advanceRaftStep(current: RaftSimulationStep, config: SimConfig): RaftSimulationStep {
  const next = current.stepIndex + 1

  if (current.pendingMessages.length > 0) {
    const eligible = current.pendingMessages
      .map((_, i) => i)
      .filter(i => current.pendingMessages[i].sentAtStep <= next)

    if (eligible.length > 0) {
      const rng  = stepRng(config.seed ?? 0, next)
      const pick = eligible[Math.floor(rng() * eligible.length)]
      const msg  = current.pendingMessages[pick]
      const rest = [
        ...current.pendingMessages.slice(0, pick),
        ...current.pendingMessages.slice(pick + 1),
      ] as RaftMessage[]

      if (config.dropRate > 0 && rng() < config.dropRate) {
        return {
          ...current,
          stepIndex:       next,
          pendingMessages: rest,
          droppedMessages: [...current.droppedMessages, msg],
        }
      }

      switch (msg.type) {
        case 'RAFT_REQUEST_VOTE': return deliverRequestVote(current, config, next, msg as RaftRequestVoteMessage, rest)
        case 'RAFT_VOTE_GRANT':   return deliverVoteGrant(current, config, next, msg as RaftVoteGrantMessage, rest)
        case 'RAFT_APPEND':       return deliverAppend(current, config, next, msg as RaftAppendMessage, rest)
        case 'RAFT_APPEND_ACK':   return deliverAppendAck(current, config, next, msg as RaftAppendAckMessage, rest)
      }
    }
  }

  const vs = getVS(current)
  switch (vs.phase) {
    case 'REQUEST_VOTE_VOTING': return handleTimeout(current, config, next)
    case 'APPEND_VOTING':       return handleTimeout(current, config, next)
    case 'COMMITTED':           return doAdvanceToNextView(current, config, next)
    case 'TIMED_OUT':           return doAdvanceToNextView(current, config, next)
  }
}

function deliverRequestVote(
  current: RaftSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     RaftRequestVoteMessage,
  rest:    RaftMessage[],
): RaftSimulationStep {
  const targetIds: number[] =
    msg.to === 'broadcast'
      ? current.replicaStates.map(r => r.id as number)
      : [msg.to as number]

  const honestMsgs:  RaftMessage[] = []
  const delayedMsgs: RaftMessage[] = []

  for (const rid of targetIds) {
    const r   = current.replicaStates[rid]
    const byz = config.byzantineReplicas.find(b => (b.id as number) === rid)

    // No replicaState mutation here — unlike Paxos's promisedNumber, there's
    // no per-term memory to record: exactly one candidate runs per term.
    const granted =
      msg.lastLogTerm > r.lastLogTerm ||
      (msg.lastLogTerm === r.lastLogTerm && msg.lastLogIndex >= r.lastLogIndex)

    if (!r.isByzantine || !byz) {
      honestMsgs.push(mkVoteGrant(r.id, msg.from, msg.view, msg.term, granted, next))
    } else if (byz.strategy === 'DELAY') {
      const delay = Math.floor(config.viewTimeout / 2)
      delayedMsgs.push(mkVoteGrant(r.id, msg.from, msg.view, msg.term, granted, next + delay))
    }
    // SILENT (and any other strategy — unreachable via the UI for Raft) sends nothing.
  }

  return {
    ...current,
    stepIndex:         next,
    pendingMessages:   [...rest, ...honestMsgs, ...delayedMsgs],
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function deliverVoteGrant(
  current: RaftSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     RaftVoteGrantMessage,
  rest:    RaftMessage[],
): RaftSimulationStep {
  const q  = majorityQuorumSize(config.n)
  const vs = getVS(current)

  const newVotes = [...vs.votesGranted, { voterId: msg.from, term: msg.term, granted: msg.granted }]
  let updatedVS  = { ...vs, votesGranted: newVotes }
  let pending    = rest
  let blockchain = current.blockchain

  const grantedCount = newVotes.filter(g => g.granted).length
  if (grantedCount >= q && vs.phase === 'REQUEST_VOTE_VOTING') {
    // No value-adoption logic needed — the vote gate already guaranteed this
    // leader is at least as up-to-date as a majority, so it just extends the
    // chain's real tip (unlike Paxos, there's no separately-stored "value
    // I'm holding" to reconcile).
    const parent  = current.blockchain[current.blockchain.length - 1]
    const rng     = stepRng(config.seed ?? 0, next)
    const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
    const block   = makeBlock(parent, vs.view, vs.leader, payload)

    blockchain = [...current.blockchain, block]
    updatedVS  = { ...updatedVS, proposal: block, phase: 'APPEND_VOTING' }
    pending    = [
      ...rest.filter(m => m.type !== 'RAFT_VOTE_GRANT'),
      mkAppend(vs.leader, vs.view, vs.term, block, next),
    ]
  }

  return {
    ...current,
    stepIndex:         next,
    blockchain,
    viewStates:        replaceVS(current.viewStates, updatedVS),
    pendingMessages:   pending,
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function deliverAppend(
  current: RaftSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     RaftAppendMessage,
  rest:    RaftMessage[],
): RaftSimulationStep {
  const curView = current.currentView as ViewNumber

  const targetIds: number[] =
    msg.to === 'broadcast'
      ? current.replicaStates.map(r => r.id as number)
      : [msg.to as number]

  const replicaStates = [...current.replicaStates]
  const honestMsgs:  RaftMessage[] = []
  const delayedMsgs: RaftMessage[] = []

  for (const rid of targetIds) {
    const r    = replicaStates[rid]
    const byz  = config.byzantineReplicas.find(b => (b.id as number) === rid)
    const vote = makeVote(curView, msg.block.hash, r.id)

    if (!r.isByzantine || !byz) {
      replicaStates[rid] = { ...r, lastLogIndex: msg.block.height, lastLogTerm: msg.term }
      honestMsgs.push(mkAppendAck(r.id, msg.from, curView, msg.term, vote, next))
    } else if (byz.strategy === 'DELAY') {
      // Stays stale — never updates its own log while byzantine, which is
      // exactly what lets the vote-comparison gate reject it later.
      const delay = Math.floor(config.viewTimeout / 2)
      delayedMsgs.push(mkAppendAck(r.id, msg.from, curView, msg.term, vote, next + delay))
    }
  }

  return {
    ...current,
    stepIndex:         next,
    replicaStates,
    pendingMessages:   [...rest, ...honestMsgs, ...delayedMsgs],
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function deliverAppendAck(
  current: RaftSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     RaftAppendAckMessage,
  rest:    RaftMessage[],
): RaftSimulationStep {
  const q        = majorityQuorumSize(config.n)
  const vs       = getVS(current)
  const newVotes = [...vs.appendAcks, msg.vote]
  let updatedVS  = { ...vs, appendAcks: newVotes }
  let pending    = rest

  const qc = tryFormQC(newVotes, vs.view, q)
  if (qc !== null && vs.phase === 'APPEND_VOTING') {
    const committedHash = qc.blockHash
    const alreadyDone   = current.committedBlocks.includes(committedHash)

    updatedVS = {
      ...updatedVS,
      phase:          'COMMITTED',
      committedBlock: alreadyDone ? vs.committedBlock : committedHash,
    }
    pending = rest.filter(m => m.type !== 'RAFT_APPEND_ACK')

    if (!alreadyDone) {
      const ancestors = collectUncommittedAncestors(committedHash, current.blockchain, current.committedBlocks)
      return {
        ...current,
        stepIndex:         next,
        viewStates:        replaceVS(current.viewStates, updatedVS),
        committedBlocks:   [...current.committedBlocks, ...ancestors, committedHash],
        pendingMessages:   pending,
        deliveredMessages: [...current.deliveredMessages, msg],
      }
    }
  }

  return {
    ...current,
    stepIndex:         next,
    viewStates:        replaceVS(current.viewStates, updatedVS),
    pendingMessages:   pending,
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function handleTimeout(current: RaftSimulationStep, config: SimConfig, next: number): RaftSimulationStep {
  const vs      = getVS(current)
  const elapsed = current.stepIndex - vs.viewStartStep
  if (elapsed < config.viewTimeout) {
    return { ...current, stepIndex: next }
  }

  return {
    ...current,
    stepIndex:       next,
    viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'TIMED_OUT' }),
    pendingMessages: [],
  }
}

function doAdvanceToNextView(
  current:       RaftSimulationStep,
  config:        SimConfig,
  nextStepIndex: number,
): RaftSimulationStep {
  const nextViewNum = (current.currentView + 1) as ViewNumber
  const nextTerm     = (nextViewNum as number) + 1
  const nextLeader   = leaderForView(nextViewNum, config.n)

  // currentTerm bumps in lockstep with currentView for everyone (display
  // only). lastLogIndex/lastLogTerm never reset — real replicated-log state,
  // unlike Paxos's per-slot acceptedProposal.
  const replicaStates: RaftReplicaState[] = current.replicaStates.map(r => ({
    ...r,
    currentView: nextViewNum,
    currentTerm: nextTerm,
  }))

  const candidate = replicaStates[nextLeader as number]
  const { viewState, pendingMessages } = startView(
    config, nextViewNum, nextLeader, candidate.lastLogIndex, candidate.lastLogTerm, nextTerm, nextStepIndex,
  )

  return {
    ...current,
    stepIndex:       nextStepIndex,
    currentView:     current.currentView + 1,
    replicaStates,
    viewStates:      [...current.viewStates, viewState],
    pendingMessages,
  }
}
