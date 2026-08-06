import type { ReplicaId, BlockHash, ViewNumber, Block, Vote, ReplicaState } from './core'

export type AlgorandPhase =
  | 'PROPOSE'
  | 'SOFT_VOTE_VOTING'
  | 'CERT_VOTE_VOTING'
  | 'COMMITTED'
  | 'ROUND_TIMED_OUT'

interface AlgBaseMsg {
  readonly id:         string
  readonly from:       ReplicaId
  readonly to:         ReplicaId | 'broadcast'
  readonly view:       ViewNumber
  readonly sentAtStep: number
}

export interface AlgProposeMessage extends AlgBaseMsg {
  readonly type:     'ALG_PROPOSE'
  readonly block:    Block
  readonly priority: number
}

export interface AlgSoftVoteMessage extends AlgBaseMsg {
  readonly type: 'ALG_SOFT_VOTE'
  readonly vote: Vote
}

export interface AlgCertVoteMessage extends AlgBaseMsg {
  readonly type: 'ALG_CERT_VOTE'
  readonly vote: Vote
}

export type AlgorandMessage = AlgProposeMessage | AlgSoftVoteMessage | AlgCertVoteMessage

export interface AlgorandViewState {
  readonly view:              ViewNumber
  readonly leader:             ReplicaId
  readonly proposers:          readonly ReplicaId[]
  readonly phase:              AlgorandPhase
  readonly proposal:           Block | null
  readonly proposalPriority:   number | null
  readonly softVotes:          readonly Vote[]
  readonly certVotes:          readonly Vote[]
  readonly triggeredCommitOf:  BlockHash | null
  readonly viewStartStep:      number
}

export interface AlgorandSimulationStep {
  readonly stepIndex:         number
  readonly currentView:       number
  readonly replicaStates:     readonly ReplicaState[]
  readonly viewStates:        readonly AlgorandViewState[]
  readonly blockchain:        readonly Block[]
  readonly committedBlocks:   readonly BlockHash[]
  readonly pendingMessages:   readonly AlgorandMessage[]
  readonly deliveredMessages: readonly AlgorandMessage[]
  readonly droppedMessages:   readonly AlgorandMessage[]
}
