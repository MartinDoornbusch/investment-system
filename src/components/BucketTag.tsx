import { BUCKET_LABEL, BUCKET_DESC, BUCKET_COLOR } from '../lib/defaults'
import type { Bucket } from '../lib/types'

/** Colored bucket label with a plain-English tooltip. Display only — stored values are unchanged. */
export function BucketTag({ bucket, className = '' }: { bucket?: string; className?: string }) {
  if (!bucket) return <span className="text-dim">—</span>
  const label = BUCKET_LABEL[bucket as Bucket] ?? bucket
  const desc = BUCKET_DESC[bucket as Bucket]
  const color = BUCKET_COLOR[bucket] ?? 'text-dim'
  return (
    <span title={desc} className={`font-medium ${color} ${desc ? 'cursor-help' : ''} ${className}`}>{label}</span>
  )
}
