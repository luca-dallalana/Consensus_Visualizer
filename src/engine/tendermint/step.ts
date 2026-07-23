import type {
  Block, BlockHash, ReplicaId, ViewNumber, Vote,
} from '../../types'
import type { SimConfig } from '../../types'
import type {
  TendermintSimulationStep, TendermintViewState, TendermintReplicaState,
  TendermintMessage, TmProposeMessage, TmPrevoteMessage, TmPrecommitMessage,
} from '../../types'
import { NIL_VALUE } from '../../types'
import { makeGenesisBlock, makeBlock, makeVote } from '../shared/factory'
import { leaderForView, quorumSize } from '../shared/protocol'
import { tryFormQC, collectUncommittedAncestors } from '../shared/helpers'
import { stepRng } from '../shared/prng'

function getVS(step: TendermintSimulationStep): TendermintViewState {
  return step.viewStates[step.currentView]
}

function replaceVS(
  viewStates: readonly TendermintViewState[],
  updated: TendermintViewState,
): TendermintViewState[] {
  return viewStates.map(vs => (vs.view as number) === (updated.view as number) ? updated : vs)
}

// PREVOTE safety predicate: lockedRound/proposalValidRound are ROUND numbers
// within the current height, never the flat view index — mixing these up
// silently breaks the cross-round locking guarantee this engine exists to model.
function isLockOk(
  proposalHash:       BlockHash,
  proposalValidRound: number | null,
  lockedValue:        BlockHash | null,
  lockedRound:        number | null,
): boolean {
  if (lockedRound === null) return true
  if (lockedValue === proposalHash) return true
  return proposalValidRound !== null && proposalValidRound >= lockedRound
}

function tryFormPolka(votes: readonly Vote[], view: ViewNumber, q: number) {
  const qc = tryFormQC(votes, view, q)
  if (qc === null || qc.blockHash === NIL_VALUE) return null
  return qc
}

function tallyNil(votes: readonly Vote[]): number {
  return votes.filter(v => v.blockHash === NIL_VALUE).length
}

function mkPropose(
  from: ReplicaId, view: ViewNumber, height: number, round: number,
  block: Block, validRound: number | null, step: number,
): TmProposeMessage {
  return {
    id: `tm-PROPOSE-${view as number}-${from as number}-${step}`,
    type: 'TM_PROPOSE', from, to: 'broadcast', view, sentAtStep: step,
    block, height, round, validRound,
  }
}

function mkPrevote(
  from: ReplicaId, view: ViewNumber, height: number, round: number, vote: Vote, step: number,
): TmPrevoteMessage {
  return {
    id: `tm-PREVOTE-${view as number}-${from as number}-${vote.blockHash}-${step}`,
    type: 'TM_PREVOTE', from, to: 'broadcast', view, sentAtStep: step, vote, height, round,
  }
}

function mkPrecommit(
  from: ReplicaId, view: ViewNumber, height: number, round: number, vote: Vote, step: number,
): TmPrecommitMessage {
  return {
    id: `tm-PRECOMMIT-${view as number}-${from as number}-${vote.blockHash}-${step}`,
    type: 'TM_PRECOMMIT', from, to: 'broadcast', view, sentAtStep: step, vote, height, round,
  }
}

function lastCommittedBlock(current: TendermintSimulationStep): Block {
  if (current.committedBlocks.length === 0) return current.blockchain[0]
  const lastHash = current.committedBlocks[current.committedBlocks.length - 1]
  return current.blockchain.find(b => b.hash === lastHash)!
}

export function initTendermintSimulation(config: SimConfig): TendermintSimulationStep {
  const genesis = makeGenesisBlock()
  const view0   = 0 as ViewNumber
  const allIds  = Array.from({ length: config.n }, (_, i) => i as ReplicaId)

  const replicaStates: TendermintReplicaState[] = allIds.map(id => ({
    id,
    currentView: view0,
    isByzantine: config.byzantineReplicas.some(b => (b.id as number) === (id as number)),
    lockedValue: null, lockedRound: null,
    validValue:  null, validRound:  null,
  }))

  const view0State: TendermintViewState = {
    view: view0, height: 0, round: 0,
    leader: leaderForView(view0, config.n),
    phase: 'PROPOSE', proposal: null, proposalValidRound: null,
    prevotes: [], precommits: [], triggeredCommitOf: null, viewStartStep: 0,
  }

  return {
    stepIndex: 0, currentView: 0,
    replicaStates, viewStates: [view0State],
    blockchain: [genesis], committedBlocks: [],
    pendingMessages: [], deliveredMessages: [], droppedMessages: [],
  }
}

export function advanceTendermintStep(
  current: TendermintSimulationStep, config: SimConfig,
): TendermintSimulationStep {
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
      ] as TendermintMessage[]

      if (config.dropRate > 0 && rng() < config.dropRate) {
        return {
          ...current,
          stepIndex:       next,
          pendingMessages: rest,
          droppedMessages: [...current.droppedMessages, msg],
        }
      }

      switch (msg.type) {
        case 'TM_PROPOSE':   return deliverPropose(current, config, next, msg as TmProposeMessage, rest)
        case 'TM_PREVOTE':   return deliverPrevote(current, config, next, msg as TmPrevoteMessage, rest)
        case 'TM_PRECOMMIT': return deliverPrecommit(current, config, next, msg as TmPrecommitMessage, rest)
      }
    }
  }

  const vs = getVS(current)
  switch (vs.phase) {
    case 'PROPOSE':          return handlePropose(current, config, next)
    case 'PREVOTE_VOTING':   return handleVotingTimeout(current, config, next)
    case 'PRECOMMIT_VOTING': return handleVotingTimeout(current, config, next)
    case 'COMMITTED':        return doAdvanceToNextHeight(current, config, next)
    case 'ROUND_TIMED_OUT':  return doAdvanceToNextRound(current, config, next)
  }
}

function handleVotingTimeout(
  current: TendermintSimulationStep, config: SimConfig, next: number,
): TendermintSimulationStep {
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
  current: TendermintSimulationStep, config: SimConfig, next: number,
): TendermintSimulationStep {
  const vs          = getVS(current)
  const proposerId  = vs.leader
  const byz         = config.byzantineReplicas.find(b => (b.id as number) === (proposerId as number))
  const curView     = current.currentView as ViewNumber
  const proposerRS  = current.replicaStates.find(r => (r.id as number) === (proposerId as number))!

  if (!byz) {
    if (proposerRS.validValue !== null) {
      const block = current.blockchain.find(b => b.hash === proposerRS.validValue)!
      return {
        ...current,
        stepIndex:       next,
        viewStates:      replaceVS(current.viewStates, { ...vs, proposal: block, proposalValidRound: proposerRS.validRound, phase: 'PREVOTE_VOTING' }),
        pendingMessages: [mkPropose(proposerId, curView, vs.height, vs.round, block, proposerRS.validRound, next)],
      }
    }
    const rng     = stepRng(config.seed ?? 0, next)
    const payload = `tx-h${vs.height}-r${vs.round}-${Math.floor(rng() * 9000) + 1000}`
    const block   = makeBlock(lastCommittedBlock(current), curView, proposerId, payload)
    return {
      ...current,
      stepIndex:       next,
      blockchain:      [...current.blockchain, block],
      viewStates:      replaceVS(current.viewStates, { ...vs, proposal: block, proposalValidRound: null, phase: 'PREVOTE_VOTING' }),
      pendingMessages: [mkPropose(proposerId, curView, vs.height, vs.round, block, null, next)],
    }
  }

  switch (byz.strategy) {
    case 'SILENT':
      return handleVotingTimeout(current, config, next)

    case 'INVALID_QC':
      return handleVotingTimeout(current, config, next)

    case 'WRONG_BLOCK': {
      const parent = lastCommittedBlock(current)
      const brokenBlock: Block = {
        hash:       `broken-h${vs.height}-r${vs.round}-s${next}` as BlockHash,
        parentHash: 'deadbeef-broken-chain' as BlockHash,
        height:     parent.height + 1,
        view:       curView,
        proposer:   proposerId,
        payload:    'byzantine-wrong',
      }
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, brokenBlock],
        viewStates:      replaceVS(current.viewStates, { ...vs, proposal: brokenBlock, proposalValidRound: null, phase: 'PREVOTE_VOTING' }),
        pendingMessages: [mkPropose(proposerId, curView, vs.height, vs.round, brokenBlock, null, next)],
      }
    }

    case 'EQUIVOCATE': {
      const parent = lastCommittedBlock(current)
      const half   = Math.floor(config.n / 2)
      const rng    = stepRng(config.seed ?? 0, next)
      const blockA = makeBlock(parent, curView, proposerId, `tx-h${vs.height}-A-${Math.floor(rng() * 9000)}`)
      const blockB = makeBlock(parent, curView, proposerId, `tx-h${vs.height}-B-${Math.floor(rng() * 9000)}`)
      const messages: TendermintMessage[] = []
      for (let i = 0; i < config.n; i++) {
        if (i === (proposerId as number)) continue
        const block = i < half ? blockA : blockB
        const pp    = mkPropose(proposerId, curView, vs.height, vs.round, block, null, next)
        messages.push({ ...pp, to: i as ReplicaId, id: `${pp.id}-to${i}` })
      }
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, blockA, blockB],
        viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'PREVOTE_VOTING' }),
        pendingMessages: messages,
      }
    }

    case 'DELAY': {
      const elapsed = current.stepIndex - vs.viewStartStep
      if (elapsed < Math.floor(config.viewTimeout / 2)) {
        return { ...current, stepIndex: next }
      }
      const rng     = stepRng(config.seed ?? 0, next)
      const payload = `tx-h${vs.height}-r${vs.round}-${Math.floor(rng() * 9000) + 1000}`
      const block   = makeBlock(lastCommittedBlock(current), curView, proposerId, payload)
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, block],
        viewStates:      replaceVS(current.viewStates, { ...vs, proposal: block, proposalValidRound: null, phase: 'PREVOTE_VOTING' }),
        pendingMessages: [mkPropose(proposerId, curView, vs.height, vs.round, block, null, next)],
      }
    }
  }
}

function deliverPropose(
  current: TendermintSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     TmProposeMessage,
  rest:    TendermintMessage[],
): TendermintSimulationStep {
  const { block, validRound } = msg
  const vs = current.viewStates[msg.view as number]

  const targetIds: number[] =
    msg.to === 'broadcast'
      ? current.replicaStates.map(r => r.id as number)
      : [msg.to as number]

  const prevoteMsgs:  TendermintMessage[] = []
  const delayedMsgs:  TendermintMessage[] = []

  for (const rid of targetIds) {
    const r   = current.replicaStates[rid]
    const byz = config.byzantineReplicas.find(b => (b.id as number) === rid)

    if (!r.isByzantine || !byz) {
      const parentExists = block.parentHash === null || current.blockchain.some(b => b.hash === block.parentHash)
      const lockOk        = isLockOk(block.hash, validRound, r.lockedValue, r.lockedRound)
      const voteHash       = parentExists && lockOk ? block.hash : NIL_VALUE
      prevoteMsgs.push(mkPrevote(r.id, msg.view, vs.height, vs.round, makeVote(msg.view, voteHash, r.id), next))
    } else {
      switch (byz.strategy) {
        case 'EQUIVOCATE': {
          const fakeHash = `fake-${rid}-${current.currentView}` as BlockHash
          prevoteMsgs.push(
            mkPrevote(r.id, msg.view, vs.height, vs.round, makeVote(msg.view, block.hash, r.id), next),
            mkPrevote(r.id, msg.view, vs.height, vs.round, makeVote(msg.view, fakeHash,  r.id), next),
          )
          break
        }
        case 'DELAY': {
          const delay = Math.floor(config.viewTimeout / 2)
          delayedMsgs.push(mkPrevote(r.id, msg.view, vs.height, vs.round, makeVote(msg.view, block.hash, r.id), next + delay))
          break
        }
        default: break // SILENT, WRONG_BLOCK, INVALID_QC — no prevote sent
      }
    }
  }

  return {
    ...current,
    stepIndex:         next,
    viewStates:        replaceVS(current.viewStates, { ...vs, proposal: block, proposalValidRound: validRound }),
    pendingMessages:   [...rest, ...prevoteMsgs, ...delayedMsgs],
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function deliverPrevote(
  current: TendermintSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     TmPrevoteMessage,
  rest:    TendermintMessage[],
): TendermintSimulationStep {
  const q  = quorumSize(config.n)
  const vs = current.viewStates[msg.view as number]
  if (!vs) {
    return {
      ...current, stepIndex: next, pendingMessages: rest,
      deliveredMessages: [...current.deliveredMessages, msg],
    }
  }

  const newPrevotes = [...vs.prevotes, msg.vote]
  let updatedVS: TendermintViewState = { ...vs, prevotes: newPrevotes }
  let replicaStates = current.replicaStates
  let pending = rest

  if (vs.phase === 'PREVOTE_VOTING') {
    const polka = tryFormPolka(newPrevotes, vs.view, q)
    if (polka !== null) {
      replicaStates = replicaStates.map(r =>
        r.isByzantine ? r : {
          ...r,
          validValue: polka.blockHash, validRound: vs.round,
          lockedValue: polka.blockHash, lockedRound: vs.round,
        },
      )
      updatedVS = { ...updatedVS, phase: 'PRECOMMIT_VOTING' }
      const precommitMsgs: TendermintMessage[] = []
      for (const r of current.replicaStates) {
        if (r.isByzantine) continue
        precommitMsgs.push(mkPrecommit(r.id, updatedVS.view, vs.height, vs.round, makeVote(updatedVS.view, polka.blockHash, r.id), next))
      }
      pending = [...rest, ...precommitMsgs].filter(m => m.type !== 'TM_PREVOTE')
    } else {
      const nilCount = tallyNil(newPrevotes)
      if (nilCount >= q) {
        updatedVS = { ...updatedVS, phase: 'PRECOMMIT_VOTING' }
        const precommitMsgs: TendermintMessage[] = []
        for (const r of current.replicaStates) {
          if (r.isByzantine) continue
          precommitMsgs.push(mkPrecommit(r.id, updatedVS.view, vs.height, vs.round, makeVote(updatedVS.view, NIL_VALUE, r.id), next))
        }
        pending = [...rest, ...precommitMsgs].filter(m => m.type !== 'TM_PREVOTE')
      }
    }
  }

  return {
    ...current,
    stepIndex:         next,
    replicaStates,
    viewStates:        replaceVS(current.viewStates, updatedVS),
    pendingMessages:   pending,
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function deliverPrecommit(
  current: TendermintSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     TmPrecommitMessage,
  rest:    TendermintMessage[],
): TendermintSimulationStep {
  const q  = quorumSize(config.n)
  const vs = current.viewStates[msg.view as number]
  if (!vs) {
    return {
      ...current, stepIndex: next, pendingMessages: rest,
      deliveredMessages: [...current.deliveredMessages, msg],
    }
  }

  const newPrecommits = [...vs.precommits, msg.vote]
  let updatedVS: TendermintViewState = { ...vs, precommits: newPrecommits }
  let pending = rest
  let committedBlocks = current.committedBlocks

  if (vs.phase === 'PRECOMMIT_VOTING') {
    const polka = tryFormPolka(newPrecommits, vs.view, q)
    if (polka !== null) {
      const alreadyDone = current.committedBlocks.includes(polka.blockHash)
      updatedVS = {
        ...updatedVS,
        phase: 'COMMITTED',
        triggeredCommitOf: alreadyDone ? vs.triggeredCommitOf : polka.blockHash,
      }
      if (!alreadyDone) {
        const ancestors = collectUncommittedAncestors(polka.blockHash, current.blockchain, current.committedBlocks)
        committedBlocks = [...committedBlocks, ...ancestors, polka.blockHash]
      }
      pending = rest.filter(m => m.type !== 'TM_PRECOMMIT')
    } else {
      const nilCount = tallyNil(newPrecommits)
      if (nilCount >= q) {
        updatedVS = { ...updatedVS, phase: 'ROUND_TIMED_OUT' }
        pending = rest.filter(m => m.type !== 'TM_PRECOMMIT')
      }
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

function doAdvanceToNextRound(
  current: TendermintSimulationStep, config: SimConfig, nextStepIndex: number,
): TendermintSimulationStep {
  const vs          = getVS(current)
  const nextViewNum = (current.currentView + 1) as ViewNumber
  const proposer    = leaderForView(nextViewNum, config.n)

  const nextVS: TendermintViewState = {
    view: nextViewNum, height: vs.height, round: vs.round + 1, leader: proposer,
    phase: 'PROPOSE', proposal: null, proposalValidRound: null,
    prevotes: [], precommits: [], triggeredCommitOf: null, viewStartStep: nextStepIndex,
  }

  // lockedValue/lockedRound/validValue/validRound carried forward unchanged —
  // this is the entire point of the feature, do not reset on round-change.
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

function doAdvanceToNextHeight(
  current: TendermintSimulationStep, config: SimConfig, nextStepIndex: number,
): TendermintSimulationStep {
  const vs          = getVS(current)
  const nextViewNum = (current.currentView + 1) as ViewNumber
  const proposer    = leaderForView(nextViewNum, config.n)

  const nextVS: TendermintViewState = {
    view: nextViewNum, height: vs.height + 1, round: 0, leader: proposer,
    phase: 'PROPOSE', proposal: null, proposalValidRound: null,
    prevotes: [], precommits: [], triggeredCommitOf: null, viewStartStep: nextStepIndex,
  }

  const replicaStates = current.replicaStates.map(r => ({
    ...r,
    currentView: nextViewNum,
    lockedValue: null, lockedRound: null, validValue: null, validRound: null,
  }))

  return {
    ...current,
    stepIndex:       nextStepIndex,
    currentView:     current.currentView + 1,
    replicaStates,
    viewStates:      [...current.viewStates, nextVS],
    pendingMessages: [],
  }
}
