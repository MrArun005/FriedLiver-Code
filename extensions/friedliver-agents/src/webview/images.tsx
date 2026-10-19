import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { ImageStoreInfo, OutsideImages } from '../shared/gallery';
import { useHost, useNow } from './common';
import { Gallery } from './gallery';

/** The Images view: every image agents read, take or make, and the ones you attach, by chat. */
function Images() {
  const [outside, setOutside] = useState<OutsideImages[]>([]);
  const [store, setStore] = useState<ImageStoreInfo>();
  const { state } = useHost((m) => {
    if (m.type === 'claudeImages') setOutside(m.sessions);
    if (m.type === 'imageStore') setStore(m.store);
  });
  const now = useNow(15_000);
  return <Gallery state={state} outside={outside} now={now} store={store} />;
}

render(<Images />, document.getElementById('root')!);
