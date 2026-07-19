import type {
  Block, BlockHash, QC, ReplicaId, ViewNumber,
  ReplicaState, ViewState, Vote, Message,
  ProposalMessage, VoteMessage, NewViewMessage,
  SimulationStep,
} from '../../types'
import type { SimConfig } from '../../types'
import {
  makeGenesisBlock, makeQC, makeBlock, makeVote,
  makeProposalMessage, makeVoteMessage, makeNewViewMessage,
} from '../shared/factory'
import { leaderForView, quorumSize, nextView, safeBlock } from '../shared/protocol'
import { collectUncommittedAncestors, tryFormQC } from '../shared/helpers'
import { stepRng } from '../shared/prng'

function getVS(step: SimulationStep): ViewState {
  return step.viewStates[step.currentView]
}

function replaceVS(viewStates: readonly ViewState[], updated: ViewState): ViewState[] {
  return viewStates.map(vs =>
    (vs.view as number) === (updated.view as number) ? updated : vs,
  )
}

function computeLockedQC(
  current: QC | null,
  viewStates: readonly ViewState[],
  highQC: QC,
): QC | null {
  const prevViewNum = (highQC.view as number) - 1
  if (prevViewNum < 0) return current
  const prevVS = viewStates[prevViewNum]
  if (!prevVS?.qc || (prevVS.qc.view as number) !== prevViewNum) return current
  const candidate = prevVS.qc
  if (current === null || (candidate.view as number) > (current.view as number)) return candidate
  return current
}

function detectNewCommits(
  viewStates: readonly ViewState[],
  blockchain: readonly Block[],
  alreadyCommitted: readonly BlockHash[],
): BlockHash[] {
  const newly: BlockHash[] = []
  for (let i = 2; i < viewStates.length; i++) {
    const qcI  = viewStates[i]?.qc
    const qcI1 = viewStates[i - 1]?.qc
    const qcI2 = viewStates[i - 2]?.qc
    if (!qcI || !qcI1 || !qcI2) continue
    if ((qcI.view as number)  !== (qcI1.view as number) + 1) continue
    if ((qcI1.view as number) !== (qcI2.view as number) + 1) continue
    const bI  = blockchain.find(b => b.hash === qcI.blockHash)
    const bI1 = blockchain.find(b => b.hash === qcI1.blockHash)
    const bI2 = blockchain.find(b => b.hash === qcI2.blockHash)
    if (!bI || !bI1 || !bI2) continue
    if (bI.parentHash !== bI1.hash || bI1.parentHash !== bI2.hash) continue
    if (!alreadyCommitted.includes(bI2.hash) && !newly.includes(bI2.hash)) {
      const ancestors = collectUncommittedAncestors(bI2.hash, blockchain, [...alreadyCommitted, ...newly])
      newly.push(...ancestors, bI2.hash)
    }
  }
  return newly
}

export function initSimulation(config: SimConfig): SimulationStep {
  const genesis   = makeGenesisBlock()
  const view0     = 0 as ViewNumber
  const allIds    = Array.from({ length: config.n }, (_, i) => i as ReplicaId)
  const genesisQC = makeQC((-1) as ViewNumber, genesis.hash, allIds)

  const replicaStates: ReplicaState[] = allIds.map(id => ({
    id,
    currentView: view0,
    lockedQC:    null,
    prepareQC:   genesisQC,
    isByzantine: config.byzantineReplicas.some(b => (b.id as number) === (id as number)),
  }))

  const view0State: ViewState = {
    view:              view0,
    leader:            leaderForView(view0, config.n),
    phase:             'PROPOSING',
    proposal:          null,
    highQC:            genesisQC,
    votes:             [],
    qc:                null,
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

export function advanceStep(current: SimulationStep, config: SimConfig): SimulationStep {
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
      ]

      if (config.dropRate > 0 && msg.type !== 'NEW_VIEW' && rng() < config.dropRate) {
        return {
          ...current,
          stepIndex:       next,
          pendingMessages: rest,
          droppedMessages: [...current.droppedMessages, msg],
        }
      }

      switch (msg.type) {
        case 'PROPOSAL': return deliverProposal(current, config, next, msg as ProposalMessage, rest)
        case 'VOTE':     return deliverVote(current, config, next, msg as VoteMessage, rest)
        case 'NEW_VIEW': return deliverNewView(current, config, next, msg as NewViewMessage, rest)
      }
    }
  }

  const vs = getVS(current)
  switch (vs.phase) {
    case 'PROPOSING':  return handleProposing(current, config, next)
    case 'VOTING':     return handleVotingTimeout(current, config, next)
    case 'QC_FORMED':  return doAdvanceToNextView(current, config, next, vs.qc!)
    case 'TIMED_OUT':  return { ...current }
  }
}

function handleProposing(current: SimulationStep, config: SimConfig, next: number): SimulationStep {
  const vs        = getVS(current)
  const leaderId  = vs.leader
  const byz       = config.byzantineReplicas.find(b => (b.id as number) === (leaderId as number))
  const curView   = current.currentView as ViewNumber
  const bestBlock = current.blockchain.find(b => b.hash === vs.highQC?.blockHash)
    ?? current.blockchain[current.blockchain.length - 1]

  if (!byz) {
    const rng     = stepRng(config.seed ?? 0, next)
    const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
    const block   = makeBlock(bestBlock, curView, leaderId, payload)
    return {
      ...current,
      stepIndex:       next,
      blockchain:      [...current.blockchain, block],
      viewStates:      replaceVS(current.viewStates, { ...vs, proposal: block, phase: 'VOTING' }),
      pendingMessages: [makeProposalMessage(leaderId, curView, block, vs.highQC!, next, 'broadcast')],
    }
  }

  switch (byz.strategy) {
    case 'SILENT':
      return handleVotingTimeout(current, config, next)

    case 'WRONG_BLOCK': {
      const brokenBlock: Block = {
        hash:       `broken-v${current.currentView}-s${next}` as BlockHash,
        parentHash: 'deadbeef-broken-chain' as BlockHash,
        height:     bestBlock.height + 1,
        view:       curView,
        proposer:   leaderId,
        payload:    'byzantine-wrong',
      }
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, brokenBlock],
        viewStates:      replaceVS(current.viewStates, { ...vs, proposal: brokenBlock, phase: 'VOTING' }),
        pendingMessages: [makeProposalMessage(leaderId, curView, brokenBlock, vs.highQC!, next, 'broadcast')],
      }
    }

    case 'INVALID_QC': {
      const rng     = stepRng(config.seed ?? 0, next)
      const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
      const block   = makeBlock(bestBlock, curView, leaderId, payload)
      const emptyQC = makeQC(vs.highQC!.view, vs.highQC!.blockHash, [])
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, block],
        viewStates:      replaceVS(current.viewStates, { ...vs, proposal: block, phase: 'VOTING' }),
        pendingMessages: [makeProposalMessage(leaderId, curView, block, emptyQC, next, 'broadcast')],
      }
    }

    case 'EQUIVOCATE': {
      const half   = Math.floor(config.n / 2)
      const rng    = stepRng(config.seed ?? 0, next)
      const blockA = makeBlock(bestBlock, curView, leaderId, `tx-v${current.currentView}-A-${Math.floor(rng() * 9000)}`)
      const blockB = makeBlock(bestBlock, curView, leaderId, `tx-v${current.currentView}-B-${Math.floor(rng() * 9000)}`)
      const messages: Message[] = []
      for (let i = 0; i < config.n; i++) {
        if (i === (leaderId as number)) continue
        const tid   = i as ReplicaId
        const block = i < half ? blockA : blockB
        messages.push(makeProposalMessage(leaderId, curView, block, vs.highQC!, next, tid))
      }
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, blockA, blockB],
        viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'VOTING' }),
        pendingMessages: messages,
      }
    }

    case 'DELAY': {
      const elapsed = current.stepIndex - vs.viewStartStep
      if (elapsed < Math.floor(config.viewTimeout / 2)) {
        return { ...current, stepIndex: next }
      }
      const rng     = stepRng(config.seed ?? 0, next)
      const payload = `tx-v${current.currentView}-${Math.floor(rng() * 9000) + 1000}`
      const block   = makeBlock(bestBlock, curView, leaderId, payload)
      return {
        ...current,
        stepIndex:       next,
        blockchain:      [...current.blockchain, block],
        viewStates:      replaceVS(current.viewStates, { ...vs, proposal: block, phase: 'VOTING' }),
        pendingMessages: [makeProposalMessage(leaderId, curView, block, vs.highQC!, next, 'broadcast')],
      }
    }
  }
}

function deliverProposal(
  current: SimulationStep,
  config: SimConfig,
  next: number,
  msg: ProposalMessage,
  restPending: Message[],
): SimulationStep {
  const { block, highQC } = msg
  const q          = quorumSize(config.n)
  const curView    = current.currentView as ViewNumber
  const nextLeader = leaderForView(nextView(curView), config.n)

  const replicaStates = [...current.replicaStates]
  const honestMsgs:  Message[] = []
  const delayedMsgs: Message[] = []

  const targetIds: number[] =
    msg.to === 'broadcast'
      ? replicaStates.map(r => r.id as number)
      : [msg.to as number]

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
        const newLockedQC = computeLockedQC(r.lockedQC, current.viewStates, highQC)
        replicaStates[rid] = { ...r, prepareQC: newPrepareQC, lockedQC: newLockedQC }
        const vote = makeVote(curView, block.hash, r.id)
        honestMsgs.push(makeVoteMessage(r.id, nextLeader, vote, next))
      }
    } else {
      switch (byz.strategy) {
        case 'SILENT': break
        case 'EQUIVOCATE': {
          const fakeHash = `fake-${rid}-${current.currentView}` as BlockHash
          honestMsgs.push(
            makeVoteMessage(r.id, nextLeader, makeVote(curView, block.hash, r.id), next),
            makeVoteMessage(r.id, nextLeader, makeVote(curView, fakeHash, r.id), next),
          )
          break
        }
        case 'DELAY': {
          const delay = Math.floor(config.viewTimeout / 2)
          delayedMsgs.push(makeVoteMessage(r.id, nextLeader, makeVote(curView, block.hash, r.id), next + delay))
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
    pendingMessages:   [...restPending, ...honestMsgs, ...delayedMsgs],
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function deliverVote(
  current: SimulationStep,
  config: SimConfig,
  next: number,
  msg: VoteMessage,
  restPending: Message[],
): SimulationStep {
  const q           = quorumSize(config.n)
  const voteViewNum = msg.vote.view as number
  let viewStates    = current.viewStates
  let replicaStates = current.replicaStates

  const vs = viewStates[voteViewNum]
  if (!vs) {
    return {
      ...current,
      stepIndex:         next,
      pendingMessages:   restPending,
      deliveredMessages: [...current.deliveredMessages, msg],
    }
  }

  const newVotes  = [...vs.votes, msg.vote]
  let updatedVS: ViewState = { ...vs, votes: newVotes }
  let pending = restPending

  if (vs.qc === null) {
    const newQC = tryFormQC(newVotes, msg.vote.view, q)
    if (newQC !== null) {
      updatedVS = { ...updatedVS, qc: newQC, phase: 'QC_FORMED' }

      const nextLeaderId = leaderForView(nextView(msg.vote.view), config.n)
      replicaStates = replicaStates.map(r =>
        (r.id as number) === (nextLeaderId as number) &&
        (r.prepareQC === null || (newQC.view as number) > (r.prepareQC.view as number))
          ? { ...r, prepareQC: newQC }
          : r,
      )

      pending = restPending.filter(
        m => !(m.type === 'VOTE' && ((m as VoteMessage).vote.view as number) === voteViewNum),
      )
    }
  }

  viewStates = replaceVS(viewStates, updatedVS)

  return {
    ...current,
    stepIndex:         next,
    replicaStates,
    viewStates,
    pendingMessages:   pending,
    deliveredMessages: [...current.deliveredMessages, msg],
  }
}

function deliverNewView(
  current: SimulationStep,
  config: SimConfig,
  next: number,
  msg: NewViewMessage,
  restPending: Message[],
): SimulationStep {
  const q            = quorumSize(config.n)
  const newDelivered = [...current.deliveredMessages, msg]

  const nvCount = newDelivered.filter(
    m => m.type === 'NEW_VIEW' && (m as NewViewMessage).view as number === current.currentView,
  ).length

  if (nvCount >= q) {
    const allNV = newDelivered.filter(
      m => m.type === 'NEW_VIEW' && (m as NewViewMessage).view as number === current.currentView,
    ) as NewViewMessage[]
    const bestHighQC = allNV.reduce(
      (best, m) => (m.highQC.view as number) > (best.view as number) ? m.highQC : best,
      allNV[0].highQC,
    )
    return doAdvanceToNextView(
      { ...current, pendingMessages: restPending, deliveredMessages: newDelivered },
      config, next, bestHighQC,
    )
  }

  return {
    ...current,
    stepIndex:         next,
    pendingMessages:   restPending,
    deliveredMessages: newDelivered,
  }
}

function handleVotingTimeout(current: SimulationStep, config: SimConfig, next: number): SimulationStep {
  const vs      = getVS(current)
  const elapsed = current.stepIndex - vs.viewStartStep
  if (elapsed < config.viewTimeout) {
    return { ...current, stepIndex: next }
  }

  const curView    = current.currentView as ViewNumber
  const nextLeader = leaderForView(nextView(curView), config.n)

  const newViewMsgs: Message[] = []
  for (const r of current.replicaStates) {
    const byz = config.byzantineReplicas.find(b => (b.id as number) === (r.id as number))
    if (!r.isByzantine || !byz || byz.strategy !== 'SILENT') {
      const hqc = (r.prepareQC ?? vs.highQC)!
      newViewMsgs.push(makeNewViewMessage(r.id, nextLeader, curView, hqc, next))
    }
  }

  return {
    ...current,
    stepIndex:       next,
    viewStates:      replaceVS(current.viewStates, { ...vs, phase: 'TIMED_OUT' }),
    pendingMessages: newViewMsgs,
  }
}

function doAdvanceToNextView(
  current: SimulationStep,
  config: SimConfig,
  nextStepIndex: number,
  bestHighQC: QC,
): SimulationStep {
  const nextViewNum = (current.currentView + 1) as ViewNumber
  const newLeader   = leaderForView(nextViewNum, config.n)

  const replicaStates: ReplicaState[] = current.replicaStates.map(r => {
    const newPrepareQC =
      r.prepareQC === null || (bestHighQC.view as number) > (r.prepareQC.view as number)
        ? bestHighQC : r.prepareQC
    const newLockedQC = computeLockedQC(r.lockedQC, current.viewStates, bestHighQC)
    return { ...r, currentView: nextViewNum, prepareQC: newPrepareQC, lockedQC: newLockedQC }
  })

  const newCommits = detectNewCommits(current.viewStates, current.blockchain, current.committedBlocks)

  let viewStates = current.viewStates
  if (newCommits.length > 0) {
    const currentVS = viewStates[current.currentView]
    viewStates = replaceVS(viewStates, {
      ...currentVS,
      triggeredCommitOf: newCommits[newCommits.length - 1],
    })
  }

  const nextViewState: ViewState = {
    view:              nextViewNum,
    leader:            newLeader,
    phase:             'PROPOSING',
    proposal:          null,
    highQC:            bestHighQC,
    votes:             [],
    qc:                null,
    triggeredCommitOf: null,
    viewStartStep:     nextStepIndex,
  }

  return {
    ...current,
    stepIndex:       nextStepIndex,
    currentView:     current.currentView + 1,
    replicaStates,
    viewStates:      [...viewStates, nextViewState],
    committedBlocks: [...current.committedBlocks, ...newCommits],
    pendingMessages: [],
  }
}
