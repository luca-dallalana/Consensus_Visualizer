import type { ReplicaId, BlockHash, ViewNumber, Block, Vote } from './core'

export type PaxosViewPhase =
  | 'PREPARE_VOTING'
  | 'ACCEPT_VOTING'
  | 'DECIDED'
  | 'TIMED_OUT'

interface PaxosBaseMsg {
  readonly id:         string
  readonly from:       ReplicaId
  readonly to:         ReplicaId | 'broadcast'
  readonly view:       ViewNumber
  readonly sentAtStep: number
}

export interface PaxosPrepareMessage extends PaxosBaseMsg {
  readonly type:           'PAXOS_PREPARE'
  readonly proposalNumber: number
}

export interface PaxosPromiseMessage extends PaxosBaseMsg {
  readonly type:           'PAXOS_PROMISE'
  readonly to:              ReplicaId
  readonly proposalNumber: number
  readonly priorAccepted:  { readonly number: number; readonly block: Block } | null
}

export interface PaxosAcceptMessage extends PaxosBaseMsg {
  readonly type:           'PAXOS_ACCEPT'
  readonly proposalNumber: number
  readonly block:          Block
}

export interface PaxosAcceptedMessage extends PaxosBaseMsg {
  readonly type:           'PAXOS_ACCEPTED'
  readonly to:              ReplicaId
  readonly proposalNumber: number
  readonly vote:           Vote
}

export type PaxosMessage =
  | PaxosPrepareMessage
  | PaxosPromiseMessage
  | PaxosAcceptMessage
  | PaxosAcceptedMessage

// promisedNumber/acceptedProposal persist across view advances (unlike
// PBFT's per-view vote arrays) — they're the cross-round safety memory.
export interface PaxosReplicaState {
  readonly id:               ReplicaId
  readonly currentView:      ViewNumber
  readonly promisedNumber:   number
  readonly acceptedProposal: { readonly number: number; readonly block: Block } | null
  readonly isByzantine:      boolean
}

export interface PaxosPromiseRecord {
  readonly voterId:        ReplicaId
  readonly proposalNumber: number
  readonly priorAccepted:  { readonly number: number; readonly block: Block } | null
}

export interface PaxosViewState {
  readonly view:           ViewNumber
  readonly leader:         ReplicaId
  readonly phase:          PaxosViewPhase
  readonly proposalNumber: number
  readonly proposal:       Block | null
  readonly promises:       readonly PaxosPromiseRecord[]
  readonly accepteds:      readonly Vote[]
  readonly decidedBlock:   BlockHash | null
  readonly viewStartStep:  number
}

export interface PaxosSimulationStep {
  readonly stepIndex:         number
  readonly currentView:       number
  readonly replicaStates:     readonly PaxosReplicaState[]
  readonly viewStates:        readonly PaxosViewState[]
  readonly blockchain:        readonly Block[]
  readonly committedBlocks:   readonly BlockHash[]
  readonly pendingMessages:   readonly PaxosMessage[]
  readonly deliveredMessages: readonly PaxosMessage[]
  readonly droppedMessages:   readonly PaxosMessage[]
}
