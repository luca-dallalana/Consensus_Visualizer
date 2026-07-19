import type { ReplicaId, BlockHash, ViewNumber, Block, QC, Vote, ReplicaState } from './core'

interface BaseMessage {
  readonly id:         string
  readonly from:       ReplicaId
  readonly to:         ReplicaId | 'broadcast'
  readonly view:       ViewNumber
  readonly sentAtStep: number
}

export interface ProposalMessage extends BaseMessage {
  readonly type:   'PROPOSAL'
  readonly block:  Block
  readonly highQC: QC
}

export interface VoteMessage extends BaseMessage {
  readonly type: 'VOTE'
  readonly vote: Vote
}

export interface NewViewMessage extends BaseMessage {
  readonly type:   'NEW_VIEW'
  readonly highQC: QC
}

export type Message     = ProposalMessage | VoteMessage | NewViewMessage
export type MessageType = Message['type']

export type ViewPhase =
  | 'PROPOSING'
  | 'VOTING'
  | 'QC_FORMED'
  | 'TIMED_OUT'

export interface ViewState {
  readonly view:              ViewNumber
  readonly leader:            ReplicaId
  readonly phase:             ViewPhase
  readonly proposal:          Block | null
  readonly highQC:            QC | null
  readonly votes:             readonly Vote[]
  readonly qc:                QC | null
  readonly triggeredCommitOf: BlockHash | null
  readonly viewStartStep:     number
}

export interface SimulationStep {
  readonly stepIndex:         number
  readonly currentView:       number
  readonly replicaStates:     readonly ReplicaState[]
  readonly viewStates:        readonly ViewState[]
  readonly blockchain:        readonly Block[]
  readonly committedBlocks:   readonly BlockHash[]
  readonly pendingMessages:   readonly Message[]
  readonly deliveredMessages: readonly Message[]
  readonly droppedMessages:   readonly Message[]
}
