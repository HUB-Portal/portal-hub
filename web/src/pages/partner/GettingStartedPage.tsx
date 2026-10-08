import { PageHeader } from '../../ui/Common';
import { GettingStarted } from '../shared/GettingStarted';

export default function GettingStartedPage() {
  return (
    <div class="page page-narrow">
      <PageHeader title="Getting started" subtitle="How the Portal Hub works, from registering to sending cases." />
      <GettingStarted showChecklist />
    </div>
  );
}
