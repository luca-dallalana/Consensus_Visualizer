import type { Block, BlockHash, QC, Vote, ViewNumber } from '../../types'
import { makeQC } from './factory'

export function collectUncommittedAncestors(
  hash: BlockHash,
  blockchain: readonly Block[],
  committed: readonly BlockHash[],
): BlockHash[] {
  const ancestors: BlockHash[] = []
  let block = blockchain.find(b => b.hash === hash)
  while (block?.parentHash != null) {
    const parentHash = block.parentHash
    if (committed.includes(parentHash)) break
    const parent = blockchain.find(b => b.hash === parentHash)
    if (!parent) break
    ancestors.unshift(parentHash)
    block = parent
  }
  return ancestors
}

export function tryFormQC(votes: readonly Vote[], view: ViewNumber, q: number): QC | null {
  const counts = new Map<string, number>()
  for (const v of votes) counts.set(v.blockHash, (counts.get(v.blockHash) ?? 0) + 1)
  for (const [hash, count] of counts) {
    if (count >= q) {
      const signers = votes
        .filter(v => v.blockHash === hash)
        .slice(0, q)
        .map(v => v.voterId)
      return makeQC(view, hash as BlockHash, signers)
    }
  }
  return null
}
