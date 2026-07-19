import type { AnySimulationStep, SimConfig, ViewSummary } from '../types'
import type { ReplicaId } from '../types'

export interface VoteDisplay {
  blockHash: string
  viewNum:   number
  label:     string
}

export interface MessageTypeStyle {
  color:        string
  label:        string
  broadcastArc: boolean
}

export interface ProtocolPlugin {
  id:          string
  displayName: string
  init(config: SimConfig): AnySimulationStep
  advance(step: AnySimulationStep, config: SimConfig): AnySimulationStep
  narrate(prev: AnySimulationStep | null, current: AnySimulationStep, config: SimConfig): string
  summarizeView(prev: AnySimulationStep, current: AnySimulationStep, config: SimConfig): ViewSummary
  messageTypeMap: Record<string, MessageTypeStyle>
  getVotesForReplica(step: AnySimulationStep, replicaId: ReplicaId, config: SimConfig): VoteDisplay[]
}

import { initSimulation, advanceStep } from './hotstuff/step'
import { narrateStep as narrateHotStuff, computeViewSummary as summarizeHotStuff } from './hotstuff/narrate'
import type { SimulationStep, ViewState } from '../types'

import { initBasicSimulation, advanceBasicStep } from './basic/step'
import { narrateStep as narrateBasic, computeViewSummary as summarizeBasic } from './basic/narrate'
import type { BasicSimulationStep, BasicViewState } from '../types'

import { initPbftSimulation, advancePbftStep } from './pbft/step'
import { narrateStep as narratePbft, computeViewSummary as summarizePbft } from './pbft/narrate'
import type { PbftSimulationStep } from '../types'

const chainedPlugin: ProtocolPlugin = {
  id:          'chained',
  displayName: 'Chained HotStuff',
  init:        config => initSimulation(config),
  advance:     (step, config) => advanceStep(step as SimulationStep, config),
  narrate:     (prev, current, config) => narrateHotStuff(prev, current, config),
  summarizeView: (prev, current, config) => summarizeHotStuff(prev, current, config),
  messageTypeMap: {
    PROPOSAL: { color: '#60a5fa', label: 'Proposal',  broadcastArc: true  },
    VOTE:     { color: '#34d399', label: 'Vote',       broadcastArc: false },
    NEW_VIEW: { color: '#f59e0b', label: 'New View',   broadcastArc: false },
  },
  getVotesForReplica(step, replicaId, _config) {
    const s  = step as SimulationStep
    const vs = s.viewStates[s.currentView] as ViewState | undefined
    if (!vs) return []
    return vs.votes
      .filter(v => (v.voterId as number) === (replicaId as number))
      .map(v => ({ blockHash: v.blockHash, viewNum: v.view as number, label: 'VOTE' }))
  },
}

const basicPlugin: ProtocolPlugin = {
  id:          'basic',
  displayName: 'Basic HotStuff',
  init:        config => initBasicSimulation(config),
  advance:     (step, config) => advanceBasicStep(step as BasicSimulationStep, config),
  narrate:     (prev, current, config) => narrateBasic(prev, current, config),
  summarizeView: (prev, current, config) => summarizeBasic(prev, current, config),
  messageTypeMap: {
    BASIC_PREPARE:         { color: '#60a5fa', label: 'Prepare',         broadcastArc: true  },
    BASIC_PREPARE_VOTE:    { color: '#34d399', label: 'Prepare Vote',     broadcastArc: false },
    BASIC_PRE_COMMIT:      { color: '#a78bfa', label: 'Pre-Commit',       broadcastArc: true  },
    BASIC_PRE_COMMIT_VOTE: { color: '#f472b6', label: 'Pre-Commit Vote',  broadcastArc: false },
    BASIC_COMMIT:          { color: '#fb923c', label: 'Commit',           broadcastArc: true  },
    BASIC_COMMIT_VOTE:     { color: '#facc15', label: 'Commit Vote',      broadcastArc: false },
    BASIC_DECIDE:          { color: '#4ade80', label: 'Decide',           broadcastArc: true  },
    BASIC_NEW_VIEW:        { color: '#f59e0b', label: 'New View',         broadcastArc: false },
  },
  getVotesForReplica(step, replicaId, _config) {
    const s  = step as BasicSimulationStep
    const vs = s.viewStates[s.currentView] as BasicViewState | undefined
    if (!vs) return []
    const all = [
      ...vs.prepareVotes.map(v => ({ ...v, label: 'PREPARE' })),
      ...vs.preCommitVotes.map(v => ({ ...v, label: 'PRE-COMMIT' })),
      ...vs.commitVotes.map(v => ({ ...v, label: 'COMMIT' })),
    ]
    return all
      .filter(v => (v.voterId as number) === (replicaId as number))
      .map(v => ({ blockHash: v.blockHash, viewNum: v.view as number, label: v.label }))
  },
}

const pbftPlugin: ProtocolPlugin = {
  id:          'pbft',
  displayName: 'PBFT',
  init:        config => initPbftSimulation(config),
  advance:     (step, config) => advancePbftStep(step as PbftSimulationStep, config),
  narrate:     (prev, current, config) => narratePbft(prev, current, config),
  summarizeView: (prev, current, config) => summarizePbft(prev, current, config),
  messageTypeMap: {
    PBFT_PRE_PREPARE: { color: '#60a5fa', label: 'Pre-Prepare',  broadcastArc: true  },
    PBFT_PREPARE:     { color: '#34d399', label: 'Prepare',       broadcastArc: true  },
    PBFT_COMMIT:      { color: '#fb923c', label: 'Commit',        broadcastArc: true  },
    PBFT_VIEW_CHANGE: { color: '#f59e0b', label: 'View Change',   broadcastArc: false },
  },
  getVotesForReplica(step, replicaId, _config) {
    const s  = step as PbftSimulationStep
    const vs = s.viewStates[s.currentView]
    if (!vs) return []
    const all = [
      ...vs.prepareVotes.map(v => ({ ...v, label: 'PREPARE' })),
      ...vs.commitVotes.map(v => ({ ...v, label: 'COMMIT' })),
    ]
    return all
      .filter(v => (v.voterId as number) === (replicaId as number))
      .map(v => ({ blockHash: v.blockHash, viewNum: v.view as number, label: v.label }))
  },
}

export const REGISTRY: Record<string, ProtocolPlugin> = {
  chained: chainedPlugin,
  basic:   basicPlugin,
  pbft:    pbftPlugin,
}
