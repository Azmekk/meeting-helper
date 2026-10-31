// Transcription options for one meeting, used by the next transcription (the
// live transcript has already happened): who was at the desk, and vocabulary
// on top of the folder's and the default list.
import { useEffect, useState } from 'react';
import * as db from '../../lib/db';
import { emitMeetingChanged } from '../../lib/pipeline';
import { useSettings } from '../../lib/settings';
import type { Meeting } from '../../lib/types';
import { TermsField } from '../TermsField';
import { Card, Switch, errorMessage, toast } from '../ui';

export function TermsCard({ meeting, onSaved }: { meeting: Meeting; onSaved: (terms: string[]) => void }) {
  const defaults = useSettings((s) => s.settings.terms.length);
  const splitDefault = useSettings((s) => s.settings.splitTracks);
  const [folderTerms, setFolderTerms] = useState(0);
  // Mic transcribed on its own = "you"; off when someone else sat at the desk.
  const othersInRoom = !(meeting.splitTracks ?? splitDefault);

  useEffect(() => {
    let alive = true;
    if (meeting.folderId == null) setFolderTerms(0);
    else void db.getFolder(meeting.folderId).then((f) => alive && setFolderTerms(f?.terms.length ?? 0));
    return () => {
      alive = false;
    };
  }, [meeting.folderId]);

  const save = async (terms: string[]) => {
    try {
      await db.updateMeeting(meeting.id, { terms });
      onSaved(terms);
    } catch (err) {
      toast(`Couldn't save the vocabulary: ${errorMessage(err)}`, 'error');
    }
  };

  const setOthersInRoom = async (on: boolean) => {
    try {
      await db.updateMeeting(meeting.id, { splitTracks: !on });
      emitMeetingChanged(meeting.id);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const inherited = [
    defaults ? `${defaults} default` : '',
    folderTerms ? `${folderTerms} from the folder` : '',
  ].filter(Boolean);
  return (
    <Card title="Transcription" description="Used the next time this meeting is transcribed.">
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Someone was here with me</div>
            <p className="text-xs text-muted">
              Transcribes everyone together, so a person next to you isn’t labelled as you.
            </p>
          </div>
          <Switch label="Someone was here with me" checked={othersInRoom} onChange={(v) => void setOthersInRoom(v)} />
        </div>
        <div className="space-y-1.5">
          <div className="text-[13px] font-medium">Vocabulary</div>
          <p className="text-xs text-muted">
            Extra names and terms.{inherited.length ? ` Also uses ${inherited.join(' and ')}.` : ''}
          </p>
          <TermsField terms={meeting.terms} onSave={save} />
        </div>
      </div>
    </Card>
  );
}
