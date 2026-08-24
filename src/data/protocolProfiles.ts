import type { ByzantineFaultStrategy } from '../types'

export interface ProtocolProfile {
  readonly category:            'BFT' | 'CFT'
  readonly leaderSelection:     string
  readonly quorum:              string
  readonly phases:              string
  readonly messageComplexity:   string
  readonly crossViewSafety:     string
  readonly faultsHandled:       readonly ByzantineFaultStrategy[]
  readonly distinguishingTrait: string
  readonly strength:            string
  readonly weakness:            string
}

export const PROTOCOL_PROFILES: Record<string, ProtocolProfile> = {
  chained: {
    category:            'BFT',
    leaderSelection:     'Round-robin',
    quorum:              '⌊2n/3⌋+1',
    phases:              '1 round-trip/view (propose → vote → QC), pipelined',
    messageComplexity:   'O(n) — votes go to the leader only, not all-to-all',
    crossViewSafety:     '3-chain rule: commit is implicit once 3 consecutive views form a parent-QC chain; prepareQC carried forward via NEW_VIEW',
    faultsHandled:       ['SILENT', 'WRONG_BLOCK', 'INVALID_QC', 'EQUIVOCATE', 'DELAY'],
    distinguishingTrait: 'QC-chaining/pipelining — no separate commit phase, commit falls out of the chain structure itself',
    strength:            'Lowest latency-to-throughput ratio here: one linear round-trip per view, fully pipelined',
    weakness:            'A single Byzantine leader can stall commits for up to 2 views before the 3-chain completes',
  },
  basic: {
    category:            'BFT',
    leaderSelection:     'Round-robin',
    quorum:              '⌊2n/3⌋+1',
    phases:              '4 phases/block: PREPARE → PRE-COMMIT → COMMIT → DECIDE',
    messageComplexity:   'O(n) per phase, O(n) overall — same linear shape as Chained, bigger constant',
    crossViewSafety:     'Classic 3-phase lock: lockedQC is only set once COMMIT is reached',
    faultsHandled:       ['SILENT', 'WRONG_BLOCK', 'INVALID_QC', 'EQUIVOCATE', 'DELAY'],
    distinguishingTrait: 'Explicit DECIDE broadcast as its own phase — one full 4-phase cycle per block, not pipelined',
    strength:            'Simplest per-block safety story of the QC family: no partially-committed cross-view state to reason about',
    weakness:            '~4x the message rounds of Chained HotStuff for the same rate of decided blocks',
  },
  pbft: {
    category:            'BFT',
    leaderSelection:     'Round-robin',
    quorum:              '⌊2n/3⌋+1',
    phases:              '3 phases: PRE-PREPARE → PREPARE → COMMIT, no QC objects',
    messageComplexity:   'O(n²) in the real protocol — every replica broadcasts PREPARE/COMMIT to every other replica; this simulator’s message objects collapse each broadcast into one trackable entry, so its own count reads as O(n)',
    crossViewSafety:     'None — no locked value carried over; view change is driven by a quorum of VIEW-CHANGE messages instead',
    faultsHandled:       ['SILENT', 'WRONG_BLOCK', 'EQUIVOCATE', 'DELAY'],
    distinguishingTrait: 'No QC/chaining concept at all — pure vote-counting. The original BFT state-machine-replication protocol',
    strength:            'Simplest mental model of any BFT protocol here — no QC bookkeeping, extensively studied and battle-tested',
    weakness:            'O(n²) real message complexity is the textbook reason HotStuff and Tendermint exist',
  },
  tendermint: {
    category:            'BFT',
    leaderSelection:     'Round-robin per round (within a height)',
    quorum:              '⌊2n/3⌋+1 ("polka")',
    phases:              'PROPOSE → PREVOTE → PRECOMMIT',
    messageComplexity:   'O(n) per round',
    crossViewSafety:     'lockedValue/validValue persist across round failures within the same height, reset only when the height advances',
    faultsHandled:       ['SILENT', 'WRONG_BLOCK', 'EQUIVOCATE', 'DELAY'],
    distinguishingTrait: 'The only protocol here with a genuine height/round split, plus NIL-vote polkas',
    strength:            'Cleanly separates "which block" (height) from "which attempt" (round) — a bad round is cheap to recover from without re-litigating an already-decided height',
    weakness:            'Two full voting phases (prevote + precommit) every round, even on the common/happy path',
  },
  algorand: {
    category:            'BFT',
    leaderSelection:     'Cryptographic sortition (seeded random draw; 0, 1, or many proposers per round, lowest-priority tiebreak)',
    quorum:              '⌊2n/3⌋+1',
    phases:              'PROPOSE → SOFT-VOTE → CERT-VOTE',
    messageComplexity:   'O(n) per round in this simulator (full-committee voting); real Algorand achieves sub-linear cost via committee sub-sampling, deliberately not modeled here since it is unsafe at n=4-9',
    crossViewSafety:     'None — every round is an independent BA* instance',
    faultsHandled:       ['SILENT', 'WRONG_BLOCK', 'EQUIVOCATE', 'DELAY'],
    distinguishingTrait: 'The only non-round-robin leader election — a round can have zero proposers and time out with no messages at all',
    strength:            'No single point of leader failure to wait out: an absent proposer just means an empty round, not a stuck round-robin slot',
    weakness:            'Proposer count is probabilistic, not guaranteed — added variance in commit latency purely from chance',
  },
  paxos: {
    category:            'CFT',
    leaderSelection:     'Round-robin proposer (no Byzantine tolerance — crash faults only)',
    quorum:              '⌊n/2⌋+1 (majority)',
    phases:              '2 round-trips: PREPARE → PROMISE, then ACCEPT → ACCEPTED',
    messageComplexity:   'O(n) per slot',
    crossViewSafety:     'Promise-carries-prior-value rule: a proposer must adopt the highest-numbered previously-accepted value a Promise reveals, instead of proposing fresh',
    faultsHandled:       ['SILENT', 'DELAY'],
    distinguishingTrait: 'No explicit view-change handshake — recovery is purely "retry with a higher proposal number"; safety comes from the promise rule, not a locked-QC-style field',
    strength:            'Fewest message types and phases of any protocol here — the simplest model that is still provably safe under crash faults',
    weakness:            'Crash-fault only: a single lying/equivocating node (not just a crashed one) can violate safety, unlike every BFT protocol here',
  },
  raft: {
    category:            'CFT',
    leaderSelection:     'Round-robin candidate that must win a real majority vote (RequestVote/Grant) to actually lead',
    quorum:              '⌊n/2⌋+1 (majority)',
    phases:              'REQUEST-VOTE → VOTE-GRANT, then APPEND → APPEND-ACK',
    messageComplexity:   'O(n) per slot',
    crossViewSafety:     'Log-comparison voting gate: a voter refuses to grant its vote to a candidate whose log is not at least as up-to-date as its own',
    faultsHandled:       ['SILENT', 'DELAY'],
    distinguishingTrait: 'The only protocol here where leadership must be won, not just assigned — a round-robin-scheduled but stale candidate can be rejected by better-informed voters',
    strength:            'Election safety is legible per-vote — you can point at exactly which voter refused and why, rather than it only emerging after the fact from a value-adoption rule like Paxos',
    weakness:            'Same crash-fault-only ceiling as Paxos, plus an extra log-index/term pair to carry on every vote message that Paxos does not need',
  },
}
