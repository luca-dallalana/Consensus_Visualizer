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

import { initTendermintSimulation, advanceTendermintStep } from './tendermint/step'
import { narrateStep as narrateTendermint, computeViewSummary as summarizeTendermint } from './tendermint/narrate'
import type { TendermintSimulationStep, TendermintViewState } from '../types'

import { initAlgorandSimulation, advanceAlgorandStep } from './algorand/step'
import { narrateStep as narrateAlgorand, computeViewSummary as summarizeAlgorand } from './algorand/narrate'
import type { AlgorandSimulationStep, AlgorandViewState } from '../types'

import { initPaxosSimulation, advancePaxosStep } from './paxos/step'
import { narrateStep as narratePaxos, computeViewSummary as summarizePaxos } from './paxos/narrate'
import type { PaxosSimulationStep, PaxosViewState } from '../types'

import { initRaftSimulation, advanceRaftStep } from './raft/step'
import { narrateStep as narrateRaft, computeViewSummary as summarizeRaft } from './raft/narrate'
import type { RaftSimulationStep, RaftViewState } from '../types'

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

const tendermintPlugin: ProtocolPlugin = {
  id:          'tendermint',
  displayName: 'Tendermint',
  init:        config => initTendermintSimulation(config),
  advance:     (step, config) => advanceTendermintStep(step as TendermintSimulationStep, config),
  narrate:     (prev, current, config) => narrateTendermint(prev, current, config),
  summarizeView: (prev, current, config) => summarizeTendermint(prev, current, config),
  messageTypeMap: {
    TM_PROPOSE:   { color: '#60a5fa', label: 'Propose',   broadcastArc: true  },
    TM_PREVOTE:   { color: '#34d399', label: 'Prevote',    broadcastArc: false },
    TM_PRECOMMIT: { color: '#fb923c', label: 'Precommit',  broadcastArc: false },
  },
  getVotesForReplica(step, replicaId, _config) {
    const s  = step as TendermintSimulationStep
    const vs = s.viewStates[s.currentView] as TendermintViewState | undefined
    if (!vs) return []
    const all = [
      ...vs.prevotes.map(v => ({ ...v, label: 'PREVOTE' })),
      ...vs.precommits.map(v => ({ ...v, label: 'PRECOMMIT' })),
    ]
    return all
      .filter(v => (v.voterId as number) === (replicaId as number))
      .map(v => ({ blockHash: v.blockHash, viewNum: v.view as number, label: v.label }))
  },
}

const algorandPlugin: ProtocolPlugin = {
  id:          'algorand',
  displayName: 'Algorand (BA⋆)',
  init:        config => initAlgorandSimulation(config),
  advance:     (step, config) => advanceAlgorandStep(step as AlgorandSimulationStep, config),
  narrate:     (prev, current, config) => narrateAlgorand(prev, current, config),
  summarizeView: (prev, current, config) => summarizeAlgorand(prev, current, config),
  messageTypeMap: {
    ALG_PROPOSE:   { color: '#60a5fa', label: 'Propose',    broadcastArc: true  },
    ALG_SOFT_VOTE: { color: '#34d399', label: 'Soft Vote',   broadcastArc: false },
    ALG_CERT_VOTE: { color: '#fb923c', label: 'Cert Vote',   broadcastArc: false },
  },
  getVotesForReplica(step, replicaId, _config) {
    const s  = step as AlgorandSimulationStep
    const vs = s.viewStates[s.currentView] as AlgorandViewState | undefined
    if (!vs) return []
    const all = [
      ...vs.softVotes.map(v => ({ ...v, label: 'SOFT-VOTE' })),
      ...vs.certVotes.map(v => ({ ...v, label: 'CERT-VOTE' })),
    ]
    return all
      .filter(v => (v.voterId as number) === (replicaId as number))
      .map(v => ({ blockHash: v.blockHash, viewNum: v.view as number, label: v.label }))
  },
}

const paxosPlugin: ProtocolPlugin = {
  id:          'paxos',
  displayName: 'Paxos',
  init:        config => initPaxosSimulation(config),
  advance:     (step, config) => advancePaxosStep(step as PaxosSimulationStep, config),
  narrate:     (prev, current, config) => narratePaxos(prev, current, config),
  summarizeView: (prev, current, config) => summarizePaxos(prev, current, config),
  messageTypeMap: {
    PAXOS_PREPARE:  { color: '#60a5fa', label: 'Prepare',  broadcastArc: true  },
    PAXOS_PROMISE:  { color: '#34d399', label: 'Promise',  broadcastArc: false },
    PAXOS_ACCEPT:   { color: '#fb923c', label: 'Accept',   broadcastArc: true  },
    PAXOS_ACCEPTED: { color: '#facc15', label: 'Accepted', broadcastArc: false },
  },
  getVotesForReplica(step, replicaId, _config) {
    const s  = step as PaxosSimulationStep
    const vs = s.viewStates[s.currentView] as PaxosViewState | undefined
    if (!vs) return []
    return vs.accepteds
      .filter(v => (v.voterId as number) === (replicaId as number))
      .map(v => ({ blockHash: v.blockHash, viewNum: v.view as number, label: 'ACCEPTED' }))
  },
}

const raftPlugin: ProtocolPlugin = {
  id:          'raft',
  displayName: 'Raft',
  init:        config => initRaftSimulation(config),
  advance:     (step, config) => advanceRaftStep(step as RaftSimulationStep, config),
  narrate:     (prev, current, config) => narrateRaft(prev, current, config),
  summarizeView: (prev, current, config) => summarizeRaft(prev, current, config),
  messageTypeMap: {
    RAFT_REQUEST_VOTE: { color: '#60a5fa', label: 'Request Vote', broadcastArc: true  },
    RAFT_VOTE_GRANT:   { color: '#34d399', label: 'Vote Grant',   broadcastArc: false },
    RAFT_APPEND:       { color: '#fb923c', label: 'Append',       broadcastArc: true  },
    RAFT_APPEND_ACK:   { color: '#facc15', label: 'Append Ack',   broadcastArc: false },
  },
  getVotesForReplica(step, replicaId, _config) {
    const s  = step as RaftSimulationStep
    const vs = s.viewStates[s.currentView] as RaftViewState | undefined
    if (!vs) return []
    return vs.appendAcks
      .filter(v => (v.voterId as number) === (replicaId as number))
      .map(v => ({ blockHash: v.blockHash, viewNum: v.view as number, label: 'APPEND-ACK' }))
  },
}

export const REGISTRY: Record<string, ProtocolPlugin> = {
  chained:    chainedPlugin,
  basic:      basicPlugin,
  pbft:       pbftPlugin,
  tendermint: tendermintPlugin,
  algorand:   algorandPlugin,
  paxos:      paxosPlugin,
  raft:       raftPlugin,
}
