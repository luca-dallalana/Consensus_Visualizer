import type {
  AnySimulationStep, SimConfig,
  TendermintSimulationStep, TendermintMessage,
  TmProposeMessage, TmPrevoteMessage, TmPrecommitMessage,
  ViewNumber, ViewSummary,
} from '../../types'
import { NIL_VALUE } from '../../types'
import { leaderForView } from '../shared/protocol'

function h6(hash: string): string {
  return hash.slice(0, 6)
}

export function narrateStep(
  prev: AnySimulationStep | null,
  current: AnySimulationStep,
  config: SimConfig,
): string {
  const step    = current as TendermintSimulationStep
  const curView = step.currentView
  const curVS   = step.viewStates[curView]
  const proposer = curVS ? (curVS.leader as number) : 0

  if (prev === null) {
    return `Simulation started — R${proposer} is proposer for height 0, round 0`
  }

  const prevStep = prev as TendermintSimulationStep

  if (curView > prevStep.currentView) {
    const prevVS       = prevStep.viewStates[prevStep.currentView]
    const newProposer  = curVS ? (curVS.leader as number) : proposer

    if (curVS.height > prevVS.height) {
      const newCommits    = step.committedBlocks.filter(h => !prevStep.committedBlocks.includes(h))
      const committedHash = newCommits.length > 0
        ? h6(newCommits[newCommits.length - 1])
        : h6(prevVS.triggeredCommitOf ?? '')
      return `Height ${prevVS.height} committed block ${committedHash}… — advancing to height ${curVS.height}, round 0 (R${newProposer} proposes)`
    }
    return `Round ${prevVS.round} timed out (height ${prevVS.height}) — advancing to round ${curVS.round}, R${newProposer} proposes`
  }

  const prevVS    = prevStep.viewStates[curView]
  const currPhase = curVS?.phase
  const prevPhase = prevVS?.phase

  const prevLen = prevStep.deliveredMessages.length
  const currLen = step.deliveredMessages.length
  if (currLen > prevLen) {
    const lastMsg = step.deliveredMessages[currLen - 1] as TendermintMessage
    const from    = lastMsg.from as number

    switch (lastMsg.type) {
      case 'TM_PROPOSE': {
        const pm = lastMsg as TmProposeMessage
        const reproposeSuffix = pm.validRound !== null
          ? ` (re-proposing from round ${pm.validRound} per Polka)`
          : ''
        return `R${from} proposed block ${h6(pm.block.hash)}… for height ${pm.height} round ${pm.round}${reproposeSuffix}`
      }
      case 'TM_PREVOTE': {
        const pm    = lastMsg as TmPrevoteMessage
        const isNil = pm.vote.blockHash === NIL_VALUE
        const base  = isNil ? `R${from} prevoted NIL` : `R${from} prevoted for ${h6(pm.vote.blockHash)}…`
        if (currPhase === 'PRECOMMIT_VOTING' && prevPhase === 'PREVOTE_VOTING') {
          return `${base} — quorum reached, replicas move to PRECOMMIT`
        }
        return base
      }
      case 'TM_PRECOMMIT': {
        const pm    = lastMsg as TmPrecommitMessage
        const isNil = pm.vote.blockHash === NIL_VALUE
        const base  = isNil ? `R${from} precommitted NIL` : `R${from} precommitted for ${h6(pm.vote.blockHash)}…`
        if (currPhase === 'COMMITTED' && prevPhase === 'PRECOMMIT_VOTING') {
          return `${base} — quorum precommit, block will commit`
        }
        if (currPhase === 'ROUND_TIMED_OUT' && prevPhase === 'PRECOMMIT_VOTING') {
          return `${base} — quorum precommitted NIL, round will advance`
        }
        return base
      }
    }
  }

  if (prevPhase !== currPhase && currPhase !== undefined) {
    switch (currPhase) {
      case 'PREVOTE_VOTING': {
        const hash = curVS?.proposal?.hash ?? ''
        return `R${proposer} (proposer) proposed block ${h6(hash)}… for height ${curVS.height} round ${curVS.round}`
      }
      case 'ROUND_TIMED_OUT': {
        const nextProposer = leaderForView((step.currentView + 1) as ViewNumber, config.n)
        return `Round ${curVS.round} timed out — R${nextProposer as number} proposes next`
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
  const prev    = prevStep as TendermintSimulationStep
  const current = currentStep as TendermintSimulationStep

  const completedView = prev.currentView
  const vs             = prev.viewStates[completedView]

  const timedOut  = (vs?.phase as string) === 'ROUND_TIMED_OUT'
  const newCommit = vs?.triggeredCommitOf ?? current.viewStates[completedView]?.triggeredCommitOf ?? null

  const participating = (vs?.precommits ?? [])
    .map(v => v.voterId as number)
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .sort((a, b) => a - b)

  const qcBlock = vs?.triggeredCommitOf ?? null

  const messageCount = (current.deliveredMessages as readonly TendermintMessage[])
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
