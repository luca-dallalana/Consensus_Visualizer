import type {
  AnySimulationStep, SimConfig,
  AlgorandSimulationStep, AlgorandMessage,
  AlgProposeMessage, AlgSoftVoteMessage, AlgCertVoteMessage,
  ViewSummary,
} from '../../types'

function h6(hash: string): string {
  return hash.slice(0, 6)
}

export function narrateStep(
  prev: AnySimulationStep | null,
  current: AnySimulationStep,
  _config: SimConfig,
): string {
  const step    = current as AlgorandSimulationStep
  const curView = step.currentView
  const curVS   = step.viewStates[curView]

  if (prev === null) {
    return curVS.proposers.length > 0
      ? `Simulation started — sortition selected R${(curVS.proposers as readonly number[]).join(', R')} for round 0`
      : `Simulation started — no replica selected via sortition for round 0`
  }

  const prevStep = prev as AlgorandSimulationStep

  if (curView > prevStep.currentView) {
    const prevVS = prevStep.viewStates[prevStep.currentView]
    const proposerList = curVS.proposers.length > 0
      ? `R${(curVS.proposers as readonly number[]).join(', R')} selected`
      : `no replica selected via sortition`

    if (prevVS.phase === 'COMMITTED') {
      const newCommits = step.committedBlocks.filter(h => !prevStep.committedBlocks.includes(h))
      const committedHash = newCommits.length > 0
        ? h6(newCommits[newCommits.length - 1])
        : h6(prevVS.triggeredCommitOf ?? '')
      return `Round ${prevVS.view as number} committed block ${committedHash}… — round ${curView}: ${proposerList}`
    }
    return `Round ${prevVS.view as number} timed out with no commit — round ${curView}: ${proposerList}`
  }

  const currPhase = curVS?.phase
  const prevVS    = prevStep.viewStates[curView]
  const prevPhase = prevVS?.phase

  const prevLen = prevStep.deliveredMessages.length
  const currLen = step.deliveredMessages.length
  if (currLen > prevLen) {
    const lastMsg = step.deliveredMessages[currLen - 1] as AlgorandMessage
    const from    = lastMsg.from as number

    switch (lastMsg.type) {
      case 'ALG_PROPOSE': {
        const pm = lastMsg as AlgProposeMessage
        const isBest = curVS.proposal?.hash === pm.block.hash
        return `R${from} (sortition-selected) proposed block ${h6(pm.block.hash)}…${isBest ? ' — currently the best-priority candidate' : ''}`
      }
      case 'ALG_SOFT_VOTE': {
        const pm = lastMsg as AlgSoftVoteMessage
        if (currPhase === 'CERT_VOTE_VOTING' && prevPhase === 'SOFT_VOTE_VOTING') {
          return `R${from}'s SOFT VOTE formed quorum for ${h6(pm.vote.blockHash)}… — advancing to CERT VOTE`
        }
        return `R${from} soft-voted for ${h6(pm.vote.blockHash)}…`
      }
      case 'ALG_CERT_VOTE': {
        const pm = lastMsg as AlgCertVoteMessage
        if (currPhase === 'COMMITTED' && prevPhase === 'CERT_VOTE_VOTING') {
          return `R${from}'s CERT VOTE formed quorum — block ${h6(pm.vote.blockHash)}… committed`
        }
        return `R${from} cert-voted for ${h6(pm.vote.blockHash)}…`
      }
    }
  }

  if (prevPhase !== currPhase && currPhase !== undefined) {
    switch (currPhase) {
      case 'ROUND_TIMED_OUT': {
        if (curVS.proposers.length === 0) {
          return `No replica was selected via sortition this round — advancing to round ${curView + 1}`
        }
        return `Round ${curView} timed out — advancing to round ${curView + 1}`
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
  const prev    = prevStep as AlgorandSimulationStep
  const current = currentStep as AlgorandSimulationStep

  const completedView = prev.currentView
  const vs             = prev.viewStates[completedView]

  const timedOut  = (vs?.phase as string) === 'ROUND_TIMED_OUT'
  const newCommit = vs?.triggeredCommitOf ?? current.viewStates[completedView]?.triggeredCommitOf ?? null

  const participating = (vs?.certVotes ?? [])
    .map(v => v.voterId as number)
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .sort((a, b) => a - b)

  const qcBlock = vs?.triggeredCommitOf ?? null

  const messageCount = (current.deliveredMessages as readonly AlgorandMessage[])
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
