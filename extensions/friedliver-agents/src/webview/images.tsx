import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { OutsideImages } from '../shared/gallery';
import { useHost, useNow } from './common';
import { Gallery } from './gallery';

/** The Images view: every image agents read, take or make, and the ones you attach, by chat. */
function Images() {
  const [outside, setOutside] = useState<OutsideImages[]>([]);
  const { state } = useHost((m) => m.type === 'claudeImages' && setOutside(m.sessions));
  const now = useNow(15_000);
  return <Gallery state={state} outside={outside} now={now} />;
}

render(<Images />, document.getElementById('root')!);
