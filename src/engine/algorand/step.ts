import type {
  Block, BlockHash, ReplicaId, ReplicaState, ViewNumber, Vote,
} from '../../types'
import type { SimConfig } from '../../types'
import type {
  AlgorandSimulationStep, AlgorandViewState,
  AlgorandMessage, AlgProposeMessage, AlgSoftVoteMessage, AlgCertVoteMessage,
} from '../../types'
import { makeGenesisBlock, makeBlock, makeVote } from '../shared/factory'
import { quorumSize } from '../shared/protocol'
import { tryFormQC, collectUncommittedAncestors } from '../shared/helpers'
import { mulberry32, stepRng } from '../shared/prng'

// expected proposer count per round is tuned slightly above 1, so most rounds
// have exactly one proposer (reads like PBFT) but 0- and 2+-proposer rounds
// still occur regularly enough to observe.
const TAU_NUMERATOR = 1.3

function sortitionDraw(seed: number, view: ViewNumber, replicaId: ReplicaId): number {
  const combined = (seed ^ ((view as number) * 0x9E3779B9) ^ (((replicaId as number) + 1) * 0x85EBCA6B)) >>> 0
  return mulberry32(combined)()
}

function runSortition(seed: number, view: ViewNumber, n: number): ReplicaId[] {
  const tau = Math.min(1, TAU_NUMERATOR / n)
  const selected: ReplicaId[] = []
  for (let i = 0; i < n; i++) {
    const id = i as ReplicaId
    if (sortitionDraw(seed, view, id) < tau) selected.push(id)
  }
  return selected
}

// lower draw = higher priority = wins the tiebreak, mirroring real Algorand's lowest-hash rule.
function pickLeader(seed: number, view: ViewNumber, proposers: readonly ReplicaId[]): ReplicaId {
  if (proposers.length === 0) return -1 as ReplicaId
  let best     = proposers[0]
  let bestDraw = sortitionDraw(seed, view, best)
  for (const p of proposers.slice(1)) {
    const d = sortitionDraw(seed, view, p)
    if (d < bestDraw) { best = p; bestDraw = d }
  }
  return best
}

function getVS(step: AlgorandSimulationStep): AlgorandViewState {
  return step.viewStates[step.currentView]
}

function replaceVS(
  viewStates: readonly AlgorandViewState[],
  updated: AlgorandViewState,
): AlgorandViewState[] {
  return viewStates.map(vs => (vs.view as number) === (updated.view as number) ? updated : vs)
}

function mkPropose(
  from: ReplicaId, view: ViewNumber, block: Block, priority: number, step: number,
): AlgProposeMessage {
  return {
    id: `alg-PROPOSE-${view as number}-${from as number}-${step}`,
    type: 'ALG_PROPOSE', from, to: 'broadcast', view, sentAtStep: step, block, priority,
  }
}

function mkSoftVote(from: ReplicaId, view: ViewNumber, vote: Vote, step: number): AlgSoftVoteMessage {
  return {
    id: `alg-SOFT-${view as number}-${from as number}-${vote.blockHash}-${step}`,
    type: 'ALG_SOFT_VOTE', from, to: 'broadcast', view, sentAtStep: step, vote,
  }
}

function mkCertVote(from: ReplicaId, view: ViewNumber, vote: Vote, step: number): AlgCertVoteMessage {
  return {
    id: `alg-CERT-${view as number}-${from as number}-${vote.blockHash}-${step}`,
    type: 'ALG_CERT_VOTE', from, to: 'broadcast', view, sentAtStep: step, vote,
  }
}

function lastCommittedBlock(current: AlgorandSimulationStep): Block {
  if (current.committedBlocks.length === 0) return current.blockchain[0]
  const lastHash = current.committedBlocks[current.committedBlocks.length - 1]
  return current.blockchain.find(b => b.hash === lastHash)!
}

export function initAlgorandSimulation(config: SimConfig): AlgorandSimulationStep {
  const genesis = makeGenesisBlock()
  const view0   = 0 as ViewNumber
  const allIds  = Array.from({ length: config.n }, (_, i) => i as ReplicaId)
  const seed    = config.seed ?? 0

  const replicaStates: ReplicaState[] = allIds.map(id => ({
    id, currentView: view0, lockedQC: null, prepareQC: null,
    isByzantine: config.byzantineReplicas.some(b => (b.id as number) === (id as number)),
  }))

  const proposers0 = runSortition(seed, view0, config.n)
  const view0State: AlgorandViewState = {
    view: view0, leader: pickLeader(seed, view0, proposers0), proposers: proposers0,
    phase: 'PROPOSE', proposal: null, proposalPriority: null, softVotes: [], certVotes: [],
    triggeredCommitOf: null, viewStartStep: 0,
  }

  return {
    stepIndex: 0, currentView: 0,
    replicaStates, viewStates: [view0State],
    blockchain: [genesis], committedBlocks: [],
    pendingMessages: [], deliveredMessages: [], droppedMessages: [],
  }
}

export function advanceAlgorandStep(
  current: AlgorandSimulationStep, config: SimConfig,
): AlgorandSimulationStep {
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
      ] as AlgorandMessage[]

      if (config.dropRate > 0 && rng() < config.dropRate) {
        const afterDrop: AlgorandSimulationStep = {
          ...current,
          stepIndex:       next,
          pendingMessages: rest,
          droppedMessages: [...current.droppedMessages, msg],
        }
        // a dropped PROPOSE must still be able to close the propose window —
        // otherwise a round where every proposal gets dropped hangs forever,
        // since only deliverPropose would otherwise ever check this.
        return msg.type === 'ALG_PROPOSE' ? maybeCloseProposeWindow(afterDrop, next) : afterDrop
      }

      switch (msg.type) {
        case 'ALG_PROPOSE':   return deliverPropose(current, config, next, msg as AlgProposeMessage, rest)
        case 'ALG_SOFT_VOTE': return deliverSoftVote(current, config, next, msg as AlgSoftVoteMessage, rest)
        case 'ALG_CERT_VOTE': return deliverCertVote(current, config, next, msg as AlgCertVoteMessage, rest)
      }
    }
  }

  const vs = getVS(current)
  switch (vs.phase) {
    case 'PROPOSE':          return handlePropose(current, config, next)
    case 'SOFT_VOTE_VOTING': return handleVotingTimeout(current, config, next)
    case 'CERT_VOTE_VOTING': return handleVotingTimeout(current, config, next)
    case 'COMMITTED':        return doAdvanceToNextView(current, config, next)
    case 'ROUND_TIMED_OUT':  return doAdvanceToNextView(current, config, next)
  }
}

function handleVotingTimeout(
  current: AlgorandSimulationStep, config: SimConfig, next: number,
): AlgorandSimulationStep {
  const vs      = getVS(current)
  const elapsed = current.stepIndex - vs.viewStartStep
  if (elapsed < config.viewTimeout) {
    return { ...current, stepIndex: next }
  }
  return {
    ...current,
    stepIndex:  next,
    viewStates: replaceVS(current.viewStates, { ...vs, phase: 'ROUND_TIMED_OUT' }),
  }
}

function handlePropose(
  current: AlgorandSimulationStep, config: SimConfig, next: number,
): AlgorandSimulationStep {
  const vs = getVS(current)

  // sortition is frozen into vs.proposers at round-creation time (initAlgorandSimulation /
  // doAdvanceToNextView) — never recomputed here. This handler can be re-entered while
  // waiting on a DELAY-strategy proposer, so it must not re-roll who was selected.
  if (current.pendingMessages.some(m => m.type === 'ALG_PROPOSE')) {
    return { ...current, stepIndex: next }
  }

  if (vs.proposers.length === 0) {
    return {
      ...current, stepIndex: next,
      viewStates: replaceVS(current.viewStates, { ...vs, phase: 'ROUND_TIMED_OUT' }),
    }
  }

  const curView = current.currentView as ViewNumber
  const seed    = config.seed ?? 0
  const parent  = lastCommittedBlock(current)
  const messages: AlgorandMessage[] = []
  const newBlocks: Block[] = []

  for (const proposerId of vs.proposers) {
    const byz      = config.byzantineReplicas.find(b => (b.id as number) === (proposerId as number))
    const priority = sortitionDraw(seed, curView, proposerId)
    const rng      = stepRng(seed, next + (proposerId as number))

    if (!byz) {
      const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
      const block   = makeBlock(parent, curView, proposerId, payload)
      newBlocks.push(block)
      messages.push(mkPropose(proposerId, curView, block, priority, next))
      continue
    }

    switch (byz.strategy) {
      case 'WRONG_BLOCK': {
        const brokenBlock: Block = {
          hash:       `broken-v${current.currentView}-r${proposerId as number}-s${next}` as BlockHash,
          parentHash: 'deadbeef-broken-chain' as BlockHash,
          height:     parent.height + 1,
          view:       curView,
          proposer:   proposerId,
          payload:    'byzantine-wrong',
        }
        newBlocks.push(brokenBlock)
        messages.push(mkPropose(proposerId, curView, brokenBlock, priority, next))
        break
      }

      case 'EQUIVOCATE': {
        const half   = Math.floor(config.n / 2)
        const blockA = makeBlock(parent, curView, proposerId, `tx-v${current.currentView}-A-${Math.floor(rng() * 9000)}`)
        const blockB = makeBlock(parent, curView, proposerId, `tx-v${current.currentView}-B-${Math.floor(rng() * 9000)}`)
        newBlocks.push(blockA, blockB)
        for (let i = 0; i < config.n; i++) {
          if (i === (proposerId as number)) continue
          const block = i < half ? blockA : blockB
          const pp    = mkPropose(proposerId, curView, block, priority, next)
          messages.push({ ...pp, to: i as ReplicaId, id: `${pp.id}-to${i}` })
        }
        break
      }

      case 'DELAY': {
        const delay   = Math.floor(config.viewTimeout / 2)
        const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
        const block   = makeBlock(parent, curView, proposerId, payload)
        newBlocks.push(block)
        messages.push(mkPropose(proposerId, curView, block, priority, next + delay))
        break
      }

      default: break // SILENT, INVALID_QC — no message
    }
  }

  if (messages.length === 0) {
    return {
      ...current, stepIndex: next,
      viewStates: replaceVS(current.viewStates, { ...vs, phase: 'ROUND_TIMED_OUT' }),
    }
  }

  return {
    ...current,
    stepIndex:       next,
    blockchain:      [...current.blockchain, ...newBlocks],
    pendingMessages: messages,
  }
}

function deliverPropose(
  current: AlgorandSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     AlgProposeMessage,
  rest:    AlgorandMessage[],
): AlgorandSimulationStep {
  const vs = current.viewStates[msg.view as number]
  if (!vs) {
    return {
      ...current, stepIndex: next, pendingMessages: rest,
      deliveredMessages: [...current.deliveredMessages, msg],
    }
  }

  const parentExists = msg.block.parentHash === null || current.blockchain.some(b => b.hash === msg.block.parentHash)
  const currentBestPriority = vs.proposalPriority ?? Infinity
  const isBetter = parentExists && msg.priority < currentBestPriority
  const newProposal = isBetter ? msg.block : vs.proposal
  const newPriority = isBetter ? msg.priority : vs.proposalPriority

  const afterDeliver: AlgorandSimulationStep = {
    ...current,
    stepIndex:         next,
    viewStates:        replaceVS(current.viewStates, { ...vs, proposal: newProposal, proposalPriority: newPriority }),
    pendingMessages:   rest,
    deliveredMessages: [...current.deliveredMessages, msg],
  }
  return maybeCloseProposeWindow(afterDeliver, next)
}

function maybeCloseProposeWindow(current: AlgorandSimulationStep, next: number): AlgorandSimulationStep {
  const stillPending = current.pendingMessages.some(m => m.type === 'ALG_PROPOSE')
  if (stillPending) return current

  const vs = getVS(current)
  if (vs.proposal === null) {
    return {
      ...current,
      viewStates: replaceVS(current.viewStates, { ...vs, phase: 'ROUND_TIMED_OUT' }),
    }
  }

  const softVoteMsgs: AlgorandMessage[] = []
  for (const r of current.replicaStates) {
    if (r.isByzantine) continue
    softVoteMsgs.push(mkSoftVote(r.id, vs.view, makeVote(vs.view, vs.proposal.hash, r.id), next))
  }

  return {
    ...current,
    viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'SOFT_VOTE_VOTING' }),
    pendingMessages: [...current.pendingMessages, ...softVoteMsgs],
  }
}

function deliverSoftVote(
  current: AlgorandSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     AlgSoftVoteMessage,
  rest:    AlgorandMessage[],
): AlgorandSimulationStep {
  const q  = quorumSize(config.n)
  const vs = current.viewStates[msg.view as number]
  if (!vs) {
    return {
      ...current, stepIndex: next, pendingMessages: rest,
      deliveredMessages: [...current.deliveredMessages, msg],
    }
  }

  const newVotes = [...vs.softVotes, msg.vote]
  let updatedVS: AlgorandViewState = { ...vs, softVotes: newVotes }
  let pending = rest

  if (vs.phase === 'SOFT_VOTE_VOTING') {
    const qc = tryFormQC(newVotes, vs.view, q)
    if (qc !== null) {
      updatedVS = { ...updatedVS, phase: 'CERT_VOTE_VOTING' }
      const certMsgs: AlgorandMessage[] = []
      for (const r of current.replicaStates) {
        if (r.isByzantine) continue
        certMsgs.push(mkCertVote(r.id, updatedVS.view, makeVote(updatedVS.view, qc.blockHash, r.id), next))
      }
      pending = [...rest, ...certMsgs].filter(m => m.type !== 'ALG_SOFT_VOTE')
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

function deliverCertVote(
  current: AlgorandSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     AlgCertVoteMessage,
  rest:    AlgorandMessage[],
): AlgorandSimulationStep {
  const q  = quorumSize(config.n)
  const vs = current.viewStates[msg.view as number]
  if (!vs) {
    return {
      ...current, stepIndex: next, pendingMessages: rest,
      deliveredMessages: [...current.deliveredMessages, msg],
    }
  }

  const newVotes = [...vs.certVotes, msg.vote]
  let updatedVS: AlgorandViewState = { ...vs, certVotes: newVotes }
  let pending = rest
  let committedBlocks = current.committedBlocks

  if (vs.phase === 'CERT_VOTE_VOTING') {
    const qc = tryFormQC(newVotes, vs.view, q)
    if (qc !== null) {
      const alreadyDone = current.committedBlocks.includes(qc.blockHash)
      updatedVS = {
        ...updatedVS,
        phase: 'COMMITTED',
        triggeredCommitOf: alreadyDone ? vs.triggeredCommitOf : qc.blockHash,
      }
      if (!alreadyDone) {
        const ancestors = collectUncommittedAncestors(qc.blockHash, current.blockchain, current.committedBlocks)
        committedBlocks = [...committedBlocks, ...ancestors, qc.blockHash]
      }
      pending = rest.filter(m => m.type !== 'ALG_CERT_VOTE')
    }
  }

  return {
    ...current,
    stepIndex:         next,
    viewStates:        replaceVS(current.viewStates, updatedVS),
    committedBlocks,
    pendingMessages:   pending,
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function doAdvanceToNextView(
  current: AlgorandSimulationStep, config: SimConfig, nextStepIndex: number,
): AlgorandSimulationStep {
  const nextViewNum = (current.currentView + 1) as ViewNumber
  const seed        = config.seed ?? 0
  const proposers   = runSortition(seed, nextViewNum, config.n)

  const nextVS: AlgorandViewState = {
    view: nextViewNum, leader: pickLeader(seed, nextViewNum, proposers), proposers,
    phase: 'PROPOSE', proposal: null, proposalPriority: null, softVotes: [], certVotes: [],
    triggeredCommitOf: null, viewStartStep: nextStepIndex,
  }

  const replicaStates = current.replicaStates.map(r => ({ ...r, currentView: nextViewNum }))

  return {
    ...current,
    stepIndex:       nextStepIndex,
    currentView:     current.currentView + 1,
    replicaStates,
    viewStates:      [...current.viewStates, nextVS],
    pendingMessages: [],
  }
}
