import type { ReplicaId, BlockHash, ViewNumber, Block, Vote } from './core'

export type RaftViewPhase =
  | 'REQUEST_VOTE_VOTING'
  | 'APPEND_VOTING'
  | 'COMMITTED'
  | 'TIMED_OUT'

interface RaftBaseMsg {
  readonly id:         string
  readonly from:       ReplicaId
  readonly to:         ReplicaId | 'broadcast'
  readonly view:       ViewNumber
  readonly sentAtStep: number
}

export interface RaftRequestVoteMessage extends RaftBaseMsg {
  readonly type:         'RAFT_REQUEST_VOTE'
  readonly term:         number
  readonly lastLogIndex: number
  readonly lastLogTerm:  number
}

export interface RaftVoteGrantMessage extends RaftBaseMsg {
  readonly type:    'RAFT_VOTE_GRANT'
  readonly to:       ReplicaId
  readonly term:    number
  readonly granted: boolean
}

export interface RaftAppendMessage extends RaftBaseMsg {
  readonly type:  'RAFT_APPEND'
  readonly term:  number
  readonly block: Block
}

export interface RaftAppendAckMessage extends RaftBaseMsg {
  readonly type: 'RAFT_APPEND_ACK'
  readonly to:    ReplicaId
  readonly term: number
  readonly vote: Vote
}

export type RaftMessage =
  | RaftRequestVoteMessage
  | RaftVoteGrantMessage
  | RaftAppendMessage
  | RaftAppendAckMessage

// lastLogIndex/lastLogTerm are real replicated-log state — unlike Paxos's
// acceptedProposal, they grow monotonically forever and never reset per slot.
export interface RaftReplicaState {
  readonly id:            ReplicaId
  readonly currentView:   ViewNumber
  readonly currentTerm:   number
  readonly lastLogIndex:  number
  readonly lastLogTerm:   number
  readonly isByzantine:   boolean
}

export interface RaftVoteRecord {
  readonly voterId: ReplicaId
  readonly term:    number
  readonly granted: boolean
}

export interface RaftViewState {
  readonly view:          ViewNumber
  readonly leader:        ReplicaId
  readonly phase:         RaftViewPhase
  readonly term:          number
  readonly proposal:      Block | null
  readonly votesGranted:  readonly RaftVoteRecord[]
  readonly appendAcks:    readonly Vote[]
  readonly committedBlock: BlockHash | null
  readonly viewStartStep: number
}

export interface RaftSimulationStep {
  readonly stepIndex:         number
  readonly currentView:       number
  readonly replicaStates:     readonly RaftReplicaState[]
  readonly viewStates:        readonly RaftViewState[]
  readonly blockchain:        readonly Block[]
  readonly committedBlocks:   readonly BlockHash[]
  readonly pendingMessages:   readonly RaftMessage[]
  readonly deliveredMessages: readonly RaftMessage[]
  readonly droppedMessages:   readonly RaftMessage[]
}
