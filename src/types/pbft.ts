import type { ReplicaId, BlockHash, ViewNumber, Block, Vote, ReplicaState } from './core'

export type PbftViewPhase =
  | 'PRE_PREPARE'
  | 'PREPARE_VOTING'
  | 'COMMIT_VOTING'
  | 'COMMITTED'
  | 'TIMED_OUT'

interface PbftBaseMsg {
  readonly id:         string
  readonly from:       ReplicaId
  readonly to:         ReplicaId | 'broadcast'
  readonly view:       ViewNumber
  readonly sentAtStep: number
}

export interface PbftPrePrepareMessage extends PbftBaseMsg {
  readonly type:  'PBFT_PRE_PREPARE'
  readonly block: Block
}

export interface PbftPrepareMessage extends PbftBaseMsg {
  readonly type: 'PBFT_PREPARE'
  readonly vote: Vote
}

export interface PbftCommitMessage extends PbftBaseMsg {
  readonly type: 'PBFT_COMMIT'
  readonly vote: Vote
}

export interface PbftViewChangeMessage extends PbftBaseMsg {
  readonly type: 'PBFT_VIEW_CHANGE'
}

export type PbftMessage =
  | PbftPrePrepareMessage
  | PbftPrepareMessage
  | PbftCommitMessage
  | PbftViewChangeMessage

export interface PbftViewState {
  readonly view:              ViewNumber
  readonly leader:            ReplicaId
  readonly phase:             PbftViewPhase
  readonly proposal:          Block | null
  readonly prepareVotes:      readonly Vote[]
  readonly commitVotes:       readonly Vote[]
  readonly triggeredCommitOf: BlockHash | null
  readonly viewStartStep:     number
}

export interface PbftSimulationStep {
  readonly stepIndex:         number
  readonly currentView:       number
  readonly replicaStates:     readonly ReplicaState[]
  readonly viewStates:        readonly PbftViewState[]
  readonly blockchain:        readonly Block[]
  readonly committedBlocks:   readonly BlockHash[]
  readonly pendingMessages:   readonly PbftMessage[]
  readonly deliveredMessages: readonly PbftMessage[]
  readonly droppedMessages:   readonly PbftMessage[]
}
