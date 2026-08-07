import type {
  AnySimulationStep, SimConfig,
  PaxosSimulationStep, PaxosMessage,
  PaxosPrepareMessage, PaxosPromiseMessage, PaxosAcceptMessage, PaxosAcceptedMessage,
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
  const step    = current as PaxosSimulationStep
  const curView = step.currentView
  const curVS   = step.viewStates[curView]
  const leader  = curVS ? (curVS.leader as number) : 0

  if (prev === null) {
    return `Simulation started — R${leader} is proposer for view 0 (proposal #${curVS?.proposalNumber ?? 1})`
  }

  const prevStep = prev as PaxosSimulationStep

  if (curView > prevStep.currentView) {
    const prevView  = prevStep.currentView
    const newLeader = curVS ? (curVS.leader as number) : leader
    let msg = `View ${prevView} complete — R${newLeader} is proposer for view ${curView} (proposal #${curVS?.proposalNumber ?? '?'})`
    const newCommits = step.committedBlocks.filter(h => !prevStep.committedBlocks.includes(h))
    if (newCommits.length > 0) {
      msg += ` · block ${h6(newCommits[newCommits.length - 1])}… decided`
    }
    return msg
  }

  const prevVS    = prevStep.viewStates[curView]
  const currPhase = curVS?.phase
  const prevPhase = prevVS?.phase

  const prevLen = prevStep.deliveredMessages.length
  const currLen = step.deliveredMessages.length
  if (currLen > prevLen) {
    const lastMsg = step.deliveredMessages[currLen - 1] as PaxosMessage
    const from    = lastMsg.from as number

    const newCommits   = step.committedBlocks.filter(h => !prevStep.committedBlocks.includes(h))
    const decideSuffix = newCommits.length > 0
      ? ` — block ${h6(newCommits[newCommits.length - 1])}… decided`
      : ''

    switch (lastMsg.type) {
      case 'PAXOS_PREPARE': {
        const pm = lastMsg as PaxosPrepareMessage
        return `R${from} (proposer) broadcast PREPARE #${pm.proposalNumber} to all acceptors`
      }
      case 'PAXOS_PROMISE': {
        const pm = lastMsg as PaxosPromiseMessage
        if (currPhase === 'ACCEPT_VOTING') {
          const hash = curVS?.proposal?.hash ?? ''
          return `R${from}'s PROMISE formed a majority — R${lastMsg.to as number} proposes block ${h6(hash)}…, broadcasting ACCEPT`
        }
        const carry = pm.priorAccepted != null ? ` (carrying prior accept #${pm.priorAccepted.number})` : ''
        return `R${from} promised #${pm.proposalNumber} to R${lastMsg.to as number}${carry}`
      }
      case 'PAXOS_ACCEPT': {
        const am = lastMsg as PaxosAcceptMessage
        return `R${from} (proposer) broadcast ACCEPT #${am.proposalNumber} for block ${h6(am.block.hash)}…`
      }
      case 'PAXOS_ACCEPTED': {
        const am = lastMsg as PaxosAcceptedMessage
        if (currPhase === 'DECIDED') {
          return `R${from}'s ACCEPTED formed a majority${decideSuffix}`
        }
        return `R${from} accepted #${am.proposalNumber} for ${h6(am.vote.blockHash)}…`
      }
    }
  }

  if (prevPhase !== currPhase && currPhase !== undefined) {
    switch (currPhase) {
      case 'ACCEPT_VOTING':
        return `Majority PROMISE — proposing and broadcasting ACCEPT`
      case 'DECIDED':
        return `Majority ACCEPTED — value decided`
      case 'TIMED_OUT': {
        const nextV       = nextView(curView as ViewNumber)
        const nextLeader  = leaderForView(nextV, config.n)
        const nextPropNum = (nextV as number) + 1
        return `View ${curView} timed out — no view-change handshake, R${nextLeader as number} proposes view ${nextV as number} with proposal #${nextPropNum}`
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
  const prev    = prevStep as PaxosSimulationStep
  const current = currentStep as PaxosSimulationStep

  const completedView = prev.currentView
  const vs            = prev.viewStates[completedView]

  const timedOut  = (vs?.phase as string) === 'TIMED_OUT'
  const newCommit = vs?.decidedBlock ?? current.viewStates[completedView]?.decidedBlock ?? null

  const accepteds = vs?.accepteds ?? []
  const participating = accepteds
    .map(v => v.voterId as number)
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .sort((a, b) => a - b)

  const qcBlock = vs?.decidedBlock ?? null

  const messageCount = (current.deliveredMessages as readonly PaxosMessage[])
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
