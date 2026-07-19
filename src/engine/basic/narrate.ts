import type {
  AnySimulationStep, SimConfig,
  BasicMessage, BasicViewState,
  BasicPrepareMessage, BasicPreCommitMessage, BasicCommitMessage,
  BasicPrepareVoteMessage, BasicPreCommitVoteMessage, BasicCommitVoteMessage,
  BasicSimulationStep,
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
  const step    = current as BasicSimulationStep
  const curView = step.currentView
  const curVS   = step.viewStates[curView]
  const leader  = curVS ? (curVS.leader as number) : 0

  if (prev === null) {
    return `Simulation started — R${leader} is leader for view 0`
  }

  const prevStep = prev as BasicSimulationStep

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
    const lastMsg = step.deliveredMessages[currLen - 1] as BasicMessage
    const from    = lastMsg.from as number

    const newCommits   = step.committedBlocks.filter(h => !prevStep.committedBlocks.includes(h))
    const commitSuffix = newCommits.length > 0
      ? ` — block ${h6(newCommits[newCommits.length - 1])}… committed`
      : ''

    switch (lastMsg.type) {
      case 'BASIC_PREPARE': {
        const pm = lastMsg as BasicPrepareMessage
        return `R${from} (leader) broadcast PREPARE for block ${h6(pm.block.hash)}… to all replicas`
      }
      case 'BASIC_PREPARE_VOTE': {
        const vm = lastMsg as BasicPrepareVoteMessage
        if (currPhase === 'PRE_COMMIT') {
          return `R${from}'s PREPARE VOTE formed the quorum — prepareQC formed, advancing to PRE-COMMIT`
        }
        return `R${from} sent PREPARE VOTE for ${h6(vm.vote.blockHash)}… to leader R${lastMsg.to as number}`
      }
      case 'BASIC_PRE_COMMIT': {
        const pm = lastMsg as BasicPreCommitMessage
        return `R${from} (leader) broadcast PRE-COMMIT (prepareQC v${pm.prepareQC.view as number}) to all replicas`
      }
      case 'BASIC_PRE_COMMIT_VOTE': {
        const vm = lastMsg as BasicPreCommitVoteMessage
        if (currPhase === 'COMMIT') {
          return `R${from}'s PRE-COMMIT VOTE formed the quorum — preCommitQC formed, advancing to COMMIT`
        }
        return `R${from} sent PRE-COMMIT VOTE for ${h6(vm.vote.blockHash)}… to leader R${lastMsg.to as number}`
      }
      case 'BASIC_COMMIT': {
        const cm = lastMsg as BasicCommitMessage
        return `R${from} (leader) broadcast COMMIT — replicas update lockedQC to v${cm.preCommitQC.view as number}`
      }
      case 'BASIC_COMMIT_VOTE': {
        const vm = lastMsg as BasicCommitVoteMessage
        if (currPhase === 'DECIDE') {
          return `R${from}'s COMMIT VOTE formed the quorum — commitQC formed, advancing to DECIDE`
        }
        return `R${from} sent COMMIT VOTE for ${h6(vm.vote.blockHash)}… to leader R${lastMsg.to as number}`
      }
      case 'BASIC_DECIDE':
        return `R${from} (leader) broadcast DECIDE${commitSuffix || ' — all replicas commit the block'}`
      case 'BASIC_NEW_VIEW':
        return `R${from} sent NEW VIEW to R${lastMsg.to as number} (next leader)`
    }
  }

  if (prevPhase !== currPhase && currPhase !== undefined) {
    const proposal = curVS?.proposal

    switch (currPhase) {
      case 'TIMED_OUT': {
        const nextLeader = leaderForView(nextView(curView as ViewNumber), config.n)
        return `View ${curView} timed out — honest replicas sent NEW VIEW to next leader R${nextLeader as number}`
      }
      case 'PREPARE_VOTING': {
        const hash = proposal?.hash ?? ''
        return `R${leader} (leader) queued PREPARE broadcast for block ${h6(hash)}… (view ${curView})`
      }
      case 'PRE_COMMIT_VOTING': {
        const hash = curVS?.prepareQC?.blockHash ?? ''
        return `R${leader} (leader) queued PRE-COMMIT broadcast for block ${h6(hash)}…`
      }
      case 'COMMIT_VOTING': {
        const hash = (curVS as BasicViewState)?.preCommitQC?.blockHash ?? ''
        return `R${leader} (leader) queued COMMIT broadcast for block ${h6(hash)}…`
      }
      case 'DECIDE_COLLECTING': {
        const hash = (curVS as BasicViewState)?.commitQC?.blockHash ?? ''
        return `R${leader} (leader) queued DECIDE broadcast for block ${h6(hash)}…`
      }
      case 'PRE_COMMIT':
        return `Quorum of PREPARE votes — prepareQC formed, advancing to PRE-COMMIT`
      case 'COMMIT':
        return `Quorum of PRE-COMMIT votes — preCommitQC formed, advancing to COMMIT`
      case 'DECIDE':
        return `Quorum of COMMIT votes — commitQC formed, advancing to DECIDE`
    }
  }

  return ''
}

export function computeViewSummary(
  prevStep:    AnySimulationStep,
  currentStep: AnySimulationStep,
  _config:     SimConfig,
): ViewSummary {
  const prev    = prevStep as BasicSimulationStep
  const current = currentStep as BasicSimulationStep

  const completedView = prev.currentView
  const vs            = prev.viewStates[completedView]

  const timedOut  = (vs?.phase as string) === 'TIMED_OUT'
  const newCommit = vs?.triggeredCommitOf ?? current.viewStates[completedView]?.triggeredCommitOf ?? null

  const bvs = vs as BasicViewState
  const qc  = bvs?.commitQC ?? bvs?.preCommitQC ?? bvs?.prepareQC

  const participating = (qc?.signers ?? [])
    .map(s => s as number)
    .sort((a, b) => a - b)

  const qcBlock = qc?.blockHash ?? null

  const messageCount = (current.deliveredMessages as readonly BasicMessage[])
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
