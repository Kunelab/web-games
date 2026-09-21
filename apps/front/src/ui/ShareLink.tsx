import { msg } from 'i18n';
import { useEffect, useRef, useState } from 'react';

import { useT } from '../i18n/locale-context';
import { Button } from '../ui';

/**
 * The join link, and the two ways a room actually passes it around.
 *
 * The screens that open a game print the code, the URL and a QR code, which
 * covers the case where everybody is in front of the television. Half of the
 * time they are not: the link goes into the group chat, and the only way to get
 * it there was to read it off the screen and type it back in by hand. So the
 * URL is now a button.
 *
 * Two behaviours behind one press, chosen by what the device has. A phone gets
 * the system share sheet, which is the thing that reaches WhatsApp in one tap.
 * Everything else gets the clipboard, which is what a laptop wanted anyway.
 *
 * `navigator.share` exists only over HTTPS and only on some platforms, and
 * `clipboard.writeText` needs a secure context too — so a plain-HTTP box on a
 * home network, which is exactly how this is often run, reaches neither. It
 * falls back to selecting the text, which at least turns typing into a copy.
 */
/**
 * Whether this browser has a share sheet at all.
 *
 * Asked as a `typeof`, not as `if (navigator.share)`: the DOM typings declare
 * the method as always present, so the truthiness check reads to TypeScript as
 * dead code even though it is exactly the check this needs — the method is
 * genuinely absent on desktop Firefox and over plain HTTP.
 */
function hasShareSheet(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export function ShareLink({ url, title }: { url: string; title?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const textRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The confirmation is a timer, so it must not outlive the screen that set it.
  useEffect(() => () => void (timer.current !== null && clearTimeout(timer.current)), []);

  function confirm() {
    setDone(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 2000);
  }

  async function share() {
    if (hasShareSheet()) {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        // Dismissing the sheet rejects, which is not a failure and must not
        // fall through to a clipboard write the player did not ask for.
        return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      confirm();
      return;
    } catch {
      // Insecure context, or permission refused.
    }

    // Last resort: put the link under the cursor so one keystroke finishes it.
    const node = textRef.current;
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  return (
    <div className="share-link">
      <span className="join-url" ref={textRef}>
        {url}
      </span>
      <Button variant="ghost" size="sm" onClick={() => void share()}>
        {t(msg(done ? 'share.copied' : hasShareSheet() ? 'share.send' : 'share.copy'))}
      </Button>
    </div>
  );
}
