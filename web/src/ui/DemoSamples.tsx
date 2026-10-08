import { Show } from 'solid-js';
import { createQuery } from '@tanstack/solid-query';
import { Download } from 'lucide-solid';
import { api } from '../lib/api';
import { Card } from './Common';

/**
 * Offers the demo sample folders. The demo accounts route only answers in demo mode, so the card stays hidden everywhere else.
 */
export function DemoSamples() {
  const demo = createQuery(() => ({
    queryKey: ['demo-accounts'],
    queryFn: () => api<unknown>('/api/demo/accounts', { quiet401: true }),
    retry: false,
    staleTime: 5 * 60_000,
  }));
  return (
    <Show when={demo.data}>
      <Card title="Try it with sample folders" class="demo-samples">
        <p>
          The download is a zip file with four made up cases: folders with upper and lower arch subfolders, a case with flat files, a folder named after a patient, and a case with an open trim line.
          The case numbers are fictional and new each time you download. Each folder is named with a made up number, first name and last name, for example 50121 Marc Alonso. The number is ignored and the names are filled in on the cards. The names are optional.
        </p>
        <div class="row">
          <a class="btn" href="/api/demo/sample-cases.zip" download="">
            <Download size={16} aria-hidden="true" /> Download sample folders
          </a>
          <span class="small muted">Then drop the downloaded zip file on the drop area.</span>
        </div>
      </Card>
    </Show>
  );
}
