import type {
  AnySimulationStep, SimConfig,
  Message, ViewState, SimulationStep,
  ProposalMessage, VoteMessage, NewViewMessage,
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
  const step    = current as SimulationStep
  const curView = step.currentView
  const curVS   = step.viewStates[curView]
  const leader  = curVS ? (curVS.leader as number) : 0

  if (prev === null) {
    return `Simulation started — R${leader} is leader for view 0`
  }

  const prevStep = prev as SimulationStep

  if (curView > prevStep.currentView) {
    const prevView  = prevStep.currentView
    const newLeader = curVS ? (curVS.leader as number) : leader
    let msg = `View ${prevView} complete — R${newLeader} starts view ${curView}`
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
    const lastMsg = step.deliveredMessages[currLen - 1] as Message
    const from    = lastMsg.from as number

    const newCommits   = step.committedBlocks.filter(h => !prevStep.committedBlocks.includes(h))
    const commitSuffix = newCommits.length > 0
      ? ` — block ${h6(newCommits[newCommits.length - 1])}… committed`
      : ''

    switch (lastMsg.type) {
      case 'PROPOSAL': {
        const pm = lastMsg as ProposalMessage
        return `R${from} (leader) broadcast PROPOSAL for block ${h6(pm.block.hash)}… to all replicas`
      }
      case 'VOTE': {
        const vm = lastMsg as VoteMessage
        if (currPhase === 'QC_FORMED') {
          return `R${from}'s VOTE formed the quorum — QC formed for view ${vm.vote.view as number}`
        }
        return `R${from} sent VOTE for ${h6(vm.vote.blockHash)}… to R${lastMsg.to as number} (next leader)`
      }
      case 'NEW_VIEW':
        return `R${from} sent NEW VIEW to R${lastMsg.to as number}`
    }

    return commitSuffix ? commitSuffix.slice(3) : ''
  }

  if (prevPhase !== currPhase && currPhase !== undefined) {
    const proposal = curVS?.proposal

    switch (currPhase) {
      case 'VOTING': {
        const hash = proposal?.hash ?? ''
        return `R${leader} (leader) prepared PROPOSAL for block ${h6(hash)}…`
      }
      case 'TIMED_OUT': {
        const nextLeader = leaderForView(nextView(curView as ViewNumber), config.n)
        return `View ${curView} timed out — honest replicas sent NEW VIEW to next leader R${nextLeader as number}`
      }
      case 'QC_FORMED':
        return `Quorum of votes — QC formed for view ${curView}`
    }
  }

  return ''
}

export function computeViewSummary(
  prevStep:    AnySimulationStep,
  currentStep: AnySimulationStep,
  _config:     SimConfig,
): ViewSummary {
  const prev    = prevStep as SimulationStep
  const current = currentStep as SimulationStep

  const completedView = prev.currentView
  const vs            = prev.viewStates[completedView]

  const timedOut  = (vs?.phase as string) === 'TIMED_OUT'
  const newCommit = vs?.triggeredCommitOf ?? current.viewStates[completedView]?.triggeredCommitOf ?? null

  const participating = (vs?.qc?.signers ?? [])
    .map(s => s as number)
    .sort((a, b) => a - b)

  const qcBlock = vs?.qc?.blockHash ?? null

  const messageCount = (current.deliveredMessages as readonly Message[])
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
