import { SectionLoading } from '../../_sections/safety/SectionLoading';

/** Shown while the keys' scopes are read from their chains. */
export default function SafetyLoading() {
  return <SectionLoading title="Safety" doing="Reading each key’s scope from its chain: Tempo, Solana and HyperEVM are being asked now." parts={['Reading the keys', 'Reading the refusals on record', 'Reading the latest snapshot']} />;
}
