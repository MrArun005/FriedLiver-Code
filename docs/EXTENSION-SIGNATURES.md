# Extension signatures (FL-18, FL-37)

Patch `0040-open-vsx-signatures` checks every extension installed from Open VSX
against Open VSX's own signature, with the registry key pinned in the app.
`extensions.verifySignature` is on by default again. This page is the research
behind it and how it behaves.

## Findings

- **Open VSX signs every extension itself (registry signing).** It signs the raw
  `.vsix` bytes with one Ed25519 key per registry. The `.sigzip` holds
  `.signature.sig` (64-byte raw signature), `.signature.manifest` (per-file
  SHA-256 digests; not signed) and an empty `.signature.p7s` (only there so VS
  Code's zip check passes). Sources:
  [ExtensionVersionIntegrityService.java](https://github.com/eclipse-openvsx/openvsx/blob/master/server/src/main/java/org/eclipse/openvsx/publish/ExtensionVersionIntegrityService.java),
  [cli/src/verify-signature.ts](https://github.com/eclipse-openvsx/openvsx/blob/master/cli/src/verify-signature.ts)
  ("Open VSX's registries each hold their own Ed25519 key pair").
- **Checked by hand on 2026-10-19:** for redhat.vscode-yaml 2.1.2026101708,
  `crypto.verify(null, vsixBytes, key, sig)` is true over the vsix and false
  over the manifest.
- **Public key:** `https://open-vsx.org/api/-/public-key/14ccb407-4e79-41ed-be5a-6d608325c45a`
  = `MCowBQYDK2VwAyEAje+vAaSS1zHV5WHCJSa5UXvxRo6+yerEU3IEmtuEuF4=` (SPKI, Ed25519).
  Pinned on 2026-10-20 after three checks: the endpoint itself, the Wayback
  Machine's independent copy of 2026-02-18 (same bytes), and a real signature
  (redhat.vscode-yaml 2.1.2026102008 verifies; one flipped byte doesn't).
  Fourteen extensions sampled (2021-2026 versions) all name this one key. The
  gallery query (`/vscode/gallery/extensionquery`) lists it as the
  `Microsoft.VisualStudio.Services.PublicKey` file, next to `VsixSignature`.
- **Key rotation:** `ovsx.integrity.key-pair=renew` makes a new key and re-signs
  everything in the background
  ([doc/configuration.md, Extension Integrity](https://github.com/eclipse-openvsx/openvsx/blob/master/doc/configuration.md)).
  A pinned key therefore needs a FriedLiver update when Open VSX renews.
- **@vscode/vsce-sign** (2.1.0) is under the "Microsoft Software License Terms":
  use is allowed "only with ... Visual Studio Code ... and successor Microsoft
  products". No public source (github.com/microsoft/vsce-sign and
  Microsoft/node-vsce-sign both 404). Forks can't redistribute it.
- **node-ovsx-sign** ([filiptronicek/node-ovsx-sign](https://github.com/filiptronicek/node-ovsx-sign)):
  EPL-2.0, last release 1.2.0 (2024-06). Depends on @vscode/vsce, archiver,
  node-fetch and others. It downloads the public key from the same registry at
  verify time, with no pinning. Its core is one `crypto.verify(null, file, key, sig)`.
  FreeBSD's Code - OSS port swaps it in for vsce-sign
  ([ports commit 040996225cc6](https://reviews-dev.freebsd.org/R11:040996225cc61dac8602ca0b3bf9520f739ff75b)).
- **VSCodium** hard-disables verification
  ([patches/00-extension-disable-signature-verification.patch](https://github.com/VSCodium/vscodium/blob/master/patches/00-extension-disable-signature-verification.patch)).
  I found no signature check in Eclipse Theia.
- **The repository-signature requirement:** upstream builds the gallery manifest
  from product.json and always sets `allPublicRepositorySigned: true`
  (extensionGalleryManifestService.ts). That is Microsoft's statement about its
  own Marketplace. Open VSX publishes no manifest (`/vscode/gallery/manifest.json`
  returns 404). With `true`, upstream refuses or pre-prompts every unsigned
  extension, and with vsce-sign missing it reports "verification not executed".
  That is why patch 0040 turned checks off. A private marketplace can serve a
  real manifest that requires signatures.

## How it works (patch 0040)

1. `node/openVsxSignature.ts`: `checkOpenVsxSignature` is a pure `node:crypto`
   Ed25519 check. The Open VSX key is pinned by its id and never fetched.
   - `Success`: a pinned key signed exactly these bytes.
   - `SignatureIsNotValid`: the gallery names a pinned key, but the signature is
     missing, malformed or doesn't match. A CDN attacker can't downgrade this to
     a prompt, and a gallery entry with no signature asset at all is the same.
   - `NotSigned`: no signature, and no pinned key named.
   - `Untrusted`: a signature no pinned key matches, and no pinned key named.
2. `ExtensionSignatureVerificationService` uses it in place of vsce-sign. The
   downloader passes the gallery's PublicKey asset
   (`IGalleryExtensionAssets.publicKey`, from the file's `source`). A check that
   throws is reported as not executed.
3. `common/extensionSignaturePolicy.ts` `decideSignature(status, required, allowed)`:
   - Success: install.
   - A mismatch, or a required signature that isn't valid: refuse. No override;
     the "Install Anyway (Don't Verify Signature)" buttons are gone.
   - Not signed, unknown key, or the check couldn't run: ask.
4. A marketplace whose manifest requires signatures is checked even when the
   setting is off or `donotVerifySignature` is passed. FriedLiver's synthesized
   manifest for Open VSX sets `allPublicRepositorySigned: false`, since Open VSX
   makes no such promise. Dev builds and linux-armhf are checked too (upstream
   skipped both).
5. The prompt: "This extension isn't signed by Open VSX. Install anyway?"
   - Install Anyway adds the id to `extensions.allowUnsigned` (application
     scope: user settings only, never a workspace) and reruns the install with
     the context flag `friedliver.allowUnsigned`.
   - The rerun is still checked, so a tampered package is still refused.
   - The CLI prints the same refusal, naming the setting.
6. VSIX files installed from disk keep upstream behaviour (no signature check).

## Checks

- `test/extensionSignatures.test.ts` runs both new files from the patch with a
  key generated in the test: valid, tampered, missing (asks), unknown key
  (asks), the check failing (asks), a required signature (refused), the pinned
  key named with the signature missing or broken (refused), and the pinned key
  itself.
- `build.yml` (Linux) installs `redhat.vscode-yaml` from Open VSX into the
  built app with `--log trace` and fails unless the log says the check
  succeeded. This also catches an Open VSX key renewal.

## When Open VSX renews its key

`ovsx.integrity.key-pair=renew` re-signs everything with a new key, and the
gallery names the new id. Until FriedLiver pins it, installs ask (unknown key)
and the build check fails. Add the new id and key to `OPEN_VSX_PUBLIC_KEYS`
after checking it the same three ways, and keep the old one while extensions
signed with it are still served.
