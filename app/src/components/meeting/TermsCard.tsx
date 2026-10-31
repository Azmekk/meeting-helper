// Vocabulary for one meeting, on top of its folder's and the default list.
// Used by the next transcription; the live transcript has already happened.
import { useEffect, useState } from 'react';
import * as db from '../../lib/db';
import { useSettings } from '../../lib/settings';
import type { Meeting } from '../../lib/types';
import { TermsField } from '../TermsField';
import { Card, errorMessage, toast } from '../ui';

export function TermsCard({ meeting, onSaved }: { meeting: Meeting; onSaved: (terms: string[]) => void }) {
  const defaults = useSettings((s) => s.settings.terms.length);
  const [folderTerms, setFolderTerms] = useState(0);

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

  const inherited = [
    defaults ? `${defaults} default` : '',
    folderTerms ? `${folderTerms} from the folder` : '',
  ].filter(Boolean);
  return (
    <Card
      title="Vocabulary"
      description={`Extra names and terms for transcribing this meeting.${inherited.length ? ` Also uses ${inherited.join(' and ')}.` : ''}`}
    >
      <TermsField terms={meeting.terms} onSave={save} />
    </Card>
  );
}
