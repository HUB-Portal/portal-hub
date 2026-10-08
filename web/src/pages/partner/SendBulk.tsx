import { For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { CircleAlert, Lock } from 'lucide-solid';
import { api } from '../../lib/api';
import { formatBytes, plural } from '../../lib/format';
import { readDrop, readFileList } from '../../lib/intake';
import { useAuth } from '../../lib/auth';
import { useCaseCounts, useProfile, useUserCaseAddress } from '../../lib/orgApi';
import type { Row } from '../../lib/bulkRows';
import { fileSummary, type MapFile } from '../../lib/review';
import type { OrgInfo } from '../../lib/types';
import { analyseRow, createBulkUploader } from '../../lib/useBulkUploader';
import { BulkCaseCard, type CardActions } from '../../ui/BulkCaseCard';
import { Notice, PageHeader, Spinner } from '../../ui/Common';
import { DemoSamples } from '../../ui/DemoSamples';
import { DropZone, PageDropOverlay, usePageDrop } from '../../ui/DropZone';
import { SendBar } from '../../ui/SendBar';

/** Why sending is blocked for this person, as notices at the top of the page. Nothing here starts or stops work. */
function BlockedNotices(props: { locked: boolean; needsAddress: boolean; canEditCompany: boolean }) {
  return (
    <>
      <Show when={props.locked}>
        <Notice tone="warn" title="Sending is locked for now" action={<A class="btn btn-sm" href="/portal/getting-started">See what is left to do</A>}>
          <Lock size={14} aria-hidden="true" /> K Line needs to approve your account first. You can check your folders here, but the cases cannot be uploaded yet.
        </Notice>
      </Show>
      <Show when={props.needsAddress}>
        <Notice tone="warn" title="Add your case address first" action={<A class="btn btn-sm" href="/portal/account#case-address">Open case address</A>}>
          K Line needs to know where to send your cases back to. Add a case address of your own in your account{props.canEditCompany ? ', or one for the whole company in the company profile' : ', or ask an administrator to add the company address'}, then come back. You can check your folders here, but the cases cannot be uploaded until an address is saved.
        </Notice>
      </Show>
    </>
  );
}

/**
 * Direct manufacturing. The drop zone is the first thing on the page and stays pinned there; every drop adds cards that start uploading at once,
 * and the partner sends the uploaded cases with one button. The work is in createBulkUploader, the look of a card in BulkCaseCard.
 */
export default function SendBulk() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const org = createQuery(() => ({ queryKey: ['org'], queryFn: () => api<OrgInfo>('/api/org'), retry: false }));
  const profile = useProfile();
  const myAddress = useUserCaseAddress();
  const counts = useCaseCounts(() => true);

  const refreshLists = () => {
    void qc.invalidateQueries({ queryKey: ['cases'] });
    void qc.invalidateQueries({ queryKey: ['case-counts'] });
  };

  // Direct manufacturing needs a case address: the sender's own when complete, otherwise the company's.
  const addressMissing = () => (myAddress.data ? myAddress.data.effective === 'none' : profile.data?.caseAddressComplete === false);
  const uploadsLocked = () => (org.data ? !org.data.uploadsUnlocked : false);
  const uploader = createBulkUploader({ blocked: uploadsLocked, onChanged: refreshLists });
  const locked = () => uploader.locked || uploadsLocked();
  const needsAddress = () => uploader.addressRefused || addressMissing();
  const blocked = () => locked() || needsAddress();

  const dragging = usePageDrop((snap) => { void uploader.ingest(readDrop(snap)); });
  const hasRows = () => uploader.rows.length > 0;
  const totals = () => uploader.rows.reduce((t, r) => { const s = fileSummary(r.files); return { files: t.files + s.fileCount, bytes: t.bytes + s.bytes }; }, { files: 0, bytes: 0 });
  const guessed = () => uploader.rows.some((r) => r.guessed && !r.caseUuid);
  const actions: CardActions = { edit: uploader.edit, changeFiles: (key: string, files: MapFile[]) => uploader.patch(key, { files }), retry: uploader.retry, remove: (r: Row) => { void uploader.remove(r); } };

  return (
    <div class="page">
      <PageDropOverlay show={dragging()} />
      <PageHeader
        title="Direct manufacturing"
        subtitle="This is how you send cases to K Line. Drop a zip file or a folder with one folder per case, as often as you like. Every drop adds to the list and starts uploading at once. The patient ID and the names are optional."
        actions={counts.data && counts.data.attention > 0 ? <A class="btn btn-sm" href="/portal/cases?status=attention"><CircleAlert size={14} aria-hidden="true" /> {plural(counts.data.attention, 'case')} {counts.data.attention === 1 ? 'needs' : 'need'} attention</A> : undefined}
      />
      <BlockedNotices locked={locked()} needsAddress={needsAddress()} canEditCompany={can('org.edit')} />

      {/* Always the first thing on the page: full size while the list is empty, a single pinned row once cases are listed. */}
      <DropZone
        title={hasRows() ? 'Drop more case folders or zip files anywhere on this page' : 'Drop your zip file or folder here'}
        compact={hasRows()}
        pinned
        active={dragging()}
        onList={(l) => { void uploader.ingest(readFileList(l)); }}
      >
        {hasRows() ? 'New cases are added below and start uploading at once.' : 'Each case folder holds its models, trim lines and documents. You can drop again at any time. Every drop adds to the list.'}
      </DropZone>

      <Show when={!hasRows()}><DemoSamples /></Show>
      <Show when={uploader.reading > 0}><Spinner label="Reading your files" /></Show>
      <For each={uploader.notes}>{(n) => <Notice tone="warn">{n}</Notice>}</For>

      <Show when={hasRows()}>
        <div class="stack">
          <Show when={guessed()}>
            <Notice tone="info" title="Check the names">
              Where a folder name could not be split into first and last name with certainty, we made a guess. Change a name in its card if it is wrong, or use Swap names. You can also leave a name empty.
            </Notice>
          </Show>
          <div class="row" style={{ 'justify-content': 'space-between' }}>
            <h2>{plural(uploader.rows.length, 'case')}</h2>
            <span class="small muted">{plural(totals().files, 'file')}, {formatBytes(totals().bytes)}{uploader.finished ? `, ${uploader.finished} sent` : ''}</span>
          </div>
          <For each={uploader.rows}>
            {(r, i) => <BulkCaseCard row={r} analysis={uploader.analysis[i()] ?? analyseRow(r)} index={i()} blocked={blocked()} actions={actions} />}
          </For>
        </div>
      </Show>

      <Show when={hasRows()}>
        <SendBar
          ready={uploader.ready.length}
          sendable={uploader.sendable.length}
          withWarnings={uploader.ready.filter((r) => r.serverWarnings).length}
          ack={uploader.ack}
          onAck={uploader.setAck}
          working={uploader.working}
          allSent={uploader.finished === uploader.rows.length}
          blocked={blocked()}
          onSend={() => { void uploader.sendAll(); }}
        />
      </Show>
    </div>
  );
}
