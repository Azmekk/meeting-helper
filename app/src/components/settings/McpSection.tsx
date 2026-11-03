// Settings → MCP: use Claude Code or Codex to chat about meetings, on that
// tool's own plan. Shows what's connected and explains what it means.
import { Check, Copy, FlaskConical, Plug, RefreshCw, SquareTerminal, Unplug } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { connectMcp, disconnectMcp, getMcpStatus, mcpConnectCommand, openMcpTerminal, testMcp, type McpClient, type McpStatus } from '../../lib/mcp';
import { useSettings } from '../../lib/settings';
import { Badge, Button, Callout, Card, IconButton, SettingRow, Spinner, Switch, errorMessage, toast } from '../ui';
import { ExtLink, saveSettings } from './common';

const CLIENTS: { id: McpClient; name: string; plan: string; install: string }[] = [
  { id: 'claude', name: 'Claude Code', plan: 'your Claude plan', install: 'https://code.claude.com/docs/en/overview' },
  { id: 'codex', name: 'Codex', plan: 'your ChatGPT plan', install: 'https://developers.openai.com/codex' },
];

export function McpSection() {
  const allowWrites = useSettings((s) => s.settings.mcpAllowWrites);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setStatus(await getMcpStatus());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const tools = await testMcp();
      setTestResult({ ok: true, message: `The server works and offers ${tools} tools.` });
    } catch (err) {
      setTestResult({ ok: false, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <Card
        title="Chat from Claude Code or Codex"
        description="Connect a coding assistant you already use, then ask about your meetings there. It uses that tool's plan rather than your API keys."
      >
        <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-muted">
          <li>Install Claude Code or Codex, and sign in with your plan.</li>
          <li>Press Connect below. That adds this app to the tool's list of MCP servers, once.</li>
          <li>Open the tool and ask, for example: “What did I commit to in my last meeting?”</li>
        </ol>
        <p className="mt-3 text-[13px] text-muted">
          MCP is how these tools reach outside data. The connection runs on this computer and works while this app is closed.
        </p>
      </Card>

      <Card
        title="Connections"
        actions={
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={checking} onClick={() => void refresh()}>
            Check again
          </Button>
        }
        padded={false}
      >
        {error && (
          <Callout tone="error" className="mx-5 mt-4">
            <p className="break-words">{error}</p>
          </Callout>
        )}
        {!status && checking ? (
          <div className="flex items-center gap-2 px-5 py-6 text-[13px] text-muted">
            <Spinner size={14} /> Looking for Claude Code and Codex…
          </div>
        ) : (
          status && (
            <ul className="divide-y divide-line">
              {CLIENTS.map((c) => (
                <ClientRow key={c.id} client={c} status={status} onChanged={refresh} />
              ))}
            </ul>
          )
        )}
      </Card>

      <Card title="Check the server" description="Starts it the way Claude Code or Codex would, and reads your folders. No AI is involved and nothing is sent anywhere.">
        <Button size="sm" variant="secondary" icon={FlaskConical} loading={testing} onClick={() => void test()}>
          Test the server
        </Button>
        {testResult && (
          <Callout tone={testResult.ok ? 'success' : 'error'} className="mt-3">
            <p className="break-words">{testResult.message}</p>
          </Callout>
        )}
      </Card>

      <Card title="What the assistant can do">
        <div className="divide-y divide-line border-b border-line">
          <SettingRow
            title="Allow task changes"
            description="Lets the assistant add tasks and subtasks, reword them and mark them completed, usually after asking you. It can't delete anything."
          >
            <Switch label="Allow task changes" checked={allowWrites} onChange={(v) => void saveSettings({ mcpAllowWrites: v })} />
          </SettingRow>
        </div>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li>It can read folders, meeting lists, summaries, transcripts and tasks. API keys and recordings stay out of reach.</li>
          <li>What it reads goes to that tool's provider under that tool's own terms, so check that suits the people in your meetings.</li>
          <li>Long transcripts count against your plan's limits. Answers link to the moment in the meeting; if a link won't click in your terminal, copy it into a browser.</li>
          <li>Live features, like “Help me answer” and the overlay, stay in this app.</li>
        </ul>
      </Card>
    </>
  );
}

function ClientRow({
  client,
  status,
  onChanged,
}: {
  client: (typeof CLIENTS)[number];
  status: McpStatus;
  onChanged: () => Promise<void>;
}) {
  const state = status[client.id];
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await action();
      await onChanged();
      toast(done, 'success');
    } catch (err) {
      toast(`${client.name}: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const command = mcpConnectCommand(client.id, status.serverPath);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast(`Couldn't copy: ${errorMessage(err)}`, 'error');
    }
  };

  return (
    <li className="space-y-2.5 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{client.name}</span>
        {state.connected ? <Badge tone="ok">Connected</Badge> : state.installed ? <Badge tone="neutral">Not connected</Badge> : <Badge tone="warn">Not found</Badge>}
        <span className="flex-1" />
        {state.connected ? (
          <>
            <Button size="sm" variant="secondary" icon={SquareTerminal} onClick={() => openMcpTerminal(client.id).catch((err) => toast(errorMessage(err), 'error'))}>
              Open {client.name}
            </Button>
            <Button size="sm" variant="ghost" icon={Unplug} loading={busy} onClick={() => void run(() => disconnectMcp(client.id), `${client.name} disconnected`)}>
              Remove
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" icon={Plug} loading={busy} disabled={!state.installed} onClick={() => void run(() => connectMcp(client.id), `${client.name} connected`)}>
            Connect
          </Button>
        )}
      </div>
      <p className="text-[13px] text-muted">
        {state.connected ? (
          `Ask about your meetings there. Usage counts against ${client.plan}.`
        ) : state.installed ? (
          `Ready to connect. Usage will count against ${client.plan}.`
        ) : (
          <>
            Install <ExtLink href={client.install}>{client.name}</ExtLink>, then press Check again. Already installed? Run the command below in a terminal.
          </>
        )}
      </p>
      {!state.connected && (
        <div className="flex items-center gap-1 rounded-xl bg-fill py-1 pr-1 pl-3">
          <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
            {command}
          </code>
          <IconButton size="sm" icon={copied ? Check : Copy} label="Copy the command" onClick={() => void copy()} />
        </div>
      )}
    </li>
  );
}
