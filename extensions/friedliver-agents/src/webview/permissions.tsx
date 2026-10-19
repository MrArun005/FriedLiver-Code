import { render } from 'preact';
import { useState } from 'preact/hooks';
import { describeGrant, type Remembered } from '../shared/permissions';
import { send, useHost } from './common';
import { Button } from './ui';

const GROUPS: { title: string; hint: string; kinds: Remembered['grant']['kind'][] }[] = [
  { title: 'Websites', hint: 'Agents open, click and type on these sites in FriedLiver’s browser without asking. Exact origin only.', kinds: ['site'] },
  { title: 'Folders', hint: 'Agents read or change files here and below without asking, in this workspace.', kinds: ['folder'] },
  { title: 'Commands', hint: 'Agents run these without asking, in this workspace. Chained or redirected lines still ask.', kinds: ['exact', 'prefix'] },
  { title: 'Agent tools', hint: 'Agents reach other agents and chats, or add to project memory, without asking.', kinds: ['tool'] },
  { title: 'Mac & Windows control', hint: 'Agents do these on your computer without asking, for exactly this app, site, file or Shortcut. The clipboard, screenshots and terminals always ask.', kinds: ['system'] },
];

function when(at?: number): string {
  return at ? new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'before this list kept dates';
}

/** Every remembered "Always allow", what it covers and who asked for it, with Revoke and Revoke all. */
function Permissions() {
  const [rules, setRules] = useState<Remembered[] | undefined>();
  useHost((m) => m.type === 'permissions' && setRules(m.rules));
  if (!rules) return null;
  return (
    <main class="perms">
      <header class="perms-head">
        <div>
          <h1>Permissions</h1>
          <p class="hint">
            What you chose “Always allow” for. It holds in every chat and after restarts, for Claude, Codex, Gemini and Claude Code outside FriedLiver. Full auto,
            read-only chats and inline edits work as before; keys, credentials and system folders are never always allowed.
          </p>
        </div>
        <Button variant="quiet-danger" size="sm" disabled={!rules.length} onClick={() => send({ type: 'revokeAllPermissions' })}>
          Revoke all
        </Button>
      </header>
      {!rules.length && <div class="empty">Nothing is always allowed. Choose “Always allow” on an approval to stop it asking again.</div>}
      {GROUPS.map((g) => {
        const list = rules.filter((r) => g.kinds.includes(r.grant.kind));
        if (!list.length) return null;
        return (
          <section key={g.title} class="perms-group" aria-label={g.title}>
            <h2>
              {g.title} <span class="count">{list.length}</span>
            </h2>
            <p class="hint">{g.hint}</p>
            <table>
              <thead>
                <tr>
                  <th>Allows</th>
                  <th>Where</th>
                  <th>Since</th>
                  <th>Asked by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const d = describeGrant(r.grant);
                  return (
                    <tr key={r.id}>
                      <td>{d.what}</td>
                      <td class="mono scope" title={d.scope}>
                        {d.scope}
                        {r.grant.kind === 'folder' && <span class="hint"> and below</span>}
                      </td>
                      <td class="hint">{when(r.at)}</td>
                      <td>{r.agent ?? <span class="hint">—</span>}</td>
                      <td class="act">
                        <Button size="sm" onClick={() => send({ type: 'revokePermission', id: r.id })}>
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </main>
  );
}

render(<Permissions />, document.getElementById('root')!);
