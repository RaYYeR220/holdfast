import { SectionLoading } from '../../_sections/safety/SectionLoading';

/** Shown while the organisation and its keys are read. */
export default function SettingsLoading() {
  return <SectionLoading title="Settings" doing="Reading the organisation, the accounts it is tied to and the keys the service holds for it." parts={['Reading the organisation', 'Reading its accounts', 'Reading its keys']} />;
}
