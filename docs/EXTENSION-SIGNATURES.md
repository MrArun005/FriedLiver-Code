# Extension signatures (FL-18): research and plan

Status: work in progress (2026-10-19). Patch 0040 still turns signature checks off.
`docs/extension-signatures-draft.diff` is the draft change to upstream 1.142.0,
made against the tree with patches 0010-0030 applied. It is not in `patches/` yet.

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

## Recommended approach (implemented in the draft diff)

1. `node/openVsxSignature.ts`: pure node:crypto Ed25519 check. The Open VSX key
   is pinned by its id and never fetched.
   - `valid`: a pinned key signed these bytes.
   - `invalid`: the gallery names a pinned key, but the signature is missing,
     malformed or doesn't match. A CDN attacker can't downgrade this to a prompt.
   - `unknownKey`: anything else.
2. `ExtensionSignatureVerificationService` uses it in place of vsce-sign. The
   downloader passes the gallery's PublicKey asset; a new
   `IGalleryExtensionAssets.publicKey` comes from the file's `source`.
3. `common/extensionSignaturePolicy.ts` `decideSignature(status, required, allowed)`:
   - Success: install.
   - Tampered codes, or a required signature that isn't valid: refuse. No
     override, and the "Install Anyway (Don't Verify)" buttons are removed.
   - NotSigned, unknown key, or the verifier failed: ask.
4. `extensions.verifySignature` goes back to default true. A marketplace that
   requires signatures is checked even when the setting is off or
   `donotVerifySignature` is passed.
5. Prompt: "This extension isn't signed by Open VSX. Install anyway?"
   - Install Anyway adds the id to the new `extensions.allowUnsigned` setting
     (application scope) and reruns the install with the context flag
     `friedliver.allowUnsigned`.
   - The rerun is still verified, so a tampered package is still refused.
   - The CLI prints the same message, which names the setting.
6. The synthesized manifest sets `allPublicRepositorySigned: false` for Open VSX.
   VSIX files installed from disk keep upstream behaviour.

The draft type-checks with upstream's TypeScript 6. A targeted tsc run over the
changed files shows the same 80 pre-existing missing-typings errors on base and
on the draft, and none new.

## Left to do

- Turn the draft into `patches/0040-open-vsx-signatures.patch` (rename the patch)
  and check that all patches apply to 1.142.0.
- Vitest tests (`writePatchedFile`), each with a generated key:
  - valid signature
  - tampered file
  - missing signature with a pinned key id (refuse)
  - unknown key, or the verifier failed (ask)
  - required signature (refuse)
  - the `decideSignature` matrix
- Update SECURITY.md (FL-18 becomes Fixed, plus a new entry), README patch
  table, DEFAULTS.md and BUILD.md.
- build.yml (Linux): `friedliver --install-extension redhat.vscode-yaml --log trace`
  with temporary dirs, and grep for `Extension signature verification result ... Success`.
  This also catches an Open VSX key renewal.
- Run build.yml with workflow_dispatch until green, then open the PR.
