import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Benchmark Lab · RED Justice',
  description:
    'Controlled benchmark for investigation-reasoning AI models — evidence grounding, entity extraction, temporal reasoning, contradiction detection and more.',
}

export default function BenchmarkLayout({ children }: { children: React.ReactNode }) {
  return children
}
