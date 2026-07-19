export type ReplicaId  = number & { readonly __brand: 'ReplicaId' }
export type BlockHash  = string & { readonly __brand: 'BlockHash' }
export type ViewNumber = number & { readonly __brand: 'ViewNumber' }

export interface Block {
  readonly hash:       BlockHash
  readonly parentHash: BlockHash | null
  readonly height:     number
  readonly view:       ViewNumber
  readonly proposer:   ReplicaId
  readonly payload:    string
}

export interface QC {
  readonly view:      ViewNumber
  readonly blockHash: BlockHash
  readonly signers:   readonly ReplicaId[]
}

export interface Vote {
  readonly view:      ViewNumber
  readonly blockHash: BlockHash
  readonly voterId:   ReplicaId
}

export interface ReplicaState {
  readonly id:          ReplicaId
  readonly currentView: ViewNumber
  readonly lockedQC:    QC | null
  readonly prepareQC:   QC | null
  readonly isByzantine: boolean
}
