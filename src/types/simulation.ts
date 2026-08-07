import type { ReplicaId } from './core'
import type { SimulationStep } from './hotstuff'
import type { BasicSimulationStep } from './basic'
import type { PbftSimulationStep } from './pbft'
import type { TendermintSimulationStep } from './tendermint'
import type { AlgorandSimulationStep } from './algorand'
import type { PaxosSimulationStep } from './paxos'

export type ByzantineFaultStrategy =
  | 'SILENT'
  | 'EQUIVOCATE'
  | 'WRONG_BLOCK'
  | 'DELAY'
  | 'INVALID_QC'

export interface ByzantineReplicaConfig {
  readonly id:       ReplicaId
  readonly strategy: ByzantineFaultStrategy
}

export interface SimConfig {
  readonly n:                 number
  readonly f:                 number
  readonly byzantineReplicas: readonly ByzantineReplicaConfig[]
  readonly viewTimeout:       number
  readonly maxViews:          number
  readonly seed?:             number
  readonly protocol:          'chained' | 'basic' | 'pbft' | 'tendermint' | 'algorand' | 'paxos'
  readonly dropRate:          number
}

export type AnySimulationStep = SimulationStep | BasicSimulationStep | PbftSimulationStep | TendermintSimulationStep | AlgorandSimulationStep | PaxosSimulationStep

export type SimulationStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAULT'

export interface ViewSummary {
  readonly view:          number
  readonly leader:        number
  readonly timedOut:      boolean
  readonly qcBlock:       string | null
  readonly committed:     string | null
  readonly participating: readonly number[]
  readonly messageCount:  number
}

export interface SimulationState {
  readonly config:           SimConfig
  readonly status:           SimulationStatus
  readonly steps:            readonly AnySimulationStep[]
  readonly currentStepIndex: number
}
