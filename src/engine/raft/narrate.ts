import type {
  AnySimulationStep, SimConfig,
  RaftSimulationStep, RaftMessage,
  RaftRequestVoteMessage, RaftVoteGrantMessage, RaftAppendMessage, RaftAppendAckMessage,
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
  const step    = current as RaftSimulationStep
  const curView = step.currentView
  const curVS   = step.viewStates[curView]
  const leader  = curVS ? (curVS.leader as number) : 0

  if (prev === null) {
    return `Simulation started — R${leader} is candidate for view 0 (term ${curVS?.term ?? 1})`
  }

  const prevStep = prev as RaftSimulationStep

  if (curView > prevStep.currentView) {
    const prevView  = prevStep.currentView
    const newLeader = curVS ? (curVS.leader as number) : leader
    let msg = `View ${prevView} complete — R${newLeader} is candidate for view ${curView} (term ${curVS?.term ?? '?'})`
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
    const lastMsg = step.deliveredMessages[currLen - 1] as RaftMessage
    const from    = lastMsg.from as number

    const newCommits   = step.committedBlocks.filter(h => !prevStep.committedBlocks.includes(h))
    const commitSuffix = newCommits.length > 0
      ? ` — block ${h6(newCommits[newCommits.length - 1])}… committed`
      : ''

    switch (lastMsg.type) {
      case 'RAFT_REQUEST_VOTE': {
        const rv = lastMsg as RaftRequestVoteMessage
        return `R${from} (candidate) broadcast REQUEST-VOTE term ${rv.term} (log i${rv.lastLogIndex}@t${rv.lastLogTerm}) to all replicas`
      }
      case 'RAFT_VOTE_GRANT': {
        const vg = lastMsg as RaftVoteGrantMessage
        if (currPhase === 'APPEND_VOTING') {
          const hash = curVS?.proposal?.hash ?? ''
          return `R${from}'s vote formed a majority — R${lastMsg.to as number} wins term ${vg.term}, proposes block ${h6(hash)}…`
        }
        return vg.granted
          ? `R${from} grants its vote to R${lastMsg.to as number} for term ${vg.term}`
          : `R${lastMsg.to as number}'s log is stale — R${from} refuses its term ${vg.term} vote request`
      }
      case 'RAFT_APPEND': {
        const am = lastMsg as RaftAppendMessage
        return `R${from} (leader) broadcast APPEND for block ${h6(am.block.hash)}… (term ${am.term})`
      }
      case 'RAFT_APPEND_ACK': {
        const am = lastMsg as RaftAppendAckMessage
        if (currPhase === 'COMMITTED') {
          return `R${from}'s ACK formed a majority${commitSuffix}`
        }
        return `R${from} acknowledged term ${am.term} for ${h6(am.vote.blockHash)}…`
      }
    }
  }

  if (prevPhase !== currPhase && currPhase !== undefined) {
    switch (currPhase) {
      case 'APPEND_VOTING':
        return `Majority vote granted — leader elected, broadcasting APPEND`
      case 'COMMITTED':
        return `Majority ACK — block committed`
      case 'TIMED_OUT':
        return `View ${curView} timed out — no leader elected or no ack quorum; retrying with the next candidate`
    }
  }

  return ''
}

export function computeViewSummary(
  prevStep:    AnySimulationStep,
  currentStep: AnySimulationStep,
  _config:     SimConfig,
): ViewSummary {
  const prev    = prevStep as RaftSimulationStep
  const current = currentStep as RaftSimulationStep

  const completedView = prev.currentView
  const vs            = prev.viewStates[completedView]

  const timedOut  = (vs?.phase as string) === 'TIMED_OUT'
  const newCommit = vs?.committedBlock ?? current.viewStates[completedView]?.committedBlock ?? null

  const appendAcks = vs?.appendAcks ?? []
  const participating = appendAcks
    .map(v => v.voterId as number)
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .sort((a, b) => a - b)

  const qcBlock = vs?.committedBlock ?? null

  const messageCount = (current.deliveredMessages as readonly RaftMessage[])
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
