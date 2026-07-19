import type {
  AnySimulationStep, SimConfig,
  PbftSimulationStep, PbftMessage, PbftViewState,
  PbftPrePrepareMessage, PbftPrepareMessage, PbftCommitMessage,
  ViewNumber, ViewSummary,
} from '../../types'
import { leaderForView, nextView } from '../shared/protocol'

function h6(hash: string): string {
  return hash.slice(0, 6)
}

export function narrateStep(
  prev: AnySimulationStep | null,
  current: AnySimulationStep,
  config: SimConfig,
): string {
  const step    = current as PbftSimulationStep
  const curView = step.currentView
  const curVS   = step.viewStates[curView]
  const leader  = curVS ? (curVS.leader as number) : 0

  if (prev === null) {
    return `Simulation started — R${leader} is primary for view 0`
  }

  const prevStep = prev as PbftSimulationStep

  if (curView > prevStep.currentView) {
    const prevView  = prevStep.currentView
    const newLeader = curVS ? (curVS.leader as number) : leader
    let msg = `View ${prevView} complete — R${newLeader} is primary for view ${curView}`
    const newCommits = step.committedBlocks.filter(h => !prevStep.committedBlocks.includes(h))
    if (newCommits.length > 0) {
      msg += ` · block ${h6(newCommits[newCommits.length - 1])}… committed`
    }
    return msg
  }

  const prevVS    = prevStep.viewStates[curView]
  const currPhase = curVS?.phase
  const prevPhase = prevVS?.phase

  const prevLen = prevStep.deliveredMessages.length
  const currLen = step.deliveredMessages.length
  if (currLen > prevLen) {
    const lastMsg = step.deliveredMessages[currLen - 1] as PbftMessage
    const from    = lastMsg.from as number

    const newCommits   = step.committedBlocks.filter(h => !prevStep.committedBlocks.includes(h))
    const commitSuffix = newCommits.length > 0
      ? ` — block ${h6(newCommits[newCommits.length - 1])}… committed`
      : ''

    switch (lastMsg.type) {
      case 'PBFT_PRE_PREPARE': {
        const pm = lastMsg as PbftPrePrepareMessage
        return `R${from} (primary) broadcast PRE-PREPARE for block ${h6(pm.block.hash)}… to all replicas`
      }
      case 'PBFT_PREPARE': {
        const pm = lastMsg as PbftPrepareMessage
        if (currPhase === 'COMMIT_VOTING') {
          return `R${from}'s PREPARE formed the quorum — 2f+1 PREPARE votes, advancing to COMMIT phase`
        }
        return `R${from} broadcast PREPARE vote for ${h6(pm.vote.blockHash)}…`
      }
      case 'PBFT_COMMIT': {
        const cm = lastMsg as PbftCommitMessage
        if (currPhase === 'COMMITTED') {
          return `R${from}'s COMMIT formed the quorum — 2f+1 COMMIT votes${commitSuffix}`
        }
        return `R${from} broadcast COMMIT vote for ${h6(cm.vote.blockHash)}…`
      }
      case 'PBFT_VIEW_CHANGE':
        return `R${from} sent VIEW-CHANGE to next primary R${lastMsg.to as number}`
    }
  }

  if (prevPhase !== currPhase && currPhase !== undefined) {
    switch (currPhase) {
      case 'PREPARE_VOTING': {
        const hash = curVS?.proposal?.hash ?? ''
        return `R${leader} (primary) queued PRE-PREPARE for block ${h6(hash)}…`
      }
      case 'COMMIT_VOTING':
        return `2f+1 PREPARE votes — advancing to COMMIT phase`
      case 'COMMITTED':
        return `2f+1 COMMIT votes — block committed`
      case 'TIMED_OUT': {
        const nextLeader = leaderForView(nextView(curView as ViewNumber), config.n)
        return `View ${curView} timed out — honest replicas sent VIEW-CHANGE to next primary R${nextLeader as number}`
      }
    }
  }

  return ''
}

export function computeViewSummary(
  prevStep:    AnySimulationStep,
  currentStep: AnySimulationStep,
  _config:     SimConfig,
): ViewSummary {
  const prev    = prevStep as PbftSimulationStep
  const current = currentStep as PbftSimulationStep

  const completedView = prev.currentView
  const vs            = prev.viewStates[completedView]

  const timedOut  = (vs?.phase as string) === 'TIMED_OUT'
  const newCommit = vs?.triggeredCommitOf ?? current.viewStates[completedView]?.triggeredCommitOf ?? null

  const qc = vs?.commitVotes ?? []
  const participating = qc
    .map(v => v.voterId as number)
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .sort((a, b) => a - b)

  const qcBlock = vs?.triggeredCommitOf ?? null

  const messageCount = (current.deliveredMessages as readonly PbftMessage[])
    .filter(m => (m.view as number) === completedView)
    .length

  return {
    view:         completedView,
    leader:       vs ? (vs.leader as number) : -1,
    timedOut,
    qcBlock,
    committed:    newCommit ?? null,
    participating,
    messageCount,
  }
}
