import type { Block, BlockHash, QC, ReplicaId, ViewNumber } from '../../types'

export function nextView(v: ViewNumber): ViewNumber {
  return ((v as number) + 1) as ViewNumber
}

export function leaderForView(view: ViewNumber, n: number): ReplicaId {
  return ((view as number) % n) as ReplicaId
}

export function quorumSize(n: number): number {
  return Math.floor((2 * n) / 3) + 1
}

export function extendsFrom(
  blockchain: readonly Block[],
  blockHash: BlockHash,
  ancestorHash: BlockHash,
): boolean {
  if (blockHash === ancestorHash) return true
  let cur = blockchain.find(b => b.hash === blockHash)
  while (cur !== undefined) {
    if (cur.hash === ancestorHash) return true
    if (cur.parentHash === null) return false
    const parent = cur.parentHash
    cur = blockchain.find(b => b.hash === parent)
  }
  return false
}

export function safeBlock(
  block: Block,
  qc: QC,
  lockedQC: QC | null,
  blockchain: readonly Block[],
): boolean {
  if (lockedQC === null) {
    return extendsFrom(blockchain, block.hash, qc.blockHash)
  }
  return (
    (qc.view as number) > (lockedQC.view as number) ||
    extendsFrom(blockchain, block.hash, lockedQC.blockHash)
  )
}
