import type { ReplicaId, BlockHash, ViewNumber, Block, QC, Vote, ReplicaState } from './core'

export type BasicViewPhase =
  | 'PREPARE'
  | 'PREPARE_VOTING'
  | 'PRE_COMMIT'
  | 'PRE_COMMIT_VOTING'
  | 'COMMIT'
  | 'COMMIT_VOTING'
  | 'DECIDE'
  | 'DECIDE_COLLECTING'
  | 'TIMED_OUT'

interface BasicBaseMsg {
  readonly id:         string
  readonly from:       ReplicaId
  readonly to:         ReplicaId | 'broadcast'
  readonly view:       ViewNumber
  readonly sentAtStep: number
}

export interface BasicPrepareMessage extends BasicBaseMsg {
  readonly type:   'BASIC_PREPARE'
  readonly block:  Block
  readonly highQC: QC
}

export interface BasicPrepareVoteMessage extends BasicBaseMsg {
  readonly type: 'BASIC_PREPARE_VOTE'
  readonly vote: Vote
}

export interface BasicPreCommitMessage extends BasicBaseMsg {
  readonly type:      'BASIC_PRE_COMMIT'
  readonly prepareQC: QC
}

export interface BasicPreCommitVoteMessage extends BasicBaseMsg {
  readonly type: 'BASIC_PRE_COMMIT_VOTE'
  readonly vote: Vote
}

export interface BasicCommitMessage extends BasicBaseMsg {
  readonly type:        'BASIC_COMMIT'
  readonly preCommitQC: QC
}

export interface BasicCommitVoteMessage extends BasicBaseMsg {
  readonly type: 'BASIC_COMMIT_VOTE'
  readonly vote: Vote
}

export interface BasicDecideMessage extends BasicBaseMsg {
  readonly type:     'BASIC_DECIDE'
  readonly commitQC: QC
}

export interface BasicNewViewMessage extends BasicBaseMsg {
  readonly type:   'BASIC_NEW_VIEW'
  readonly highQC: QC
}

export type BasicMessage =
  | BasicPrepareMessage
  | BasicPrepareVoteMessage
  | BasicPreCommitMessage
  | BasicPreCommitVoteMessage
  | BasicCommitMessage
  | BasicCommitVoteMessage
  | BasicDecideMessage
  | BasicNewViewMessage

export interface BasicViewState {
  readonly view:              ViewNumber
  readonly leader:            ReplicaId
  readonly phase:             BasicViewPhase
  readonly proposal:          Block | null
  readonly highQC:            QC | null
  readonly prepareQC:         QC | null
  readonly preCommitQC:       QC | null
  readonly commitQC:          QC | null
  readonly prepareVotes:      readonly Vote[]
  readonly preCommitVotes:    readonly Vote[]
  readonly commitVotes:       readonly Vote[]
  readonly triggeredCommitOf: BlockHash | null
  readonly viewStartStep:     number
}

export interface BasicSimulationStep {
  readonly stepIndex:         number
  readonly currentView:       number
  readonly replicaStates:     readonly ReplicaState[]
  readonly viewStates:        readonly BasicViewState[]
  readonly blockchain:        readonly Block[]
  readonly committedBlocks:   readonly BlockHash[]
  readonly pendingMessages:   readonly BasicMessage[]
  readonly deliveredMessages: readonly BasicMessage[]
  readonly droppedMessages:   readonly BasicMessage[]
}
