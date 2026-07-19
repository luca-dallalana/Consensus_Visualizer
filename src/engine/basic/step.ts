import type {
  Block, BlockHash, QC, ReplicaId, ViewNumber,
  ReplicaState, Vote,
} from '../../types'
import type { SimConfig } from '../../types'
import type {
  BasicSimulationStep, BasicViewState,
  BasicMessage,
  BasicPrepareMessage, BasicPrepareVoteMessage,
  BasicPreCommitMessage, BasicPreCommitVoteMessage,
  BasicCommitMessage, BasicCommitVoteMessage,
  BasicDecideMessage, BasicNewViewMessage,
} from '../../types'
import { makeGenesisBlock, makeQC, makeBlock, makeVote } from '../shared/factory'
import { leaderForView, quorumSize, nextView, safeBlock } from '../shared/protocol'
import { collectUncommittedAncestors, tryFormQC } from '../shared/helpers'
import { stepRng } from '../shared/prng'

function getVS(step: BasicSimulationStep): BasicViewState {
  return step.viewStates[step.currentView]
}

function replaceVS(viewStates: readonly BasicViewState[], updated: BasicViewState): BasicViewState[] {
  return viewStates.map(vs => (vs.view as number) === (updated.view as number) ? updated : vs)
}

function mkPrepare(
  from: ReplicaId, view: ViewNumber, block: Block, highQC: QC, step: number,
  to: ReplicaId | 'broadcast' = 'broadcast',
): BasicPrepareMessage {
  const toStr = to === 'broadcast' ? 'bcast' : String(to as number)
  return {
    id: `bmsg-PREPARE-${view as number}-${from as number}-${toStr}-${step}`,
    type: 'BASIC_PREPARE', from, to, view, sentAtStep: step, block, highQC,
  }
}

function mkPrepareVote(from: ReplicaId, to: ReplicaId, vote: Vote, step: number): BasicPrepareVoteMessage {
  return {
    id: `bmsg-PV-${vote.view as number}-${from as number}-${vote.blockHash}-${step}`,
    type: 'BASIC_PREPARE_VOTE', from, to, view: vote.view, sentAtStep: step, vote,
  }
}

function mkPreCommit(from: ReplicaId, view: ViewNumber, prepareQC: QC, step: number): BasicPreCommitMessage {
  return {
    id: `bmsg-PC-${view as number}-${from as number}-${step}`,
    type: 'BASIC_PRE_COMMIT', from, to: 'broadcast', view, sentAtStep: step, prepareQC,
  }
}

function mkPreCommitVote(from: ReplicaId, to: ReplicaId, vote: Vote, step: number): BasicPreCommitVoteMessage {
  return {
    id: `bmsg-PCV-${vote.view as number}-${from as number}-${step}`,
    type: 'BASIC_PRE_COMMIT_VOTE', from, to, view: vote.view, sentAtStep: step, vote,
  }
}

function mkCommit(from: ReplicaId, view: ViewNumber, preCommitQC: QC, step: number): BasicCommitMessage {
  return {
    id: `bmsg-COMMIT-${view as number}-${from as number}-${step}`,
    type: 'BASIC_COMMIT', from, to: 'broadcast', view, sentAtStep: step, preCommitQC,
  }
}

function mkCommitVote(from: ReplicaId, to: ReplicaId, vote: Vote, step: number): BasicCommitVoteMessage {
  return {
    id: `bmsg-CV-${vote.view as number}-${from as number}-${step}`,
    type: 'BASIC_COMMIT_VOTE', from, to, view: vote.view, sentAtStep: step, vote,
  }
}

function mkDecide(from: ReplicaId, view: ViewNumber, commitQC: QC, step: number): BasicDecideMessage {
  return {
    id: `bmsg-DECIDE-${view as number}-${from as number}-${step}`,
    type: 'BASIC_DECIDE', from, to: 'broadcast', view, sentAtStep: step, commitQC,
  }
}

function mkNewView(
  from: ReplicaId, to: ReplicaId, view: ViewNumber, highQC: QC, step: number,
): BasicNewViewMessage {
  return {
    id: `bmsg-NV-${view as number}-${from as number}-${step}`,
    type: 'BASIC_NEW_VIEW', from, to, view, sentAtStep: step, highQC,
  }
}

export function initBasicSimulation(config: SimConfig): BasicSimulationStep {
  const genesis   = makeGenesisBlock()
  const allIds    = Array.from({ length: config.n }, (_, i) => i as ReplicaId)
  const genesisQC = makeQC((-1) as ViewNumber, genesis.hash, allIds)
  const view0     = 0 as ViewNumber

  const replicaStates: ReplicaState[] = allIds.map(id => ({
    id,
    currentView:  view0,
    lockedQC:     null,
    prepareQC:    genesisQC,
    isByzantine:  config.byzantineReplicas.some(b => (b.id as number) === (id as number)),
  }))

  const view0State: BasicViewState = {
    view:              view0,
    leader:            leaderForView(view0, config.n),
    phase:             'PREPARE',
    proposal:          null,
    highQC:            genesisQC,
    prepareQC:         null,
    preCommitQC:       null,
    commitQC:          null,
    prepareVotes:      [],
    preCommitVotes:    [],
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

export function advanceBasicStep(current: BasicSimulationStep, config: SimConfig): BasicSimulationStep {
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
      ] as BasicMessage[]

      if (config.dropRate > 0 && msg.type !== 'BASIC_NEW_VIEW' && msg.type !== 'BASIC_DECIDE' && rng() < config.dropRate) {
        return {
          ...current,
          stepIndex:       next,
          pendingMessages: rest,
          droppedMessages: [...current.droppedMessages, msg],
        }
      }

      switch (msg.type) {
        case 'BASIC_PREPARE':         return deliverPrepare(current, config, next, msg as BasicPrepareMessage, rest)
        case 'BASIC_PREPARE_VOTE':    return deliverPrepareVote(current, config, next, msg as BasicPrepareVoteMessage, rest)
        case 'BASIC_PRE_COMMIT':      return deliverPreCommit(current, config, next, msg as BasicPreCommitMessage, rest)
        case 'BASIC_PRE_COMMIT_VOTE': return deliverPreCommitVote(current, config, next, msg as BasicPreCommitVoteMessage, rest)
        case 'BASIC_COMMIT':          return deliverCommit(current, config, next, msg as BasicCommitMessage, rest)
        case 'BASIC_COMMIT_VOTE':     return deliverCommitVote(current, config, next, msg as BasicCommitVoteMessage, rest)
        case 'BASIC_DECIDE':          return deliverDecide(current, config, next, msg as BasicDecideMessage, rest)
        case 'BASIC_NEW_VIEW':        return deliverNewView(current, config, next, msg as BasicNewViewMessage, rest)
      }
    }
  }

  const vs = getVS(current)
  switch (vs.phase) {
    case 'PREPARE':           return handlePropose(current, config, next)
    case 'PREPARE_VOTING':    return handleTimeout(current, config, next)
    case 'PRE_COMMIT':        return handleSendPreCommit(current, config, next)
    case 'PRE_COMMIT_VOTING': return handleTimeout(current, config, next)
    case 'COMMIT':            return handleSendCommit(current, config, next)
    case 'COMMIT_VOTING':     return handleTimeout(current, config, next)
    case 'DECIDE':            return handleSendDecide(current, config, next)
    case 'DECIDE_COLLECTING': return handleTimeout(current, config, next)
    case 'TIMED_OUT':         return { ...current }
  }
}

function handlePropose(current: BasicSimulationStep, config: SimConfig, next: number): BasicSimulationStep {
  const vs       = getVS(current)
  const leaderId = vs.leader
  const byz      = config.byzantineReplicas.find(b => (b.id as number) === (leaderId as number))
  const curView  = current.currentView as ViewNumber
  const parent   = current.blockchain.find(b => b.hash === vs.highQC?.blockHash)
    ?? current.blockchain[current.blockchain.length - 1]

  if (!byz) {
    const rng     = stepRng(config.seed ?? 0, next)
    const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
    const block   = makeBlock(parent, curView, leaderId, payload)
    return {
      ...current,
      stepIndex:       next,
      blockchain:      [...current.blockchain, block],
      viewStates:      replaceVS(current.viewStates, { ...vs, proposal: block, phase: 'PREPARE_VOTING' }),
      pendingMessages: [mkPrepare(leaderId, curView, block, vs.highQC!, next)],
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
        pendingMessages: [mkPrepare(leaderId, curView, brokenBlock, vs.highQC!, next)],
      }
    }

    case 'INVALID_QC': {
      const rng     = stepRng(config.seed ?? 0, next)
      const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
      const block   = makeBlock(parent, curView, leaderId, payload)
      const emptyQC = makeQC(vs.highQC!.view, vs.highQC!.blockHash, [])
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, block],
        viewStates:      replaceVS(current.viewStates, { ...vs, proposal: block, phase: 'PREPARE_VOTING' }),
        pendingMessages: [mkPrepare(leaderId, curView, block, emptyQC, next)],
      }
    }

    case 'EQUIVOCATE': {
      const half   = Math.floor(config.n / 2)
      const rng    = stepRng(config.seed ?? 0, next)
      const blockA = makeBlock(parent, curView, leaderId, `tx-v${current.currentView}-A-${Math.floor(rng() * 9000)}`)
      const blockB = makeBlock(parent, curView, leaderId, `tx-v${current.currentView}-B-${Math.floor(rng() * 9000)}`)
      const msgs: BasicMessage[] = []
      for (let i = 0; i < config.n; i++) {
        if (i === (leaderId as number)) continue
        const tid   = i as ReplicaId
        const block = i < half ? blockA : blockB
        msgs.push(mkPrepare(leaderId, curView, block, vs.highQC!, next, tid))
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
        pendingMessages: [mkPrepare(leaderId, curView, block, vs.highQC!, next)],
      }
    }
  }
}

function handleSendPreCommit(current: BasicSimulationStep, _config: SimConfig, next: number): BasicSimulationStep {
  const vs  = getVS(current)
  const msg = mkPreCommit(vs.leader, current.currentView as ViewNumber, vs.prepareQC!, next)
  return {
    ...current,
    stepIndex:       next,
    viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'PRE_COMMIT_VOTING' }),
    pendingMessages: [msg],
  }
}

function handleSendCommit(current: BasicSimulationStep, _config: SimConfig, next: number): BasicSimulationStep {
  const vs  = getVS(current)
  const msg = mkCommit(vs.leader, current.currentView as ViewNumber, vs.preCommitQC!, next)
  return {
    ...current,
    stepIndex:       next,
    viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'COMMIT_VOTING' }),
    pendingMessages: [msg],
  }
}

function handleSendDecide(current: BasicSimulationStep, _config: SimConfig, next: number): BasicSimulationStep {
  const vs  = getVS(current)
  const msg = mkDecide(vs.leader, current.currentView as ViewNumber, vs.commitQC!, next)
  return {
    ...current,
    stepIndex:       next,
    viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'DECIDE_COLLECTING' }),
    pendingMessages: [msg],
  }
}

function handleTimeout(current: BasicSimulationStep, config: SimConfig, next: number): BasicSimulationStep {
  const vs      = getVS(current)
  const elapsed = current.stepIndex - vs.viewStartStep
  if (elapsed < config.viewTimeout) {
    return { ...current, stepIndex: next }
  }

  const curView    = current.currentView as ViewNumber
  const nextLeader = leaderForView(nextView(curView), config.n)

  const newViewMsgs: BasicMessage[] = []
  for (const r of current.replicaStates) {
    const byz = config.byzantineReplicas.find(b => (b.id as number) === (r.id as number))
    if (!r.isByzantine || !byz || byz.strategy !== 'SILENT') {
      const hqc = (r.prepareQC ?? vs.highQC)!
      newViewMsgs.push(mkNewView(r.id, nextLeader, curView, hqc, next))
    }
  }

  return {
    ...current,
    stepIndex:       next,
    viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'TIMED_OUT' }),
    pendingMessages: newViewMsgs,
  }
}

function deliverPrepare(
  current: BasicSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     BasicPrepareMessage,
  rest:    BasicMessage[],
): BasicSimulationStep {
  const { block, highQC } = msg
  const q        = quorumSize(config.n)
  const curView  = current.currentView as ViewNumber
  const leaderId = getVS(current).leader

  const targetIds: number[] =
    msg.to === 'broadcast'
      ? current.replicaStates.map(r => r.id as number)
      : [msg.to as number]

  const replicaStates = [...current.replicaStates]
  const honestMsgs:  BasicMessage[] = []
  const delayedMsgs: BasicMessage[] = []

  for (const rid of targetIds) {
    const r   = replicaStates[rid]
    const byz = config.byzantineReplicas.find(b => (b.id as number) === rid)

    if (!r.isByzantine || !byz) {
      const valid =
        highQC.signers.length >= q &&
        safeBlock(block, highQC, r.lockedQC, current.blockchain)
      if (valid) {
        const newPrepareQC =
          r.prepareQC === null || (highQC.view as number) > (r.prepareQC.view as number)
            ? highQC : r.prepareQC
        replicaStates[rid] = { ...r, prepareQC: newPrepareQC }
        honestMsgs.push(mkPrepareVote(r.id, leaderId, makeVote(curView, block.hash, r.id), next))
      }
    } else {
      switch (byz.strategy) {
        case 'SILENT': break
        case 'EQUIVOCATE': {
          const fakeHash = `fake-${rid}-${current.currentView}` as BlockHash
          honestMsgs.push(
            mkPrepareVote(r.id, leaderId, makeVote(curView, block.hash, r.id), next),
            mkPrepareVote(r.id, leaderId, makeVote(curView, fakeHash, r.id), next),
          )
          break
        }
        case 'DELAY': {
          const delay = Math.floor(config.viewTimeout / 2)
          delayedMsgs.push(mkPrepareVote(r.id, leaderId, makeVote(curView, block.hash, r.id), next + delay))
          break
        }
        default: break
      }
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

function deliverPrepareVote(
  current: BasicSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     BasicPrepareVoteMessage,
  rest:    BasicMessage[],
): BasicSimulationStep {
  const q        = quorumSize(config.n)
  const vs       = getVS(current)
  const newVotes = [...vs.prepareVotes, msg.vote]
  let updatedVS: BasicViewState = { ...vs, prepareVotes: newVotes }
  let pending = rest

  if (vs.prepareQC === null) {
    const qc = tryFormQC(newVotes, vs.view, q)
    if (qc !== null) {
      updatedVS = { ...updatedVS, prepareQC: qc, phase: 'PRE_COMMIT' }
      pending = rest.filter(m => m.type !== 'BASIC_PREPARE_VOTE')
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

function deliverPreCommit(
  current: BasicSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     BasicPreCommitMessage,
  rest:    BasicMessage[],
): BasicSimulationStep {
  const { prepareQC } = msg
  const curView  = current.currentView as ViewNumber
  const leaderId = getVS(current).leader

  const targetIds: number[] =
    msg.to === 'broadcast'
      ? current.replicaStates.map(r => r.id as number)
      : [msg.to as number]

  const replicaStates = [...current.replicaStates]
  const honestMsgs:  BasicMessage[] = []
  const delayedMsgs: BasicMessage[] = []

  for (const rid of targetIds) {
    const r   = replicaStates[rid]
    const byz = config.byzantineReplicas.find(b => (b.id as number) === rid)

    if (!r.isByzantine || !byz) {
      const newPrepareQC =
        r.prepareQC === null || (prepareQC.view as number) > (r.prepareQC.view as number)
          ? prepareQC : r.prepareQC
      replicaStates[rid] = { ...r, prepareQC: newPrepareQC }
      honestMsgs.push(mkPreCommitVote(r.id, leaderId, makeVote(curView, prepareQC.blockHash, r.id), next))
    } else {
      switch (byz.strategy) {
        case 'SILENT': break
        case 'EQUIVOCATE': {
          const fakeHash = `fake-${rid}-${current.currentView}-pc` as BlockHash
          honestMsgs.push(
            mkPreCommitVote(r.id, leaderId, makeVote(curView, prepareQC.blockHash, r.id), next),
            mkPreCommitVote(r.id, leaderId, makeVote(curView, fakeHash, r.id), next),
          )
          break
        }
        case 'DELAY': {
          const delay = Math.floor(config.viewTimeout / 2)
          delayedMsgs.push(mkPreCommitVote(r.id, leaderId, makeVote(curView, prepareQC.blockHash, r.id), next + delay))
          break
        }
        default: break
      }
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

function deliverPreCommitVote(
  current: BasicSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     BasicPreCommitVoteMessage,
  rest:    BasicMessage[],
): BasicSimulationStep {
  const q        = quorumSize(config.n)
  const vs       = getVS(current)
  const newVotes = [...vs.preCommitVotes, msg.vote]
  let updatedVS: BasicViewState = { ...vs, preCommitVotes: newVotes }
  let pending = rest

  if (vs.preCommitQC === null) {
    const qc = tryFormQC(newVotes, vs.view, q)
    if (qc !== null) {
      updatedVS = { ...updatedVS, preCommitQC: qc, phase: 'COMMIT' }
      pending = rest.filter(m => m.type !== 'BASIC_PRE_COMMIT_VOTE')
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

function deliverCommit(
  current: BasicSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     BasicCommitMessage,
  rest:    BasicMessage[],
): BasicSimulationStep {
  const { preCommitQC } = msg
  const curView  = current.currentView as ViewNumber
  const leaderId = getVS(current).leader

  const targetIds: number[] =
    msg.to === 'broadcast'
      ? current.replicaStates.map(r => r.id as number)
      : [msg.to as number]

  const replicaStates = [...current.replicaStates]
  const honestMsgs:  BasicMessage[] = []
  const delayedMsgs: BasicMessage[] = []

  for (const rid of targetIds) {
    const r   = replicaStates[rid]
    const byz = config.byzantineReplicas.find(b => (b.id as number) === rid)

    if (!r.isByzantine || !byz) {
      const newLockedQC =
        r.lockedQC === null || (preCommitQC.view as number) > (r.lockedQC.view as number)
          ? preCommitQC : r.lockedQC
      replicaStates[rid] = { ...r, lockedQC: newLockedQC }
      honestMsgs.push(mkCommitVote(r.id, leaderId, makeVote(curView, preCommitQC.blockHash, r.id), next))
    } else {
      switch (byz.strategy) {
        case 'SILENT': break
        case 'EQUIVOCATE': {
          const fakeHash = `fake-${rid}-${current.currentView}-cv` as BlockHash
          honestMsgs.push(
            mkCommitVote(r.id, leaderId, makeVote(curView, preCommitQC.blockHash, r.id), next),
            mkCommitVote(r.id, leaderId, makeVote(curView, fakeHash, r.id), next),
          )
          break
        }
        case 'DELAY': {
          const delay = Math.floor(config.viewTimeout / 2)
          delayedMsgs.push(mkCommitVote(r.id, leaderId, makeVote(curView, preCommitQC.blockHash, r.id), next + delay))
          break
        }
        default: break
      }
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

function deliverCommitVote(
  current: BasicSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     BasicCommitVoteMessage,
  rest:    BasicMessage[],
): BasicSimulationStep {
  const q        = quorumSize(config.n)
  const vs       = getVS(current)
  const newVotes = [...vs.commitVotes, msg.vote]
  let updatedVS: BasicViewState = { ...vs, commitVotes: newVotes }
  let pending = rest

  if (vs.commitQC === null) {
    const qc = tryFormQC(newVotes, vs.view, q)
    if (qc !== null) {
      updatedVS = { ...updatedVS, commitQC: qc, phase: 'DECIDE' }
      pending = rest.filter(m => m.type !== 'BASIC_COMMIT_VOTE')
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

function deliverDecide(
  current: BasicSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     BasicDecideMessage,
  rest:    BasicMessage[],
): BasicSimulationStep {
  const { commitQC } = msg
  const curView    = current.currentView as ViewNumber
  const nextLeader = leaderForView(nextView(curView), config.n)

  const targetIds: number[] =
    msg.to === 'broadcast'
      ? current.replicaStates.map(r => r.id as number)
      : [msg.to as number]

  const newViewMsgs: BasicMessage[] = []
  const newCommits: BlockHash[] = []

  for (const rid of targetIds) {
    const r   = current.replicaStates[rid]
    const byz = config.byzantineReplicas.find(b => (b.id as number) === rid)

    if (!r.isByzantine || !byz) {
      if (!current.committedBlocks.includes(commitQC.blockHash) && !newCommits.includes(commitQC.blockHash)) {
        const ancestors = collectUncommittedAncestors(commitQC.blockHash, current.blockchain, [...current.committedBlocks, ...newCommits])
        newCommits.push(...ancestors, commitQC.blockHash)
      }
      const hqc = (r.prepareQC ?? commitQC)
      newViewMsgs.push(mkNewView(r.id, nextLeader, curView, hqc, next))
    } else {
      switch (byz.strategy) {
        case 'SILENT': break
        default: {
          const hqc = (r.prepareQC ?? commitQC)
          newViewMsgs.push(mkNewView(r.id, nextLeader, curView, hqc, next))
        }
      }
    }
  }

  const vs        = getVS(current)
  const updatedVS = {
    ...vs,
    phase:             'DECIDE_COLLECTING' as const,
    triggeredCommitOf: newCommits.length > 0 ? newCommits[newCommits.length - 1] : vs.triggeredCommitOf,
  }

  return {
    ...current,
    stepIndex:         next,
    viewStates:        replaceVS(current.viewStates, updatedVS),
    committedBlocks:   [...current.committedBlocks, ...newCommits],
    pendingMessages:   [...rest, ...newViewMsgs],
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function deliverNewView(
  current: BasicSimulationStep,
  config:  SimConfig,
  next:    number,
  msg:     BasicNewViewMessage,
  rest:    BasicMessage[],
): BasicSimulationStep {
  const q            = quorumSize(config.n)
  const newDelivered = [...current.deliveredMessages, msg]

  const allNV = newDelivered.filter(
    m => m.type === 'BASIC_NEW_VIEW' && (m as BasicNewViewMessage).view as number === current.currentView,
  ) as BasicNewViewMessage[]

  if (allNV.length >= q) {
    const bestHighQC = allNV.reduce(
      (best, m) => (m.highQC.view as number) > (best.view as number) ? m.highQC : best,
      allNV[0].highQC,
    )
    return doAdvanceToNextView(
      { ...current, pendingMessages: rest, deliveredMessages: newDelivered },
      config, next, bestHighQC,
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
  current:       BasicSimulationStep,
  config:        SimConfig,
  nextStepIndex: number,
  bestHighQC:    QC,
): BasicSimulationStep {
  const nextViewNum = (current.currentView + 1) as ViewNumber
  const newLeader   = leaderForView(nextViewNum, config.n)

  const replicaStates: ReplicaState[] = current.replicaStates.map(r => {
    const newPrepareQC =
      r.prepareQC === null || (bestHighQC.view as number) > (r.prepareQC.view as number)
        ? bestHighQC : r.prepareQC
    return { ...r, currentView: nextViewNum, prepareQC: newPrepareQC }
  })

  const nextViewState: BasicViewState = {
    view:              nextViewNum,
    leader:            newLeader,
    phase:             'PREPARE',
    proposal:          null,
    highQC:            bestHighQC,
    prepareQC:         null,
    preCommitQC:       null,
    commitQC:          null,
    prepareVotes:      [],
    preCommitVotes:    [],
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
