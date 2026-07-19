export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s += 0x6D2B79F5
    let z = s
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000
  }
}

export function stepRng(seed: number, stepIndex: number): () => number {
  return mulberry32((seed ^ (stepIndex * 0x9E3779B9)) >>> 0)
}
