import type {
  Block, BlockHash, QC, ReplicaId, ViewNumber,
  ReplicaState, Vote,
} from '../../types'
import type { SimConfig } from '../../types'
import type {
  PbftSimulationStep, PbftViewState, PbftMessage,
  PbftPrePrepareMessage, PbftPrepareMessage,
  PbftCommitMessage, PbftViewChangeMessage,
} from '../../types'
import { makeGenesisBlock, makeBlock, makeVote, makeQC } from '../shared/factory'
import { leaderForView, quorumSize, nextView } from '../shared/protocol'
import { tryFormQC } from '../shared/helpers'
import { stepRng } from '../shared/prng'

function getVS(step: PbftSimulationStep): PbftViewState {
  return step.viewStates[step.currentView]
}

function replaceVS(viewStates: readonly PbftViewState[], updated: PbftViewState): PbftViewState[] {
  return viewStates.map(vs => (vs.view as number) === (updated.view as number) ? updated : vs)
}

function mkPrePrepare(
  from: ReplicaId, view: ViewNumber, block: Block, step: number,
): PbftPrePrepareMessage {
  return {
    id: `pbft-PP-${view as number}-${from as number}-${step}`,
    type: 'PBFT_PRE_PREPARE', from, to: 'broadcast', view, sentAtStep: step, block,
  }
}

function mkPrepare(
  from: ReplicaId, view: ViewNumber, vote: Vote, step: number,
): PbftPrepareMessage {
  return {
    id: `pbft-P-${view as number}-${from as number}-${vote.blockHash}-${step}`,
    type: 'PBFT_PREPARE', from, to: 'broadcast', view, sentAtStep: step, vote,
  }
}

function mkCommit(
  from: ReplicaId, view: ViewNumber, vote: Vote, step: number,
): PbftCommitMessage {
  return {
    id: `pbft-C-${view as number}-${from as number}-${vote.blockHash}-${step}`,
    type: 'PBFT_COMMIT', from, to: 'broadcast', view, sentAtStep: step, vote,
  }
}

function mkViewChange(
  from: ReplicaId, to: ReplicaId, view: ViewNumber, step: number,
): PbftViewChangeMessage {
  return {
    id: `pbft-VC-${view as number}-${from as number}-${step}`,
    type: 'PBFT_VIEW_CHANGE', from, to, view, sentAtStep: step,
  }
}

export function initPbftSimulation(config: SimConfig): PbftSimulationStep {
  const genesis   = makeGenesisBlock()
  const allIds    = Array.from({ length: config.n }, (_, i) => i as ReplicaId)
  const view0     = 0 as ViewNumber

  const replicaStates: ReplicaState[] = allIds.map(id => ({
    id,
    currentView:  view0,
    lockedQC:     null,
    prepareQC:    makeQC((-1) as ViewNumber, genesis.hash, allIds),
    isByzantine:  config.byzantineReplicas.some(b => (b.id as number) === (id as number)),
  }))

  const view0State: PbftViewState = {
    view:              view0,
    leader:            leaderForView(view0, config.n),
    phase:             'PRE_PREPARE',
    proposal:          null,
    prepareVotes:      [],
    commitVotes:       [],
    triggeredCommitOf: null,
    viewStartStep:     0,
  }

  return {
    stepIndex:         0,
    currentView:       0,
    replicaStates,
    viewStates:        [view0State],
    blockchain:        [genesis],
    committedBlocks:   [],
    pendingMessages:   [],
    deliveredMessages: [],
    droppedMessages:   [],
  }
}

export function advancePbftStep(current: PbftSimulationStep, config: SimConfig): PbftSimulationStep {
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
      ] as PbftMessage[]

      if (config.dropRate > 0 && msg.type !== 'PBFT_VIEW_CHANGE' && rng() < config.dropRate) {
        return {
          ...current,
          stepIndex:       next,
          pendingMessages: rest,
          droppedMessages: [...current.droppedMessages, msg],
        }
      }

      switch (msg.type) {
        case 'PBFT_PRE_PREPARE': return deliverPrePrepare(current, config, next, msg as PbftPrePrepareMessage, rest)
        case 'PBFT_PREPARE':     return deliverPrepare(current, config, next, msg as PbftPrepareMessage, rest)
        case 'PBFT_COMMIT':      return deliverCommit(current, config, next, msg as PbftCommitMessage, rest)
        case 'PBFT_VIEW_CHANGE': return deliverViewChange(current, config, next, msg as PbftViewChangeMessage, rest)
      }
    }
  }

  const vs = getVS(current)
  switch (vs.phase) {
    case 'PRE_PREPARE':    return handlePropose(current, config, next)
    case 'PREPARE_VOTING': return handleTimeout(current, config, next)
    case 'COMMIT_VOTING':  return handleTimeout(current, config, next)
    case 'COMMITTED':      return doAdvanceToNextView(current, config, next)
    case 'TIMED_OUT':      return { ...current }
  }
}

function handlePropose(current: PbftSimulationStep, config: SimConfig, next: number): PbftSimulationStep {
  const vs       = getVS(current)
  const leaderId = vs.leader
  const byz      = config.byzantineReplicas.find(b => (b.id as number) === (leaderId as number))
  const curView  = current.currentView as ViewNumber
  const parent   = current.blockchain[current.blockchain.length - 1]

  if (!byz) {
    const rng     = stepRng(config.seed ?? 0, next)
    const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
    const block   = makeBlock(parent, curView, leaderId, payload)
    return {
      ...current,
      stepIndex:       next,
      blockchain:      [...current.blockchain, block],
      viewStates:      replaceVS(current.viewStates, { ...vs, proposal: block, phase: 'PREPARE_VOTING' }),
      pendingMessages: [mkPrePrepare(leaderId, curView, block, next)],
    }
  }

  switch (byz.strategy) {
    case 'SILENT':
      return handleTimeout(current, config, next)

    case 'WRONG_BLOCK': {
      const brokenBlock: Block = {
        hash:       `broken-v${current.currentView}-s${next}` as BlockHash,
        parentHash: 'deadbeef-broken-chain' as BlockHash,
        height:     parent.height + 1,
        view:       curView,
        proposer:   leaderId,
        payload:    'byzantine-wrong',
      }
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, brokenBlock],
        viewStates:      replaceVS(current.viewStates, { ...vs, proposal: brokenBlock, phase: 'PREPARE_VOTING' }),
        pendingMessages: [mkPrePrepare(leaderId, curView, brokenBlock, next)],
      }
    }

    case 'EQUIVOCATE': {
      const half   = Math.floor(config.n / 2)
      const rng    = stepRng(config.seed ?? 0, next)
      const blockA = makeBlock(parent, curView, leaderId, `tx-v${current.currentView}-A-${Math.floor(rng() * 9000)}`)
      const blockB = makeBlock(parent, curView, leaderId, `tx-v${current.currentView}-B-${Math.floor(rng() * 9000)}`)
      const msgs: PbftMessage[] = []
      for (let i = 0; i < config.n; i++) {
        if (i === (leaderId as number)) continue
        const block = i < half ? blockA : blockB
        const pp    = mkPrePrepare(leaderId, curView, block, next)
        msgs.push({ ...pp, to: i as ReplicaId, id: `${pp.id}-to${i}` })
      }
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, blockA, blockB],
        viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'PREPARE_VOTING' }),
        pendingMessages: msgs,
      }
    }

    case 'DELAY': {
      const elapsed = current.stepIndex - vs.viewStartStep
      if (elapsed < Math.floor(config.viewTimeout / 2)) {
        return { ...current, stepIndex: next }
      }
      const rng     = stepRng(config.seed ?? 0, next)
      const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
      const block   = makeBlock(parent, curView, leaderId, payload)
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, block],
        viewStates:      replaceVS(current.viewStates, { ...vs, proposal: block, phase: 'PREPARE_VOTING' }),
        pendingMessages: [mkPrePrepare(leaderId, curView, block, next)],
      }
    }

    case 'INVALID_QC':
      return handleTimeout(current, config, next)
  }
}

function handleTimeout(current: PbftSimulationStep, config: SimConfig, next: number): PbftSimulationStep {
  const vs      = getVS(current)
  const elapsed = current.stepIndex - vs.viewStartStep
  if (elapsed < config.viewTimeout) {
    return { ...current, stepIndex: next }
  }

  const curView    = current.currentView as ViewNumber
  const nextLeader = leaderForView(nextView(curView), config.n)

  const viewChangeMsgs: PbftMessage[] = []
  for (const r of current.replicaStates) {
    const byz = config.byzantineReplicas.find(b => (b.id as number) === (r.id as number))
    if (!r.isByzantine || !byz || byz.strategy !== 'SILENT') {
      viewChangeMsgs.push(mkViewChange(r.id, nextLeader, curView, next))
    }
  }

  return {
    ...current,
    stepIndex:       next,
    viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'TIMED_OUT' }),
    pendingMessages: viewChangeMsgs,
  }
}

function deliverPrePrepare(
  current: PbftSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     PbftPrePrepareMessage,
  rest:    PbftMessage[],
): PbftSimulationStep {
  const { block } = msg
  const curView   = current.currentView as ViewNumber
  const q         = quorumSize(config.n)

  const prepareMsgs: PbftMessage[] = []
  const delayedMsgs: PbftMessage[] = []

  const targetIds: number[] =
    msg.to === 'broadcast'
      ? current.replicaStates.map(r => r.id as number)
      : [msg.to as number]

  for (const r of current.replicaStates) {
    if (!targetIds.includes(r.id as number)) continue
    const byz = config.byzantineReplicas.find(b => (b.id as number) === (r.id as number))

    if (!r.isByzantine || !byz) {
      const parentExists = block.parentHash === null || current.blockchain.some(b => b.hash === block.parentHash)
      if (parentExists) {
        prepareMsgs.push(mkPrepare(r.id, curView, makeVote(curView, block.hash, r.id), next))
      }
    } else {
      switch (byz.strategy) {
        case 'SILENT': break
        case 'EQUIVOCATE': {
          const fakeHash = `fake-${r.id as number}-${current.currentView}` as BlockHash
          prepareMsgs.push(
            mkPrepare(r.id, curView, makeVote(curView, block.hash, r.id), next),
            mkPrepare(r.id, curView, makeVote(curView, fakeHash, r.id), next),
          )
          break
        }
        case 'DELAY': {
          const delay = Math.floor(config.viewTimeout / 2)
          delayedMsgs.push(mkPrepare(r.id, curView, makeVote(curView, block.hash, r.id), next + delay))
          break
        }
        default: break
      }
    }
  }

  return {
    ...current,
    stepIndex:         next,
    pendingMessages:   [...rest, ...prepareMsgs, ...delayedMsgs],
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function deliverPrepare(
  current: PbftSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     PbftPrepareMessage,
  rest:    PbftMessage[],
): PbftSimulationStep {
  const q           = quorumSize(config.n)
  const vs          = getVS(current)
  const newVotes    = [...vs.prepareVotes, msg.vote]
  let updatedVS     = { ...vs, prepareVotes: newVotes }
  let pending       = rest
  let newDelivered  = [...current.deliveredMessages, msg]

  const qc = tryFormQC(newVotes, vs.view, q)
  if (qc !== null && vs.phase === 'PREPARE_VOTING') {
    updatedVS = { ...updatedVS, phase: 'COMMIT_VOTING' }

    const commitMsgs: PbftMessage[] = []
    for (const r of current.replicaStates) {
      const byz = config.byzantineReplicas.find(b => (b.id as number) === (r.id as number))
      if (!r.isByzantine || !byz) {
        commitMsgs.push(mkCommit(r.id, vs.view, makeVote(vs.view, qc.blockHash, r.id), next))
      }
    }

    pending = [...rest, ...commitMsgs]
    pending = pending.filter(m => m.type !== 'PBFT_PREPARE')
  }

  return {
    ...current,
    stepIndex:         next,
    viewStates:        replaceVS(current.viewStates, updatedVS),
    pendingMessages:   pending,
    deliveredMessages: newDelivered,
  }
}

function deliverCommit(
  current: PbftSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     PbftCommitMessage,
  rest:    PbftMessage[],
): PbftSimulationStep {
  const q        = quorumSize(config.n)
  const vs       = getVS(current)
  const newVotes = [...vs.commitVotes, msg.vote]
  let updatedVS  = { ...vs, commitVotes: newVotes }
  let pending    = rest

  const qc = tryFormQC(newVotes, vs.view, q)
  if (qc !== null && vs.phase === 'COMMIT_VOTING') {
    const committedHash = qc.blockHash
    const alreadyDone   = current.committedBlocks.includes(committedHash)

    updatedVS = {
      ...updatedVS,
      phase:             'COMMITTED',
      triggeredCommitOf: alreadyDone ? vs.triggeredCommitOf : committedHash,
    }
    pending = rest.filter(m => m.type !== 'PBFT_COMMIT')

    if (!alreadyDone) {
      return {
        ...current,
        stepIndex:         next,
        viewStates:        replaceVS(current.viewStates, updatedVS),
        committedBlocks:   [...current.committedBlocks, committedHash],
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

function deliverViewChange(
  current: PbftSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     PbftViewChangeMessage,
  rest:    PbftMessage[],
): PbftSimulationStep {
  const q            = quorumSize(config.n)
  const newDelivered = [...current.deliveredMessages, msg]

  const vcCount = newDelivered.filter(
    m => m.type === 'PBFT_VIEW_CHANGE' && (m as PbftViewChangeMessage).view as number === current.currentView,
  ).length

  if (vcCount >= q) {
    return doAdvanceToNextView(
      { ...current, pendingMessages: rest, deliveredMessages: newDelivered },
      config, next,
    )
  }

  return {
    ...current,
    stepIndex:         next,
    pendingMessages:   rest,
    deliveredMessages: newDelivered,
  }
}

function doAdvanceToNextView(
  current:       PbftSimulationStep,
  config:        SimConfig,
  nextStepIndex: number,
): PbftSimulationStep {
  const nextViewNum = (current.currentView + 1) as ViewNumber
  const newLeader   = leaderForView(nextViewNum, config.n)

  const replicaStates: ReplicaState[] = current.replicaStates.map(r => ({
    ...r,
    currentView: nextViewNum,
  }))

  const nextViewState: PbftViewState = {
    view:              nextViewNum,
    leader:            newLeader,
    phase:             'PRE_PREPARE',
    proposal:          null,
    prepareVotes:      [],
    commitVotes:       [],
    triggeredCommitOf: null,
    viewStartStep:     nextStepIndex,
  }

  return {
    ...current,
    stepIndex:       nextStepIndex,
    currentView:     current.currentView + 1,
    replicaStates,
    viewStates:      [...current.viewStates, nextViewState],
    pendingMessages: [],
  }
}
