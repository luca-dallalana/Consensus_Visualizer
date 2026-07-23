import type { ReplicaId, BlockHash, ViewNumber, Block, Vote } from './core'

export const NIL_VALUE = 'nil-value' as BlockHash

export type TendermintPhase =
  | 'PROPOSE'
  | 'PREVOTE_VOTING'
  | 'PRECOMMIT_VOTING'
  | 'COMMITTED'
  | 'ROUND_TIMED_OUT'

interface TmBaseMsg {
  readonly id:         string
  readonly from:       ReplicaId
  readonly to:         ReplicaId | 'broadcast'
  readonly view:       ViewNumber
  readonly sentAtStep: number
}

export interface TmProposeMessage extends TmBaseMsg {
  readonly type:       'TM_PROPOSE'
  readonly block:      Block
  readonly height:     number
  readonly round:      number
  readonly validRound: number | null
}

export interface TmPrevoteMessage extends TmBaseMsg {
  readonly type:   'TM_PREVOTE'
  readonly vote:   Vote
  readonly height: number
  readonly round:  number
}

export interface TmPrecommitMessage extends TmBaseMsg {
  readonly type:   'TM_PRECOMMIT'
  readonly vote:   Vote
  readonly height: number
  readonly round:  number
}

export type TendermintMessage = TmProposeMessage | TmPrevoteMessage | TmPrecommitMessage

export interface TendermintReplicaState {
  readonly id:          ReplicaId
  readonly currentView: ViewNumber
  readonly isByzantine: boolean
  readonly lockedValue: BlockHash | null
  readonly lockedRound: number | null
  readonly validValue:  BlockHash | null
  readonly validRound:  number | null
}

export interface TendermintViewState {
  readonly view:               ViewNumber
  readonly height:              number
  readonly round:               number
  readonly leader:               ReplicaId
  readonly phase:                TendermintPhase
  readonly proposal:            Block | null
  readonly proposalValidRound:  number | null
  readonly prevotes:            readonly Vote[]
  readonly precommits:          readonly Vote[]
  readonly triggeredCommitOf:   BlockHash | null
  readonly viewStartStep:       number
}

export interface TendermintSimulationStep {
  readonly stepIndex:         number
  readonly currentView:       number
  readonly replicaStates:     readonly TendermintReplicaState[]
  readonly viewStates:        readonly TendermintViewState[]
  readonly blockchain:        readonly Block[]
  readonly committedBlocks:   readonly BlockHash[]
  readonly pendingMessages:   readonly TendermintMessage[]
  readonly deliveredMessages: readonly TendermintMessage[]
  readonly droppedMessages:   readonly TendermintMessage[]
}
