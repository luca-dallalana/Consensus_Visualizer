import type {
  Block, BlockHash, QC, Vote, ReplicaId, ViewNumber,
  ProposalMessage, VoteMessage, NewViewMessage,
} from '../../types'

function djb2(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h, 33) ^ str.charCodeAt(i)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function makeGenesisBlock(): Block {
  return {
    hash:       'genesis-00000000' as BlockHash,
    parentHash: null,
    height:     0,
    view:       (-1) as ViewNumber,
    proposer:   (-1) as ReplicaId,
    payload:    'genesis',
  }
}

export function makeBlock(
  parent: Block,
  view: ViewNumber,
  proposer: ReplicaId,
  payload: string,
): Block {
  const hash = djb2(
    JSON.stringify({ h: parent.height + 1, v: view, p: parent.hash, r: proposer, x: payload }),
  ) as BlockHash
  return { hash, parentHash: parent.hash, height: parent.height + 1, view, proposer, payload }
}

export function makeQC(view: ViewNumber, blockHash: BlockHash, signers: ReplicaId[]): QC {
  return { view, blockHash, signers }
}

export function makeVote(view: ViewNumber, blockHash: BlockHash, voterId: ReplicaId): Vote {
  return { view, blockHash, voterId }
}

export function makeProposalMessage(
  from: ReplicaId,
  view: ViewNumber,
  block: Block,
  highQC: QC,
  sentAtStep: number,
  to: ReplicaId | 'broadcast',
): ProposalMessage {
  const toStr = to === 'broadcast' ? 'bcast' : String(to)
  return {
    id: `msg-PROPOSAL-${view as number}-${from as number}-${toStr}-${sentAtStep}`,
    type: 'PROPOSAL',
    from, to, view, sentAtStep, block, highQC,
  }
}

export function makeVoteMessage(
  from: ReplicaId,
  to: ReplicaId,
  vote: Vote,
  sentAtStep: number,
): VoteMessage {
  return {
    id: `msg-VOTE-${vote.view as number}-${from as number}-${vote.blockHash}-${sentAtStep}`,
    type: 'VOTE',
    from, to, view: vote.view, sentAtStep, vote,
  }
}

export function makeNewViewMessage(
  from: ReplicaId,
  to: ReplicaId,
  view: ViewNumber,
  highQC: QC,
  sentAtStep: number,
): NewViewMessage {
  return {
    id: `msg-NEW_VIEW-${view as number}-${from as number}-${sentAtStep}`,
    type: 'NEW_VIEW',
    from, to, view, sentAtStep, highQC,
  }
}
