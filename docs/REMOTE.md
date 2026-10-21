# FriedLiver Remote

Control FriedLiver's agents from your phone: see every chat grouped by status
(Needs you, Working, Problem, Idle, Done), read the transcript, send a message,
answer questions and approvals, stop a turn, start a chat, and watch subagents.
It works with any agent and any account FriedLiver runs. It doesn't depend on
Anthropic's Remote Control, and no relay or cloud service is involved: your
phone talks to the FriedLiver window on your Mac.

It is off by default. Only your own user settings can turn it on, never a
workspace's.

## Phase 1: on the same Wi-Fi

1. In FriedLiver, run **FriedLiver: Remote Control…** from the Command
   Palette. The first time, it asks you to turn on
   `friedliver.remote.enabled`.
2. A panel opens with a QR code.
   - The code works **once**, for **2 minutes**. **New code** shows another.
   - The panel also shows the address and the SHA-256 fingerprint of the
     server's certificate.
3. Scan the QR code with your phone's camera and open the link.
4. Your phone's browser warns that the certificate isn't trusted. It is a
   self-signed certificate, made once for this install, and its key never
   leaves your Mac.
   - **Before continuing**, open the certificate details (iOS Safari: *Show
     Details* → *view the certificate*; Android Chrome: tap the warning →
     *Advanced*, then the certificate).
   - Check that the SHA-256 fingerprint matches the one on the panel.
   - If it doesn't match, don't continue.
5. Name the phone and tap **Pair**. Your Mac asks whether to allow it. Allow it
   only if it is yours.
6. Optional: add the page to your home screen (Share → *Add to Home Screen*) so
   it opens like an app.

While Remote is on, the status bar shows **Remote · N devices** (the phones
connected now). Click it to open the panel again. A notification tells you the
first time each phone uses Remote in a session.

**Stop Remote** in the panel, or **FriedLiver: Stop Remote Control**, closes the
server. It also stops by itself when your Mac changes networks. Remote doesn't
start again after a restart until you run the command.

### What a phone can and can't do

- **It can:** read chats and their transcripts; send messages; stop a turn;
  start a chat (agent and folder from this window's folders); answer questions;
  allow or deny commands, edits and agent requests; switch a chat's approval
  level back to Manual.
- **It needs your OK on the Mac** for anything that keeps allowing:
  - **Auto** and **Edits** (Edit automatically on the Mac);
  - every **Always allow**;
  - an agent's own "don't ask again" / "for this session" answers;
  - "For this chat" on an agent request.

  The Mac shows a notification naming the phone. No answer within 2 minutes
  means no. Revoking the phone answers no to anything still waiting.
- **Commands the phone can't show whole and plainly** (over 4,000 characters,
  or containing control, bidi or zero-width characters, which the phone
  spells out as ⟨U+202E⟩ etc.) can only be denied on the phone. Approve them on
  the Mac.
- **Slash commands** (a message starting with `/`, also after an `@agent`
  mention):
  - Information-only ones go straight through: `/help`, `/cost`, `/status`,
    `/usage`, `/context`, `/about`, `/stats`.
  - Ones that change permissions, approvals, modes or settings are refused
    from the phone; run them on the Mac. Examples: `/permissions`,
    `/allowed-tools`, `/config`, `/approvals`, `/mode`, `/yolo`, `/settings`,
    `/plan`, and anything starting with `dangerously` or `bypass`.
  - Every other command, listed by the agent or not (`/clear`, `/compact`,
    `/model`, `/init`…), is sent only after the Mac's OK, which names the
    phone and the command.
- **It can't:** change a chat's model or mode; approve a plan's mode switch
  without the Mac; open files; run anything in a terminal; see inline edits;
  read your settings or keys.
- Approval levels a phone sets never become the default for new chats.

### Paired devices

The panel lists paired phones with when each was last seen. **Revoke** stops a
phone's token at once and closes its connection, in every FriedLiver window.
**Revoke all** does that for every phone. A phone unused for 30 days is
forgotten. On the phone, **⋯ → Forget this phone** unpairs it.

## Phase 2: from anywhere, with Tailscale

[Tailscale](https://tailscale.com) puts your Mac and phone on a private
WireGuard network (your tailnet). FriedLiver Remote then listens on your Mac's
Tailscale address as well, and nothing is exposed to the internet.

1. Install Tailscale on your Mac (from tailscale.com or the Mac App Store) and
   sign in.
2. Install Tailscale on your phone (App Store or Google Play) and sign in to
   the same tailnet.
3. Optional, recommended: in the Tailscale admin console, under **DNS**, turn on
   **MagicDNS** and **HTTPS Certificates**. FriedLiver then gets a real
   certificate for your Mac's name (`tailscale cert`), so the phone's browser
   trusts it with no warning, and no fingerprint check is needed. Note that
   Tailscale publishes certificate names (like `your-mac.your-tailnet.ts.net`)
   in public Certificate Transparency logs.
4. In the Remote panel, click **Allow over Tailscale** (setting
   `friedliver.remote.tailscale`).
5. Choose **Tailscale** above the QR code and pair the phone with that code.
   - A phone paired through the Wi-Fi address has to pair again for Tailscale:
     each address is its own origin in the browser.
   - The Tailscale address works at home too.

How FriedLiver uses Tailscale:

- FriedLiver finds Tailscale only at its install locations:
  - `/Applications/Tailscale.app/Contents/MacOS/Tailscale`
  - `/opt/homebrew/bin/tailscale`
  - `/usr/local/bin/tailscale`
  - `/usr/bin/tailscale` (Linux)
- It never uses one found on `PATH` or in a workspace.
- It runs `tailscale status --json` and listens on your Mac's 100.x address
  only if Tailscale is running, logged in, and that address is on one of your
  Mac's interfaces.

## Settings

| Setting | Default | |
|---|---|---|
| `friedliver.remote.enabled` | `false` | Lets **Remote Control…** start the server. Turning it off stops it. |
| `friedliver.remote.tailscale` | `false` | Also listen on the Tailscale address. |

Both are `application` scope: a workspace's `.vscode/settings.json` can't set
them.

## Troubleshooting

- **"This Mac has no private network address."** Join a Wi-Fi network, or allow
  Tailscale. VPN tunnels and VM or container bridges are never used.
- **The phone can't connect.** Make sure both are on the same Wi-Fi, and that
  it isn't a guest network that isolates clients. The address in the panel must
  be reachable from the phone.
- **"Too many failed attempts."** Five bad codes or tokens from one address in a
  minute lock it out for five minutes.
- **It keeps asking to pair.** The pairing is stored in the browser for that
  address. Private browsing, clearing site data, or a new address (another
  network, or Tailscale vs Wi-Fi) needs a new pairing.
- **What needs a real phone to check:** camera QR scanning, the certificate
  warning and its fingerprint view, Add to Home Screen, the keyboard covering
  the composer, and reconnecting after the phone sleeps. The harness
  (`node scripts/remote-harness.mjs`) only screenshots the pages at 390×844.

See SECURITY.md, "FriedLiver Remote", for the threat model.
