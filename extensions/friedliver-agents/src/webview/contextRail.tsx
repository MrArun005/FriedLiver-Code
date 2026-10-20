// The context rail (COMPONENTS.md v2 §2.34): the right column of a wide chat page. Who, when, what it
// cost in money (tokens beneath), how long, the files changed and read, and the Rewind points. Facts come
// from shared/contextFacts.ts, the one source; rows open the file or rewind to the point.
import type { ChatView } from '../shared/model';
import { chatFacts } from '../shared/contextFacts';
import { AGENT_FACES } from '../shared/model';
import { basename, send, useNow } from './common';
import { Avatar, Count, Icon, Row } from './ui';

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function FileRows({ chat, files }: { chat: ChatView; files: string[] }) {
  return (
    <>
      {files.slice(0, 8).map((f) => {
        const name = basename(f);
        const dir = f.slice(0, Math.max(0, f.length - name.length - 1));
        return (
          <Row key={f} icon="code" title={f} onPress={() => send({ type: 'openFile', path: f.startsWith('/') ? f : `${chat.cwd}/${f}` })} meta={dir || undefined}>
            {name}
          </Row>
        );
      })}
      {files.length > 8 && <div class="ctx-more">and {files.length - 8} more</div>}
    </>
  );
}

export function ContextRail({ chat }: { chat: ChatView }) {
  const now = useNow(chat.busy ? 1000 : 60_000);
  const f = chatFacts(chat, now);
  return (
    <aside class="ctx-rail" aria-label="This chat">
      <section>
        <h3>This chat</h3>
        <div class="ctx-facts">
          <div>
            <div class="ctx-l">Agent</div>
            <div class="ctx-v">
              <Avatar agent={chat.agent} size="sm" working={chat.busy} />
              {AGENT_FACES[chat.agent].name}
            </div>
          </div>
          <div>
            <div class="ctx-l">Started</div>
            <div class="ctx-v">{clock(f.started)}</div>
          </div>
          <div>
            <div class="ctx-l">Cost</div>
            <div class="ctx-v">{f.cost ?? '—'}</div>
            {f.tokens && <div class="ctx-l">{f.tokens}</div>}
          </div>
          <div>
            <div class="ctx-l">Time</div>
            <div class="ctx-v">{f.time}</div>
          </div>
        </div>
      </section>
      {/* "In this chat" (your messages, to jump to) draws here from the transcript. */}
      <section id="ctx-jump" class="ctx-jump" />
      {f.changed.length > 0 && (
        <section>
          <h3>
            Files changed <Count n={f.changed.length} />
          </h3>
          <FileRows chat={chat} files={f.changed} />
        </section>
      )}
      {f.read.length > 0 && (
        <section>
          <h3>
            Files read <Count n={f.read.length} />
          </h3>
          <FileRows chat={chat} files={f.read} />
        </section>
      )}
      {f.rewind.length > 0 && (
        <section>
          <h3>Rewind points</h3>
          {f.rewind.slice(0, 6).map((r) => (
            <Row key={r.checkpoint} icon="history" title="Rewind to here" meta={r.at ? clock(r.at) : undefined} onPress={() => send({ type: 'rewind', chatId: chat.id, turnId: r.checkpoint })}>
              {r.label}
            </Row>
          ))}
        </section>
      )}
      {f.changed.length === 0 && f.read.length === 0 && (
        <p class="ctx-empty">
          <Icon name="files" size={14} /> Files the agent reads and changes show here as it works.
        </p>
      )}
    </aside>
  );
}
