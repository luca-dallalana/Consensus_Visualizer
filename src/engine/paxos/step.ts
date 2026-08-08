import type { Block, ReplicaId, ViewNumber, Vote } from '../../types'
import type { SimConfig } from '../../types'
import type {
  PaxosSimulationStep, PaxosViewState, PaxosReplicaState, PaxosMessage,
  PaxosPrepareMessage, PaxosPromiseMessage, PaxosAcceptMessage, PaxosAcceptedMessage,
} from '../../types'
import { makeGenesisBlock, makeBlock, makeVote } from '../shared/factory'
import { leaderForView, majorityQuorumSize } from '../shared/protocol'
import { tryFormQC, collectUncommittedAncestors } from '../shared/helpers'
import { stepRng } from '../shared/prng'

function getVS(step: PaxosSimulationStep): PaxosViewState {
  return step.viewStates[step.currentView]
}

function replaceVS(viewStates: readonly PaxosViewState[], updated: PaxosViewState): PaxosViewState[] {
  return viewStates.map(vs => (vs.view as number) === (updated.view as number) ? updated : vs)
}

function mkPrepare(from: ReplicaId, view: ViewNumber, proposalNumber: number, step: number): PaxosPrepareMessage {
  return {
    id: `paxos-PR-${view as number}-${from as number}-${step}`,
    type: 'PAXOS_PREPARE', from, to: 'broadcast', view, sentAtStep: step, proposalNumber,
  }
}

function mkPromise(
  from: ReplicaId, to: ReplicaId, view: ViewNumber, proposalNumber: number,
  priorAccepted: { number: number; block: Block } | null, step: number,
): PaxosPromiseMessage {
  return {
    id: `paxos-PM-${view as number}-${from as number}-${step}`,
    type: 'PAXOS_PROMISE', from, to, view, sentAtStep: step, proposalNumber, priorAccepted,
  }
}

function mkAccept(
  from: ReplicaId, view: ViewNumber, proposalNumber: number, block: Block, step: number,
): PaxosAcceptMessage {
  return {
    id: `paxos-A-${view as number}-${from as number}-${step}`,
    type: 'PAXOS_ACCEPT', from, to: 'broadcast', view, sentAtStep: step, proposalNumber, block,
  }
}

function mkAccepted(
  from: ReplicaId, to: ReplicaId, view: ViewNumber, proposalNumber: number, vote: Vote, step: number,
): PaxosAcceptedMessage {
  return {
    id: `paxos-AC-${view as number}-${from as number}-${step}`,
    type: 'PAXOS_ACCEPTED', from, to, view, sentAtStep: step, proposalNumber, vote,
  }
}

// Shared by init and doAdvanceToNextView — Paxos has no PBFT-style pre-phase
// to defer the leader's SILENT/DELAY branch to, so it's resolved right here,
// at view construction, by scheduling (or withholding) the PREPARE broadcast.
function startView(
  config: SimConfig,
  view: ViewNumber,
  leader: ReplicaId,
  proposalNumber: number,
  stepIndex: number,
): { viewState: PaxosViewState; pendingMessages: PaxosMessage[] } {
  const viewState: PaxosViewState = {
    view, leader, phase: 'PREPARE_VOTING', proposalNumber,
    proposal: null, promises: [], accepteds: [], decidedBlock: null,
    viewStartStep: stepIndex,
  }

  const byz = config.byzantineReplicas.find(b => (b.id as number) === (leader as number))
  if (byz?.strategy === 'SILENT') {
    return { viewState, pendingMessages: [] }
  }

  const delay = byz?.strategy === 'DELAY' ? Math.floor(config.viewTimeout / 2) : 0
  return { viewState, pendingMessages: [mkPrepare(leader, view, proposalNumber, stepIndex + delay)] }
}

export function initPaxosSimulation(config: SimConfig): PaxosSimulationStep {
  const genesis = makeGenesisBlock()
  const allIds  = Array.from({ length: config.n }, (_, i) => i as ReplicaId)
  const view0   = 0 as ViewNumber

  const replicaStates: PaxosReplicaState[] = allIds.map(id => ({
    id,
    currentView:      view0,
    promisedNumber:   0,
    acceptedProposal: null,
    isByzantine:      config.byzantineReplicas.some(b => (b.id as number) === (id as number)),
  }))

  const leader0 = leaderForView(view0, config.n)
  const { viewState, pendingMessages } = startView(config, view0, leader0, 1, 0)

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

export function advancePaxosStep(current: PaxosSimulationStep, config: SimConfig): PaxosSimulationStep {
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
      ] as PaxosMessage[]

      if (config.dropRate > 0 && rng() < config.dropRate) {
        return {
          ...current,
          stepIndex:       next,
          pendingMessages: rest,
          droppedMessages: [...current.droppedMessages, msg],
        }
      }

      switch (msg.type) {
        case 'PAXOS_PREPARE':  return deliverPrepare(current, config, next, msg as PaxosPrepareMessage, rest)
        case 'PAXOS_PROMISE':  return deliverPromise(current, config, next, msg as PaxosPromiseMessage, rest)
        case 'PAXOS_ACCEPT':   return deliverAccept(current, config, next, msg as PaxosAcceptMessage, rest)
        case 'PAXOS_ACCEPTED': return deliverAccepted(current, config, next, msg as PaxosAcceptedMessage, rest)
      }
    }
  }

  const vs = getVS(current)
  switch (vs.phase) {
    case 'PREPARE_VOTING': return handleTimeout(current, config, next)
    case 'ACCEPT_VOTING':  return handleTimeout(current, config, next)
    case 'DECIDED':        return doAdvanceToNextView(current, config, next)
    case 'TIMED_OUT':      return doAdvanceToNextView(current, config, next)
  }
}

function deliverPrepare(
  current: PaxosSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     PaxosPrepareMessage,
  rest:    PaxosMessage[],
): PaxosSimulationStep {
  const targetIds: number[] =
    msg.to === 'broadcast'
      ? current.replicaStates.map(r => r.id as number)
      : [msg.to as number]

  const replicaStates = [...current.replicaStates]
  const honestMsgs:  PaxosMessage[] = []
  const delayedMsgs: PaxosMessage[] = []

  for (const rid of targetIds) {
    const r   = replicaStates[rid]
    const byz = config.byzantineReplicas.find(b => (b.id as number) === rid)

    // A replica only ever receives one PREPARE per view and views only move
    // forward, so msg.proposalNumber is always higher than r.promisedNumber —
    // no staleness check needed (unlike textbook Paxos, which must handle
    // concurrent proposers; this architecture has exactly one at a time).
    if (!r.isByzantine || !byz) {
      replicaStates[rid] = { ...r, promisedNumber: msg.proposalNumber }
      honestMsgs.push(mkPromise(r.id, msg.from, msg.view, msg.proposalNumber, r.acceptedProposal, next))
    } else if (byz.strategy === 'DELAY') {
      const delay = Math.floor(config.viewTimeout / 2)
      delayedMsgs.push(mkPromise(r.id, msg.from, msg.view, msg.proposalNumber, r.acceptedProposal, next + delay))
    }
    // SILENT (and any other strategy — unreachable via the UI for Paxos) sends nothing.
  }

  return {
    ...current,
    stepIndex:         next,
    replicaStates,
    pendingMessages:   [...rest, ...honestMsgs, ...delayedMsgs],
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function deliverPromise(
  current: PaxosSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     PaxosPromiseMessage,
  rest:    PaxosMessage[],
): PaxosSimulationStep {
  const q  = majorityQuorumSize(config.n)
  const vs = getVS(current)

  const newPromises = [
    ...vs.promises,
    { voterId: msg.from, proposalNumber: msg.proposalNumber, priorAccepted: msg.priorAccepted },
  ]
  let updatedVS  = { ...vs, promises: newPromises }
  let pending    = rest
  let blockchain = current.blockchain

  if (newPromises.length >= q && vs.phase === 'PREPARE_VOTING') {
    // Safety rule: adopt the block from the highest-numbered prior accept
    // seen among the promises, instead of proposing fresh — this is what
    // keeps a value durable across a proposer change.
    const adopted = newPromises.reduce<{ number: number; block: Block } | null>((best, p) => {
      if (p.priorAccepted === null) return best
      if (best === null || p.priorAccepted.number > best.number) return p.priorAccepted
      return best
    }, null)

    const parent  = current.blockchain[current.blockchain.length - 1]
    const rng     = stepRng(config.seed ?? 0, next)
    const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
    const block   = adopted !== null ? adopted.block : makeBlock(parent, vs.view, vs.leader, payload)

    // Extend the chain like every other engine's propose step — an adopted
    // block may already be here from the earlier view that first proposed it.
    if (!current.blockchain.some(b => b.hash === block.hash)) {
      blockchain = [...current.blockchain, block]
    }

    updatedVS = { ...updatedVS, proposal: block, phase: 'ACCEPT_VOTING' }
    pending   = [
      ...rest.filter(m => m.type !== 'PAXOS_PROMISE'),
      mkAccept(vs.leader, vs.view, vs.proposalNumber, block, next),
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

function deliverAccept(
  current: PaxosSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     PaxosAcceptMessage,
  rest:    PaxosMessage[],
): PaxosSimulationStep {
  const curView = current.currentView as ViewNumber

  const targetIds: number[] =
    msg.to === 'broadcast'
      ? current.replicaStates.map(r => r.id as number)
      : [msg.to as number]

  const replicaStates = [...current.replicaStates]
  const honestMsgs:  PaxosMessage[] = []
  const delayedMsgs: PaxosMessage[] = []

  for (const rid of targetIds) {
    const r    = replicaStates[rid]
    const byz  = config.byzantineReplicas.find(b => (b.id as number) === rid)
    const vote = makeVote(curView, msg.block.hash, r.id)

    if (!r.isByzantine || !byz) {
      replicaStates[rid] = { ...r, acceptedProposal: { number: msg.proposalNumber, block: msg.block } }
      honestMsgs.push(mkAccepted(r.id, msg.from, curView, msg.proposalNumber, vote, next))
    } else if (byz.strategy === 'DELAY') {
      const delay = Math.floor(config.viewTimeout / 2)
      delayedMsgs.push(mkAccepted(r.id, msg.from, curView, msg.proposalNumber, vote, next + delay))
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

function deliverAccepted(
  current: PaxosSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     PaxosAcceptedMessage,
  rest:    PaxosMessage[],
): PaxosSimulationStep {
  const q        = majorityQuorumSize(config.n)
  const vs       = getVS(current)
  const newVotes = [...vs.accepteds, msg.vote]
  let updatedVS  = { ...vs, accepteds: newVotes }
  let pending    = rest

  const qc = tryFormQC(newVotes, vs.view, q)
  if (qc !== null && vs.phase === 'ACCEPT_VOTING') {
    const decidedHash = qc.blockHash
    const alreadyDone = current.committedBlocks.includes(decidedHash)

    updatedVS = {
      ...updatedVS,
      phase:        'DECIDED',
      decidedBlock: alreadyDone ? vs.decidedBlock : decidedHash,
    }
    pending = rest.filter(m => m.type !== 'PAXOS_ACCEPTED')

    if (!alreadyDone) {
      // A prior view can time out after its block was already pushed to the
      // chain (dropRate > 0) without ever committing — backfill it here.
      const ancestors = collectUncommittedAncestors(decidedHash, current.blockchain, current.committedBlocks)
      return {
        ...current,
        stepIndex:         next,
        viewStates:        replaceVS(current.viewStates, updatedVS),
        committedBlocks:   [...current.committedBlocks, ...ancestors, decidedHash],
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

function handleTimeout(current: PaxosSimulationStep, config: SimConfig, next: number): PaxosSimulationStep {
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
  current:       PaxosSimulationStep,
  config:        SimConfig,
  nextStepIndex: number,
): PaxosSimulationStep {
  const nextViewNum     = (current.currentView + 1) as ViewNumber
  const nextLeader      = leaderForView(nextViewNum, config.n)
  const nextProposalNum = (nextViewNum as number) + 1

  // Each view is its own Paxos slot (Multi-Paxos style) — promisedNumber/
  // acceptedProposal must persist across a TIMED_OUT retry of the SAME
  // undecided slot (that's the cross-view safety memory), but reset once a
  // slot actually DECIDED, or every later slot would keep re-adopting the
  // first-ever committed block forever instead of proposing new ones.
  const startingNewSlot = getVS(current).phase === 'DECIDED'
  const replicaStates: PaxosReplicaState[] = current.replicaStates.map(r => ({
    ...r,
    currentView:      nextViewNum,
    promisedNumber:   startingNewSlot ? 0 : r.promisedNumber,
    acceptedProposal: startingNewSlot ? null : r.acceptedProposal,
  }))

  const { viewState, pendingMessages } = startView(config, nextViewNum, nextLeader, nextProposalNum, nextStepIndex)

  return {
    ...current,
    stepIndex:       nextStepIndex,
    currentView:     current.currentView + 1,
    replicaStates,
    viewStates:      [...current.viewStates, viewState],
    pendingMessages,
  }
}
